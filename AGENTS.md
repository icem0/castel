# AGENTS

Regeln für alle Coding-Agents und Entwickler, die an diesem Projekt arbeiten.

## Architektur

- **Web-App / PWA** – läuft im Browser, installierbar, offline-fähig.
- **Offline-first** – die App funktioniert ohne Netzverbindung. Änderungen werden lokal in der Outbox gepuffert und bei vorhandener Verbindung mit der API synchronisiert.
- **Lokale Datenbank im Browser (Cache)** – die PWA persistiert eine vollständige Arbeitskopie lokal (IndexedDB via Dexie). Source of Truth ist die API (Fastify + PostgreSQL); der Client gilt als flüchtig und wird beim Sync überschrieben.

## Datenmodell

- **Bestand ist die Summe von Buchungen.** Es gibt keine überschreibenden Mengenupdates.
- Jede Buchung hat eine **UUID** (kein auto-increment, keine laufende Nummer) und einen Zeitstempel.
- Buchungen sind unveränderlich. Korrekturen erfolgen durch Storno- oder Gegenbuchungen.
- **Mindestbestand gilt je (Artikel, Standort)** — nicht mehr global pro Artikel. Die Konfiguration liegt in `artikel_standort_mindestbestaende` (PK = `(artikel_id, standort_id)`, LWW auf `geaendert_am`, Migration `0020`).
  - **Sparse**: eine Zeile existiert nur für einen *positiven* Wert. `0` bzw. ein leeres Feld = „kein Mindestbestand" (kein Alarm) und löscht die Zeile (Outbox-`delete`).
  - **Kein globaler Fallback**: `artikel.mindestbestand` ist deprecated und wird **nicht** ausgewertet. Der Server-Backfill (Migration 0020) und der lokale Dexie-Upgrade (v15) wandern bestehende globale Werte ins Hauptlager (aktiver Standard-Standort).
  - **Identität ist das Paar** (`artikelId#standortId`), keine eigene UUID — analog `einstellung` (`key#userId`). `entitaetIdFor` (Server) und `payloadIdFor` (PWA) bilden denselben String.
  - **Der Standard-Standort (Hauptlager) ist geschützt**: weder löschbar noch archivierbar (`PROTECTED_STANDORT`, DB-seitig geprüft).
  - Ein gelöschter Artikel/Standort nimmt seine Konfigurationen per `ON DELETE CASCADE` mit — das Löschen wird dadurch nicht blockiert (Buchungen und Mindestbestand-Ereignisse tun das weiterhin).

### Standort: Löschen vs. Umbenennen/Archivieren

- **Löschen** ist nur möglich, solange keine Zeile auf den Standort verweist. Der Server prüft `buchungen.standort_id`, `buchungen.standort_ziel_id` und `mindestbestand_ereignisse.standort_id` und wirft sonst `HAS_DEPENDENCIES` (HTTP 409). Der Client legt ein solches `delete` in die Quarantäne (`HARD_QUARANTINE_CODES`) — der User sieht erst beim Sync, dass es nicht geklappt hat.
- **Umbenennen und Archivieren laufen über `op: 'update'`** und sind daher **immer** erlaubt — der Resolver prüft beim Update keine Abhängigkeiten. Der Server wertet `update` per LWW auf `geaendert_am` aus.
- **Der Client prüft das Löschen vorab** (`referenzierteBuchungen` im Store, `StandortHatBuchungenError`): Sind lokal Buchungen vorhanden, die auf den Standort zeigen, wird gar kein `delete` in die Outbox geschrieben, sondern eine klare Meldung mit Verweis auf Umbenennen/Archivieren angezeigt. Grund: Buchungen sind append-only — eine lokal vorhandene Buchung existiert auch auf dem Server, der lokale Zähler ist also eine verlässliche Untergrenze für die Server-Prüfung.
- **Konsequenz für Server-Tools:** Wer Buchungen direkt in der DB löscht, erzeugt auf den Clients **Geister-Buchungen**. `reconcileBookings` markiert fehlende Buchungen nur als `nichtGespeichert` / `SERVER_MISSING` und löscht sie **nie**; der lokale Bestand (Summe der Buchungen) weicht dann dauerhaft vom Server ab. Buchungen dürfen deshalb nur per Storno-/Gegenbuchung korrigiert werden, nie per Direkt-DELETE.
  - **Ausnahme Entwicklerwerkzeug:** `POST /api/admin/buchungen/bulk-delete` (`server/src/admin/bulk-booking-routes.ts`) ist bewusst ein harter DELETE (Testdaten aufräumen) und setzt deshalb nach erfolgreichem Löschen **die Restore-Epoche** (`schreibeRestoreEpoch()`). Jeder Client verwirft beim nächsten Sync-Tick seine IndexedDB inkl. Outbox und zieht den vollen Snapshot — ohne Login, ohne Hand des Users. Ohne etwas Gelöschtem wird die Epoche **nicht** gesetzt (kein Grund, allen Geräten die DB wegzuwerfen). Wer trotzdem per Hand in der DB löscht (`psql`), umgeht den Mechanismus und bekommt die Geister wie oben beschrieben.
  - **`POST /api/admin/db/clear` setzt die Epoche bewusst NICHT**: nach dem Leeren ist `server = 0`, die Geister-Bereinigung (`divergent()`) greift nicht, und der Reseed-Weg („Server aus lokalen Daten aufbauen") braucht genau diese lokalen Daten noch. Ein Epoche-Bump würde die Clients auslöschen und den Reseed unmöglich machen.
- **Der User kann seine lokale DB immer selbst neu aufbauen** — *Einstellungen → Daten → Lokaler Speicher (Gerät)* (`src/views/GeraetView.vue`, Route `einstellungen-geraet`, **ohne** `requiresAdmin`). Die IndexedDB ist laut Architektur flüchtig, deshalb darf der Reset nicht Admin-only sein (er lag vorher nur im Entwickler-/Backup-View). Die Ansicht zeigt Zähler lokal vs. Server, warnt explizit, wenn noch Outbox-Änderungen offen sind (die beim Reset verloren gehen), und nutzt dasselbe `resetLocalDbAndPull()` wie der Admin-Button.

### Geräte-Reset (serverseitig ausgelöster lokaler DB-Reset)

- Ein PWA-Endgerät meldet sich mit einer selbst erzeugten UUID (im `localStorage` gespeichert, überlebt also ein IndexedDB-Wisch) per Heartbeat `POST /api/sync/device-heartbeat` (`src/services/sync/worker.ts`) beim Server. Der Server ordnet das Gerät dem angemeldeten User zu (`geraete`-Tabelle, Migration `0027`, PK = Geräte-UUID, FK `user_id` → `users` mit `ON DELETE CASCADE`) und speichert einen Fingerprint (User-Agent, App-Version, IP).
- Der Admin kann das Reset-Flag pro Endgerät (`POST /api/admin/geraete/:deviceId/reset`) oder für alle Endgeräte eines Users auf einmal (`POST /api/admin/geraete/user/:userId/reset`) setzen — Entwicklermenü → Geräte (`src/views/DevelopmentView.vue`). `reset_am = now()` setzt den Flag; `reset_am = null` hebt ihn wieder auf.
- Der Sync-Worker fragt bei jedem Lauf (und direkt nach erfolgreichem Online-Login in `src/stores/auth.ts`) den Heartbeat ab. Ist `reset_am` neuer als der zuletzt lokal angewendete Resetzeitstempel (`castel.device.lastAppliedResetAt` im `localStorage`, ausserhalb der IndexedDB), löscht das Gerät seine komplette lokale IndexedDB inkl. Outbox, zieht einen vollen Server-Snapshot, merkt sich den Zeitstempel und lädt neu. Der Flag gilt nur für dieses eine Endgerät; ein neuer Flag führt zu einem weiteren Reset, derselbe wird nicht zweimal angewendet.
- Datenverlust: nicht übertragene Outbox-Änderungen gehen verloren — gleiches Prinzip wie bei Restore-Epoche / `pg_restore` (Server ist Source of Truth, Client ist flüchtig).

### Akkutausch: Planung und Bestell-Snapshots

- **Projektakkus: Hinzufügen ist rollenoffen.** Jede angemeldete Rolle darf einen neuen Projektakku anlegen (`akku_projekt`, `op: 'create'`). Bearbeiten und Löschen (beides als `op: 'update'`/Soft-Delete gepusht) bleiben Admin-only — der Resolver wirft sonst `VALIDATION`, der Store (`projektSpeichern`/`projektLoeschen`) schreibt solche Ops gar nicht erst in die Outbox.

- **Der Bedarf kommt aus der Netzteilliste** — Geräte, deren Fälligkeit (`einbaudatum` + `intervall_jahre`) ins gewählte Quartal fällt (× `anzahl`), gruppiert über die Kapazitätsbänder der `akkuTypen` — **plus** die Projektakkus des Quartals. Nichts anderes speist den Bedarf an.
- **Die „zur freie Verfügung" (Puffer) ist eine reine Admin-Konfiguration**: der Mindestbestand des Akku-Artikels am **Hauptlager** (`artikel_standort_mindestbestaende`). Sie wird nur von Admins gepflegt (Plantabelle, Einstellungen → Akku-Größen) und dient **ausschließlich** der Bestellmenge:
  `bestellmenge = max(0, bedarf − max(0, bestand) + puffer)`.
  Der Puffer wird **nie** aus dem Bestand oder dem Bedarf umgerechnet — kein `verfuegbar`-Zwischenwert, keine automatische Nachführung.
- **„Bestellt" archiviert einen Snapshot** in `akku_bestellungen` (Migration `0024`): eingefrorene Plantabelle (`zeilen` als JSONB), Inventur-Stichtag und Kürzel der auslösenden Person. `bestellt_am` setzt der Server (Source of Truth), `create` ist per UUID idempotent.
- **Ein bestelltes Quartal ist gedeckt**: `berechnePlanung` bekommt `bereitsBestellt` und liefert dann Bestellmenge 0 (leere Bestellliste). Der Bedarf bleibt sichtbar, die bestellte Menge steht im Archiv.
- **Nur die letzte Bestellung ist rückgängig zu machen.** Ein `update`-Op (`op: 'update'`, Entity `akku_bestellung`) setzt `storno = true` + `storno_am` (Server-Zeit). Der Server prüft, dass die Zielzeile die **neueste** ist (`ORDER BY bestellt_am DESC LIMIT 1`) — sonst `NICHT_LETZTE_BESTELLUNG` (Client legt das Outbox-Item sofort still, `HARD_QUARANTINE_CODES`).
- **Der Snapshot bleibt Historie.** Die Zeile wird nicht gelöscht; `storno`-Bestellungen zählen nicht mehr als „bestellt" für ihr Quartal (`bestellungFuerQuartal` filtert sie), das Quartal kann also erneut bestellt werden.
- **Nebenwirkung wird zurückgenommen.** „Bestellt" setzt den Mindestbestand der Akku-Artikel mit Bedarf am Hauptlager auf **den Bedarf** (nicht auf `Bedarf − Bestand` — sonst zählt der Puffer in der Bestellmenge doppelt). Größen **ohne** Bedarf bleiben unangetastet — ihr Admin-Puffer wird nicht überschrieben. Der Snapshot merkt sich den alten Puffer in `zeilen[].reserve` (sowie `artikelId` und `standort_id`), das Rückgängig-Machen schreibt ihn zurück (0 entfernt die sparse Zeile).
- **Der Snapshot-Filter zieht Stornos nach**: `bestellt_am > since OR storno_am > since` — sonst käme das Rückgängig-Machen auf anderen Geräten nie an.

### Benutzerrechte: Admin-only-Bereiche

- **Admin-only (Routing via `meta.requiresAdmin` + `auth.istAdmin`)**: Standorte, Benutzerverwaltung, Artikel-/Akku-Typen, Kommissionen (Verwaltung), Hersteller, Backup, Entwicklung, CSV-Import, **API-Keys** und Mindestbestand-Panel.
- **Einstellungen-Menü (`SettingsView.vue`)**: die Links *CSV-Import*, *Backup* und *API-Keys* sowie der **gesamte Stammdaten-Block** (Standorte, Artikel-/Akku-Typen, Kommissionen, Hersteller) sind nur für Admins sichtbar. Bewusst offen für alle Rollen: *Lokaler Speicher (Gerät)*, *Artikel-Kataloge*, *Etiketten* und der Akkutausch-Zugriff (Toggle admin-only) — diese Routen tragen kein `requiresAdmin`.
- **`standardStandortId` ist eine Admin-Einstellung.** Das Formularfeld in den Einstellungen zeigt nur Admins einen Select; `resolveEinstellung` (Server) lehnt jeden Push des Keys von Nicht-Admins ab — auch für die eigene User-ID (`ADMIN_ONLY_PER_USER_KEYS`). Die Speicherung bleibt pro User (`userId`-Zeile); das Pull-Filter bleibt unverändert. Bestehende Outbox-Einträge von Nicht-Admins laufen in die Quarantäne (`VALIDATION` pro Op, kein Batch-Abbruch).

### Preise, Rabatt und Lagerwert

- **Geld ist immer eine Ganzzahl in Cent** — `artikel.listenpreis`, `artikel.einkaufspreis`, `hersteller_artikel.preis_*_cent`. Auch die PWA speichert beide Preise in Cent (Dexie v17 hat den früheren Euro-Wert des Artikelformulars umgestellt). Die UI rechnet in Euro und wandelt an der Formulargrenze um (`src/domain/geld.ts`).
- **Der Ø-Rabatt liegt am Lieferanten** (`hersteller.rabattsatz`, NUMERIC(5,2) in Prozent, Migration `0022`). `hersteller` ist die Lieferanten-Stammdaten-Entität, an der die Artikel hängen (`artikel.hersteller_id`); der Freitext `artikel.lieferant` ist nur der Spiegel für DATANORM/CSV.
  - **Vertraulich** wie der Einkaufspreis: nur Admins sehen und schreiben ihn. Der Snapshot strippt ihn für andere Rollen (`server/src/sync/preise.ts`), der Push-Resolver ignoriert ihn für Nicht-Admins.
- **EK-Erzeugung**: `EK = Listenpreis × (1 − rabattsatz / 100)` (reine Logik in `src/domain/rabatt.ts`). Beim Ändern des Listenpreises (Artikelformular/-detail, Katalogübernahme) wird der EK automatisch erzeugt; beim Ändern des Rabattsatzes werden die EKs aller Artikel des Lieferanten neu berechnet (`artikelStore.berechneEinkaufspreise`).
- **Lagerwert** = Σ (Bestand je Artikel/Standort ÷ VE × EK) — nur positive Bestände, Artikel ohne EK werden gezählt und ausgelassen (`lagerwertAuswertung` in `src/domain/statistik.ts`, Admin-only im Dashboard).

### Konfiguration vs. Einstellungen

Klar trennen — beides kommt **nicht** zusammen in der DB ab:

- **Konfiguration** (App-weit, ENV, beim Container-Start): `JWT_SECRET`, `CORS_ORIGIN`, `FOTOS_MAX_BYTES`, `RATE_LIMIT_*`, `LOG_LEVEL`, `COOKIE_*`, `DB_*`. Wird vom API-Container aus der `.env` gelesen, lebt nicht in PostgreSQL.
- **Postgres-Loglevel**: `PG_LOG_LEVEL` in der `.env` (Postgres-GUC `log_min_messages`, Werte `debug5`..`panic`). Wenn leer, wird aus `LOG_LEVEL` gemappt (`trace→debug2`, `debug→debug1`, `info→info`, `warn→warning`, `error→error`); Default ohne beide: `warning`. Bei `debug*/info/notice` aktiviert der `db.command:` in `docker-compose.yml` zusätzlich `log_statement=all` + `log_duration=on` → **jedes** SQL-Statement landet im Log. Nur zum Debuggen setzen, danach wieder auf `warning`/`error` (Log-Flut!).
- **Einstellungen** (User-/Fach-Präferenzen, änderbar zur Laufzeit, Cross-Device-synchronisiert): `artikelTypen` (global, Admin-only), `sprache` und `standardStandortId` (per-User). Liegen in der `einstellungen`-Tabelle (PK = `(key, user_id)`), LWW auf `geaendert_am`. Die PWA spiegelt sie zusätzlich in IndexedDB (Dexie, Compound-Key `[key+userId]` seit Dexie-Schema v5/v6, aktueller Schema-Stand v17 in `src/db/database.ts`; `userId = ''` als globaler Marker — Domäne arbeitet mit `null`).
- **`kommissionen` ist add-only für Nicht-Admins.** Die globale Kommissionen-/Projektliste wird im Buchungsformular als Auswahl angeboten; jeder User darf dort eine neue Kommission anlegen. Der Server merged solche Beiträge mit dem gespeicherten Stand (Union, `server/src/domain/kommissionen.ts` + `ADD_ONLY_KEYS` in `server/src/sync/resolver.ts`) und speichert das Ergebnis mit einem Zeitstempel, der neuer als beide Stände ist — so holt der Client die gemergte Liste per Pull nach. Entfernen und Sortieren bleiben exklusiv beim Admin (`/einstellungen/kommissionen`); ein Admin-Schreibvorgang ersetzt die Liste (LWW) und kann dabei einen zwischenzeitlich ergänzten Eintrag eines Users verwerfen.
- **Persistenz**: `einstellungen` läuft über das `pgdata`-Volume des API-Containers, nicht über ein eigenes Volume. Backups via `pg_dump`.

### Outbox-Ops: Identität und Push-Vertrag

- **`op` ist pro Entity ein eigener Vertrag, nicht global.** Erlaubte Ops stehen an **zwei** Stellen und müssen deckungsgleich sein: `pushPayloadSchema` in `server/src/domain/validierung.ts` (HTTP-Validierung) und `pushSchema` in `server/src/sync/resolver.ts` (Typen). Die PWA schreibt die Ops in den Stores (`queueOp(entity, op, payload)`).
- **Ein Schema-Mismatch ist kein Einzelfehler, sondern ein Batch-Abbruch.** `POST /api/sync/push` validiert den Request-body komplett und antwortet mit **HTTP 400** — der Worker markiert daraufhin **alle** Ops im Batch als fehlgeschlagen und retryt sie für immer (bei Batch-Fehlern greift **keine** Quarantäne, `QUARANTINE_THRESHOLD` wirkt nur pro Op im `result.errors`-Pfad). Ein einziges unpassendes Op legt damit die **gesamte** Outbox still (buchungen inklusive).
- **`etiketten_bogen_layout`** ist deshalb explizit dokumentiert: Identität ist der **User** (`unique Index auf user_id`, eine Zeile pro User), nicht die UUID. Die PWA kennt den Server-Stand nicht und queued immer **`upsert`** (analog `einstellung`); `delete` (Reset auf Defaults) trägt **den vollständigen Datensatz** — das Payload-Schema akzeptiert für `delete` zusätzlich nur (`id`, `userId`), damit ältere Clients nicht den ganzen Push brechen. LWW läuft auf `geaendert_am`.
- **Regel für neue Entities**: Schema (Server) + Store-`queueOp` (PWA) + Test, der das exakte vom Client gesendete Op durch `pushPayloadSchema` jagt, immer zusammen ändern.

### Migrationen

- **Der Runner entscheidet über den Hash, nicht über Zeitstempel.** `server/src/db/migrate.ts` liest `meta/_journal.json`, bildet den SHA-256 über jede `.sql`-Datei und vergleicht ihn mit `drizzle.__drizzle_migrations`. Angewandt wird alles **nach** der zuletzt angewandten Migration (Index im Journal).
  - Grund: Drizzle-orms `migrate()` vergleicht nur `created_at` gegen den `when`-Wert des Journals. Die historischen Pseudo-Zeitstempel (`1700000000000 + Index * 1000`) liegen alle vor jedem echten Zeitstempel — bei einer Installation, deren Buchführung echte Zeitstempel trägt, würden die fehlenden Migrationen **nie** angewandt.
  - Der `when`-Wert im Journal ist rein informativ. Neue Migrationen: Datei unter `server/src/db/migrations/NNNN_name.sql` anlegen, Eintrag in `meta/_journal.json` ergänzen (Index + `tag`; `when` = aktueller Epoch-ms).
  - **Idempotenz bleibt Pflicht**: jede `.sql`-Datei muss mehrfach ausführbar sein (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `DROP CONSTRAINT IF EXISTS`), weil der Runner bei einem Teilfehler die Transaktion zurückrollt und der Container-Start sie beim nächsten Mal erneut versucht.
  - Lokal: `npm run db:migrate` aus `server/` (liest `src/db/migrations/`), im Container `node dist/db/migrate.js` (liest `dist/migrations/`).

## Build-Metadaten in der PWA

`scripts/write-version.mjs` läuft vor jedem Build und schreibt `src/version.ts`
(Version aus `package.json`, Commit/Branch/Build-Datum). Im PWA-Buildx gibt es
kein `.git/`, also fallen Commit/Branch sonst auf `unbekannt` zurück. Das CI
reicht deshalb `GIT_COMMIT` (`github.sha`) und `GIT_BRANCH` (`github.ref_name`)
als Build-Args an `Dockerfile.pwa` durch — `write-version.mjs` liest sie aus
der ENV und nutzt sie mit Fallback auf `git rev-parse` (lokal).

## Code-Qualität

- **TypeScript** – kein ungetypter Code in neu geschriebenen Dateien.
- **Code-Kommentare auf Englisch.** Inline-Kommentare, JSDoc/TSDoc und sonstige Quelltext-Kommentare sind in englischer Sprache zu verfassen. Identifiers, Strings, UI-Labels und Commit-Messages bleiben projektspezifisch (Deutsch ist okay, sofern bestehend).
- **Nach Änderungen** sind Lint und Tests auszuführen:
  - `npm run lint`
  - `npm run test:run` (einmalig; `npm test` startet Vitest im Watch-Mode und blockiert)
  - API-Seitig: `npm run test:run` und `npm run typecheck` in `server/`
- Build muss sauber durchlaufen: `npm run build`.

## Todo-Liste (Pflicht, keine Ausnahme)

Die Todo-Liste ist **kein Nice-to-have**, sondern das Protokoll des Laufs.
Ein Lauf ohne gepflegte Liste ist ein **Regelverstoß** — genau wie ein Lauf
ohne Lint/Tests. Wiederholtes Vergessen ist ein gemeldeter, gravierender
Fehler; die folgenden Regeln sind hart:

- **Anlegen bei ≥ 3 Teilschritten** (und immer, wenn der User eine Liste
  verlangt): sofort zu Beginn via `todowrite`, alle Schritte als `pending`.
- **Genau ein `in_progress` zur Zeit.** Vor dem ersten Tool-Aufruf eines
  Schritts wird dieser auf `in_progress` gesetzt — nie mehrere gleichzeitig.
- **`completed` sofort nach Abschluss des Schritts**, im selben Tool-Batch
  wie der nächste Schritt. **Niemals sammeln, nachtragen oder am Ende
  pauschal abhaken.** Wer drei Schritte erledigt und die Liste erst danach
  aktualisiert, hat die Regel bereits verletzt.
- **`completed` erst nach tatsächlicher Verifikation** (z. B. Lint/Test/Build
  wirklich gelaufen, Datei wirklich geschrieben) — nicht nach Absicht.
- **Blockiert** → Schritt bleibt `in_progress`, zusätzlicher `pending`-
  Folgeschritt benennt den Blocker. Kein stilles Überspringen.
- **Abgebrochene/unnötige Schritte** werden `cancelled`, nicht gelöscht.
- **Vor der Abschluss-Antwort** ist die Liste vollständig aktuell: keine
  `pending`/`in_progress`-Reste, die nicht ausdrücklich als offen gemeldet
  werden.

Der Statusbericht am Ende (Commit-/Push-/Build-Status) beschreibt den
tatsächlichen Zustand der Liste, nicht die Erinnerung daran.

## Commits & Versionierung

- **Conventional Commits sind Pflicht.** Commit-Messages folgen dem Format
  `<type>(<scope>)?: <subject>` (siehe `commitlint.config.mjs`). Husky
  blockiert nicht-konforme Messages lokal (`commit-msg`-Hook).
- **Erlaubte Typen**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
  `test`, `build`, `ci`, `chore`, `revert`. `feat!`/`BREAKING CHANGE:` für
  Major-Bumps.
- **Version läuft mit jedem Commit hoch.** Ein Husky-`pre-commit`-Hook ruft
  `scripts/bump-version.mjs` auf, das die Patch-Nummer (semver `MAJOR.MINOR.PATCH`)
  in `package.json` (Root) und `server/package.json` um 1 erhöht und beide
  Dateien mit `git add` zum laufenden Commit staget. Pre-Release-Tags
  (z. B. `0.2.0-beta.1`) bleiben erhalten, Build-Metadaten werden verworfen.
  Manuelle Minor-/Major-Bumps: einfach den gewünschten Wert in beide
  `package.json` schreiben — der nächste Commit landet auf `<neu>.+1`.
  - `npm run version:bump` macht dasselbe ohne Hook (z. B. für CI-Tricks).
  - Im Repo liegt **kein** `CHANGELOG.md` und **kein** `v*` Tagging. Wer
    release-notes braucht, schaut in `git log` (Conventional Commits
    reichen für die Gruppierung).
- **`build-and-push.yml`** baut das PWA- und API-Image bei Push auf `main`
  und pusht sie mit Tag `:latest`, `:pre-release` **und** mit dem SHA-Tag.
  Frische Images kommen also mit jedem Merge auf `main` — kein zusätzlicher
  Tag-Trigger mehr nötig. `:pre-release` ist ein beweglicher Alias auf den
  jeweils letzten `main`-Build (derselbe Digest wie `:latest`), gedacht für
  Stacks, die einen expliziten Pre-Production-Tag referenzieren (z. B.
  Coolify-/Arcane-Deploys vor dem finalen `latest`-Rollout). Wer ein
  wirklich eingefrorenes Pre-Release will, pinnt den Commit-SHA.
- **Pre-Release-Build auslösen**: Ein beliebiger Commit auf `main` löst den
  Build aus. Der Husky-`pre-commit`-Hook bumpt automatisch die Patch-Version
  in beiden `package.json` (0.4.13 → 0.4.14). Für einen reinen
  Versions-Bump ohne Sach-Änderung:
  `npm run version:bump && git commit -m "chore(release): version bump" && git push`

## Sicherheit

- **Keine Secrets im Code.** API-Keys, Tokens, Passwörter und private Konfiguration gehören in `.env` (nicht eingecheckt) oder werden zur Laufzeit vom Benutzer eingegeben.
- Vor jedem Commit ist zu prüfen, dass keine Credentials versehentlich committet wurden.

## Backup & Restore

- **Server ist Source of Truth, Client ist flüchtig.** Die PWA-IndexedDB wird beim nächsten Online-Sync ohnehin überschrieben. Es gibt **kein** clientseitiges Backup-Feature — die ganze Backup-/Restore-Logik liegt in der API und im PWA-Admin-UI unter *Einstellungen → Daten → Backup & Restore*.
- **Alles läuft in-process im API-Service** (kein Host-Skript, kein Cron, kein SSH). Das API-Image bringt `postgresql-client-16` (für `pg_dump`/`pg_restore`) und `archiver` (npm) mit. Die Volumes `pgdata`, `fotos-data` und `backups-data` sind named Volumes aus `docker-compose.yml`; sie sind vom externen Snapshot/Borg des Deployers unabhängig.
- **Client-Version MUSS zur Server-Version passen (Pflicht).** Das API-Image installiert den Postgres-Client aus dem PGDG-Repo in der Major-Version `ARG PG_MAJOR=16` (`server/Dockerfile`). Der `db`-Service fährt `postgres:16-alpine` — **die beiden Major-Versionen müssen synchron bleiben**. Ein älterer `pg_dump` verweigert einen neueren Server (`aborting because of server version mismatch`), liefert einen **0-Byte-Dump** und das Backup ist wertlos (Restore: `pg_restore: error: input file is too short`). Bei einem Major-Bump der DB: `ARG PG_MAJOR` im Dockerfile anheben. Der Server prüft beim Start `pg_dump --version` gegen `SHOW server_version_num` und loggt einen Error, wenn der Client älter ist.
- **Drei Wege zum Backup** (alle admin-only):
  1. **Datei im Server speichern** — `POST /api/admin/backup/run`. Schreibt nach `BACKUP_DIR` (`/var/lib/castel/backups`, Volume `backups-data`).
  2. **Herunterladen** — `GET /api/admin/backup/file/:name` streamt das ZIP aus `BACKUP_DIR` (es gibt **kein** `POST /api/admin/backup/download`).
  3. **Cronjob** — `GET/PUT /api/admin/backup/settings` (Schedule = HH:MM, Keep-Copies = 1–365). Der Server-Cron (`server/src/admin/backup-cron.ts`) tickt jede Minute und feuert genau einmal pro Tag zur eingestellten Zeit, rotiert nach `keepCopies`.
- **Der Cron-Schutz liegt in der DB, nicht im Prozess.** Der Tages-Slot wird **atomar** in `einstellungen` unter `backup.lastSlot` beansprucht (`beansprucheTagesSlot`, bedingtes `UPDATE … RETURNING`). Ein reiner In-Memory-Marker (`_letzterLauf`) überlebt keinen API-Neustart — nach einem Crash (pg_dump-OOM) oder Re-Deploy wäre der Cron sofort wieder „fällig“ (Catch-up, weil `now` den Slot schon überschritten hat) und es entstünden **Backups im Minuten-Takt**. Der Claim schützt gleichzeitig gegen Mehrinstanzenbetrieb. Slot-Logik (pure, testbar): `server/src/admin/backup-cron-slot.ts` → `tagesSlotFuer(now, schedule)`.
- **Ablauf pro Backup** (sync-first):
  1. `POST /api/admin/sync/all` setzt `sync.forceAt`-Marker in `einstellungen`.
  2. Polling auf `GET /api/sync/status`, bis `buchungen`-Count stabil ist. **Zwei Zeitfenster**: Die HTTP-Endpoints `run` warten kurz (2 s Ruhe / 15 s Cap — nginx im PWA-Container killt Proxy-Requests nach 60 s, und der Sync-Worker pusht ohnehin alle 30 s). Der Cron nutzt die vollen Config-Defaults `BACKUP_SYNC_QUIET_MS` (8 s) / `BACKUP_SYNC_TIMEOUT_MS` (120 s).
  3. `pg_dump -Fc` → Custom-Format-Dump. **Exit-Code und Byte-Count werden geprüft**: ein fehlgeschlagener oder leerer Dump macht das Backup zum Fehler (die ZIP wird verworfen) — ein Backup mit 0-Byte-Dump darf nie als „erfolgreich“ durchgehen.
  4. `FOTOS_DIR` → `fotos/` (Artikel-IDs als Unterordner) **und** `DATANORM_DIR` → `datanorm/` (Rohkataloge der Lieferanten). Beides liegt außerhalb von Postgres — ohne `datanorm/` zeigten die restaurierten `datanorm_dateien`-Zeilen ins Leere (kein Re-Import, kein Original-Download).
  5. `manifest.json` (`schema: 'castel-backup-1'`) + ZIP via `archiver`.
- **Restore**: `POST /api/admin/backup/restore` mit `{ name, confirm: 'yes' }` — der Server entpackt das ZIP in tmpdir, ruft `pg_restore --clean --if-exists --single-transaction` und **ersetzt** danach `FOTOS_DIR` und `DATANORM_DIR` (Ziel wird geleert, dann der Backup-Stand kopiert). **Ersetzen statt Mergen**: der Restore-Stand ist Source of Truth — Dateien, die im Backup nicht existieren, dürfen nicht erhalten bleiben (sie passten sonst nicht mehr zu den restaurierten Tabellenzeilen). Enthält ein uraltes Backup **kein** `fotos/`/`datanorm/`, bleibt das jeweilige Ziel unangetastet. Der Restore läuft im API-Prozess (der Endpoint wird von der API bedient) — die DB wird also unter laufender API ersetzt; die Clients räumen sich über die Restore-Epoche selbst auf.
  - **Vor `pg_restore` wird der Dump validiert**: Datei vorhanden, > 0 Bytes, Header `PGDMP`. Sonst Abbruch mit klarer Meldung.
  - **Jeder `pg_restore`-Exit-Code != 0 ist ein Fehler** (kein „toleranter“ Exit 1). Ein Restore, der Erfolg meldet, obwohl nichts eingespielt wurde, ist schlimmer als ein klarer Fehler.
- **Restore-Epoche — alle Clients resetten sich automatisch.** Nach erfolgreichem Restore schreibt der Server `server.restoreEpoch` (ISO-Zeit) in `einstellungen`; der Wert wird **nach** dem `pg_restore` geschrieben (der Marker liegt selbst in der restaurierten DB). Der Sync-Worker fragt die Epoche **vor dem Push** per `GET /api/sync/restore-epoch` ab und vergleicht sie mit seinem lokalen Marker (`server.restoreEpoch` in der IndexedDB, `userId: ''`). Bei Abweichung: Worker stilllegen → IndexedDB **hart löschen** (inkl. Outbox!) → vollen Snapshot ziehen → Epoche lokal merken → Seite neu laden. Warum zwingend: nach `pg_restore` tragen die Zeilen alte `geaendert_am` (vor `lastPullAt` → nie wieder ausgeliefert), gelöschte Zeilen blieben lokal als Geister stehen, und die Outbox der Vor-Restore-Welt würde alten Stand in die restaurierte Server-DB zurückschreiben. Der auslösende Client setzt seine DB in `BackupView.vue` direkt nach dem Restore (`resetLocalDbAndPull` + Reload).
- **Die Epoche ist der allgemeine „Clients müssen neu aufbauen"-Marker**, nicht nur ein Restore-Protokoll: jede Server-Aktion, die Daten hart löscht und damit den inkrementellen Sync unkonzervierbar macht, muss `schreibeRestoreEpoch()` aufrufen (aktuell: Restore und das Buchungen-Bulk-Delete im Entwicklermenü). Manuell denselben Weg — ohne Server, ohne Admin — kann jeder User über *Einstellungen → Daten → Lokaler Speicher (Gerät)*.
- **Server-interne Settings-Keys** (`sync.forceAt`, `backup.lastSlot`, `server.restoreEpoch`) sind **server-only**: sie werden aus dem Sync-Snapshot gefiltert und in Pushes ignoriert (`server/src/sync/einstellungen-intern.ts`). Sonst könnte ein veralteter Client (oder der Reseed) einen alten Wert zurückschreiben — z. B. einen bereits verbrauchten Backup-Tages-Slot.
- **Backup-Liste**: `GET /api/admin/backup/list` liefert je ZIP `dumpBytes`/`dumpOk` (geprüft via `unzip -l`). Backups mit leerem Dump werden im Admin-UI als unbrauchbar markiert; der Restore-Button ist für sie deaktiviert.
- **Manifest-Schema**: `castel-backup-1`. Unbekannte Schemata werden verweigert. Optionale Felder `pgDumpVersion`/`pgDumpMajor` dokumentieren den benutzten Client, `datanormCount` die Zahl der Katalog-Unterordner.
- **Defaults** (Migration 0012): `backup.schedule = ''` (aus), `backup.keepCopies = '7'` (eine Woche). ON CONFLICT DO NOTHING — Admin-Settings werden nicht überschrieben.

## Build & Deployment

- **CI-Build wird automatisch ausgelöst.** Der GitHub-Workflow `.github/workflows/build-and-push.yml` baut bei jedem Push auf `main` die Images und pusht sie mit Tag `:latest`, `:pre-release` **und** dem SHA-Tag. Der Agent startet den CI-Build **nicht manuell** — ein Push auf `main` reicht.
- **Jeder Push wird verifiziert (Pflicht, gelernter Fix-Fehler).** Ein `git push` kann scheinbar durchlaufen und trotzdem still scheitern (Timeout, Remote-Ablehnung). Danach IMMER prüfen:
  ```bash
  git rev-parse origin/main   # muss == git rev-parse HEAD sein
  ```
  Weicht `origin/main` ab, ist der Fix **nicht** auf dem Remote und jeder CI-Build läuft ohne ihn. Erst verifizieren, dann dem User den Deploy empfehlen — niemals den Push nur behaupten.
- **Pflicht-Wartephase nach dem Push (2 min Delay, dann Build-Erfolg prüfen — Pflicht, gelernter Fix-Fehler).** Ein Build bricht mitunter ab, obwohl `git push` sauber durchlief und `origin/main == HEAD` gilt. Wer den Status zu früh abfragt, sieht einen noch nicht gestarteten oder gerade laufenden Workflow und meldet fälschlich Erfolg. Deshalb gilt nach jedem Push auf `main` **exakt diese Reihenfolge**:
  1. `git rev-parse origin/main` — muss `git rev-parse HEAD` entsprechen (siehe oben).
  2. **Delay abwarten: 2 Minuten.** Der Workflow braucht nach dem Push-Event Zeit, bis der Run in der GitHub-UI überhaupt existiert. In dieser Zeit wird **kein** Status abgefragt und **kein** Erfolg behauptet. In PowerShell: `Start-Sleep -Seconds 120`.
  3. **Build-Erfolg verifizieren.** Der Agent MUSS den Lauf-Status für den gepushten SHA per `gh` prüfen und auf **`completed success`** warten:
     ```bash
     gh run list --limit 5 --workflow build-and-push --json databaseId,headSha,status,conclusion
     gh run watch <id> --exit-status   # blockiert bis Ende
     ```
     Steht dort `conclusion: failure`, `cancelled`, `timed_out` oder `startup_failure`, ist der Build **gecrasht**: Der Agent meldet das **explizit** mit `gh run view <id> --log-failed` (Ursache) und **verbucht KEINEN Erfolg**. Ein Fix wird erst nach `new commit + push` erneut verifiziert.
  4. **Erst danach** wird Erfolg verbucht und der Deploy empfohlen:
     ```bash
     docker compose pull
     docker compose up -d
     ```
  Ohne Schritt 3 (verifizierter `completed success`) gilt der Build als **fehlgeschlagen**, nicht als „läuft noch". Ein „ich habe gepusht, der Build läuft" ohne spätere Verifikation ist eine Falschaussage gegenüber dem User.
- **Nach dem Push erst warten, dann deployen.** Der neue Image-Tag ist erst verfügbar, wenn der Build für den gepushten SHA erfolgreich durchgelaufen ist (Schritt 3 oben). Erst danach:
- **Images kommen aus GHCR.** `docker-compose.yml` referenziert `api`, `pwa` und `migrate` hartkodiert als `ghcr.io/icem0/castel-{api,pwa}:latest`. **Kein** `build:`-Block, **kein** Variablen-Override. Deployer ziehen die Images — fertig.
- **`migrate`** ist ein Entry-Point des API-Images (`node dist/db/migrate.js`). Es wird also nicht für jeden Job ein eigenes Image gebaut. Die `api`-Service-Definition startet vor jedem Server-Start automatisch `node dist/db/migrate.js` (idempotent — bereits angewendete Migrationen werden uebersprungen). Den allerersten Admin legt die PWA selbst an, sobald `/api/auth/setup-status` meldet, dass die `users`-Tabelle leer ist. Der `migrate`-Profil-Service bleibt fuer manuelle Aufrufe erhalten (`docker compose --profile migrate run --rm migrate`).
- **CI-Workflow** `.github/workflows/build-and-push.yml` baut bei Push auf `main` die Images und pusht sie mit Tag `:latest`, `:pre-release` **und** mit dem SHA-Tag. Bei Pull-Requests wird **nur** gebaut, nicht gepusht (Gate `if: github.event_name != 'pull_request'`). Sichtbarkeit wird per `PATCH /user/packages/container/{pkg}` auf `public` gesetzt.
- **Manueller Build mit eigenem Titel** (`workflow_dispatch`): Im GitHub-UI unter *Actions → build-and-push → Run workflow* lässt sich ein Run mit einem **Titel** starten (Input `name`, z. B. „Akkutausch-Verwaltung“). Der `run-name` des Workflows übernimmt diesen Titel; Push-/PR-Runs bleiben unverändert `build-and-push`. Ein manueller Run pusht wie ein Push (`:latest`, `:pre-release`, SHA-Tag) — er ist also **kein**Dry-Run und überschreibt `:latest`. Es gibt bewusst **keinen** Workflow pro Feature: ein Build entsteht pro Push, das Thema steckt im Commit-Titel.
- **GHCR-Token**: Für private Pakete braucht der Deployer einen GitHub-PAT mit Scope `read:packages`. Bare Docker / Coolify: `docker login ghcr.io`. Arcane: einmalig `POST /container-registries` mit dem PAT. Für öffentliche Pakete reicht kein Token.
- **GHCR-Visibility-Automation**: `build-and-push.yml` ruft am Ende jedes Jobs `PATCH /user/packages/container/{pkg}` mit `{"visibility":"public"}`. Der automatische `GITHUB_TOKEN` darf das für User-Repos **nicht** (gibt 404). Lösung: klassischen PAT mit Scopes `repo` + `write:packages` unter dem Secret-Namen **`GHCR_ADMIN_TOKEN`** im Repo hinterlegen (`Settings → Secrets and variables → Actions`). Ohne Secret wird der Flip mit `::warning::` übersprungen — das Image wird trotzdem gepusht, das Paket bleibt aber `private`. Für server-seitige Pulls reicht das (Auth gegen `ghcr.io` via `docker login` bzw. Coolify-/Arcane-Registry-Config). Wer das Paket wirklich öffentlich haben will, legt den Secret an, der Flip läuft dann automatisch.
- **Arcane / Coolify / bare Docker** funktionieren ohne Anpassung — sie alle ziehen `image:`-Referenzen transparent. Der frühere `build:`-Pfad ist absichtlich entfernt.
- **Update-Workflow**: `git pull && docker compose pull && docker compose up -d` (nicht `--build` — es gibt nichts Lokales zu bauen).
- **Deploy-Falle DB-Volume-Reset.** Symptom: nach einem Deploy antwortet die API mit `401 USER_INACTIVE` („User ist deaktiviert"), die PWA springt auf den First-Register-Screen. Bedeutung: die `users`-Tabelle ist **leer** — das DB-Volume wurde zurückgesetzt. Ursachen: Override-File (`docker-compose.override.yml` entfernt `pgdata` per `volumes: !reset`), `docker compose down -v` oder `castel-restart.ps1` im Livebetrieb. Ein automatischer Server-Truncate beim Start existiert nicht mehr (der alte `dev-reset` ist entfernt) — eine leere DB kommt also immer über gelöschte/resetzte Volumes. Fix: Stack mit bestehendem Volume neu starten, Admin über das Setup-Formular neu anlegen (greift, solange `/api/auth/setup-status` die leere `users`-Tabelle meldet). **Das ist KEIN Backup-Bug** — `POST /api/admin/backup/run` ist nur der erste Request, bei dem der 401 sichtbar wird. Diagnose: `GET /api/auth/setup-status` und `docker volume ls` nach `pgdata` durchsuchen.
- **Lockfiles pro Paket**: `package-lock.json` im Root (PWA), `server/package-lock.json` (API). Beide müssen in ihrem jeweiligen Verzeichnis für `npm ci` liegen — beim CI-Build übernimmt das `working-directory` bzw. `cache-dependency-path`.
- **DATANORM-Upload: nginx-Limit + Volume-Rechte.** Zwei Fallen, die den Katalog-Import komplett blockieren:
  1. **`client_max_body_size`**: nginx erlaubt per Default nur **1 MB** Request-Body. Ein DATANORM-Katalog ist grösser → nginx antwortet mit **413**, noch bevor die API den Request sieht. `nginx-pwa.conf` setzt deshalb `client_max_body_size 512m` (passt zu `DATANORM_MAX_FILE_BYTES` = 500 MB) sowie `client_body_timeout`/`proxy_send_timeout`/`proxy_read_timeout 900s` (Defaults 60 s/60 s/300 s sind für grosse Uploads zu knapp). Die Config ist ins PWA-Image gebacken — der Fix greift erst nach einem neuen PWA-Image.
  2. **Volume-Rechte**: `server/Dockerfile` MUSS `/var/lib/castel/datanorm` anlegen und in die `chown castel:castel`-Liste aufnehmen. Fehlt der Pfad im Image, legt Docker das named Volume `datanorm-data` als `root:root 0755` an → der Non-Root-User `castel` kann kein Unterverzeichnis anlegen → **jeder** Upload scheitert mit EACCES (HTTP 500). Bestehende Volumes behalten ihre Eigentümer — einmalig prüfen/korrigieren: `docker compose exec --user root api chown -R castel:castel /var/lib/castel/datanorm`. Die API prüft die Schreibbarkeit beim Start und loggt einen entsprechenden Fehler (`[datanorm] DATANORM_DIR ist nicht anlegbar/schreibbar`).
- **DATANORM-Format: semikolongetrennt, nicht feste Spaltenbreiten.** Die Feldbelegung steht in `server/src/datanorm/layout.ts` (Index des Feldes nach dem Split an `;`):
  - **v4 A**: `A;N;Artikelnummer;Textkennzeichen;Kurztext 1;Kurztext 2;Preiskennzeichen;Preiseinheit;Mengeneinheit;Preis;Rabattgruppe;Hauptwarengruppe;Langtextschlüssel;` — Preis in **Cent** ganzzahlig (`4700` = 47,00 €), Preiseinheit als **Code** (0/1/2/3 = je 1/10/100/1000 Einheiten), EAN steht im **B-Satz** (Feld 10).
  - **v5 A**: A und B sind zusammengelegt, die EAN steht im A-Satz (Feld 19), die Preiseinheit ist die Zahl selbst.
  - **D/T/P**: Blöcke nach dem Kopf (D: 4 Felder, T: 3 Felder, P: 9 Felder je Artikel).
  - Nur der **v4-Vorsatz** ist fest breit (128 Zeichen, Version „04" + Währung am Ende); der v5-Vorsatz ist wieder semikolongetrennt.
  - Die Version wird aus dem Vorsatz erkannt, sonst aus der Feldzahl des ersten A-Satzes (13 = v4, 23 = v5). Der Admin kann sie im Upload überschreiben („Format": auto/v4/v5); die Einstellung wird am Lieferanten gemerkt (`lieferanten.format`).
  - **Kurztext 1 + 2** gehören zusammen (Textkennzeichen-Ziffer 0/4/5/6) und werden ohne Leerzeichen verkettet — der Export schneidet den Text sonst mitten im Wort.
- **DATANORM-Parser-Version.** `PARSER_VERSION` in `server/src/datanorm/import-service.ts` wird mit der Datei gespeichert (`datanorm_dateien.parser_version`). Ein Upload derselben Bytes mit einer älteren Parser-Version ist **kein Duplikat**: der Lieferanten-Spiegel wird gelöscht und die Datei neu eingelesen. Nach einem Parser-Fix also einfach dieselbe Datei erneut hochladen — die kaputten Zeilen verschwinden.

## Lokaler Test-Workflow (Entwickler-PC, optional)

Wer nicht auf dem Live-Server testen will, kann denselben Stack lokal unter
`http://localhost:4280` (PWA) bzw. `http://localhost:4242` (API) fahren.
Stack-Konfiguration steht in `docker-compose.yml` + `docker-compose.override.yml`
(letztere ist in `.gitignore` — lokal, nicht einchecken). Override-Aufgaben:
entfernt das `pgdata`-Volume am `db`-Service per `volumes: !reset` (jeder
`docker compose up` startet mit leerem Postgres-Cluster), bind-mountet das
Foto-Verzeichnis der API nach `./.data/fotos/`, exponiert den API-Port
`4242` direkt am Host. Die Produktion bleibt unberuehrt und verwendet
`pgdata` weiterhin als named volume.

**Frischer Test pro Lauf** (kein DB-State zwischen Runs):

```
docker compose down -v && docker compose pull && docker compose up -d
```

Oder als Wrapper: `scripts/castel-restart.ps1` — stoppt, räumt Volumes weg,
pullt, startet und gibt Health-/Setup-Status aus. **Im Livebetrieb
darf dieses Skript NICHT laufen** — es löscht den DB-Volume. Für den
Server: `docker compose pull && docker compose up -d` ohne Override
und ohne `-v`.

**Push → warten auf GHCR → Redeploy** (manuell, nicht als Hook):

```
git push                  # löst in .github/workflows/build-and-push.yml
                          # das Bauen + Pushen von :latest und :<sha> aus
pwsh ./scripts/castel-restart.ps1 -WaitForSha <sha> [-WaitTimeoutSec 300]
```

`castel-restart.ps1 -WaitForSha <sha>` pollt das GHCR-Registry-HTTP-API
(`https://ghcr.io/v2/icem0/castel-{api,pwa}/manifests/<sha>`), bis beide
Images für den gerade gepushten Commit verfügbar sind, und startet dann den
Stack. Den passenden SHA bekommt man mit `git rev-parse HEAD` direkt nach
dem Push (oder `git log -1 --format=%H origin/main`).

**Warum kein Git-Hook?** Standard-Git kennt kein `post-push`. `pre-push`
würde den Push künstlich blockieren, `post-commit` feuert auch für
lokale Commits, die gar nicht gepusht wurden. Der Alias-/Skript-Weg ist
explizit, pro-PC konfigurierbar und braucht keinen versteckten Hook.

**Reihenfolge nach `git push` — auf GHCR-Build warten:**

Nach dem Push ist das neue Image **nicht sofort** verfügbar. Erst läuft
`build-and-push.yml` durch (typisch 1–2 min, je nach Last auch länger),
dann liegt das Image unter `ghcr.io/icem0/castel-{api,pwa}:latest`
bzw. `:<sha>`. Wer zu früh `docker compose pull && up -d` macht, kriegt
das **vorherige** Image und wundert sich, warum der Fix nicht greift.

Richtige Sequenz:

```
git push
# 1) Remote-SHA gegen HEAD pruefen (siehe Build-&-Deployment)
git rev-parse origin/main
# 2) Pflicht-Delay 2 min — der Workflow-Existiert erst nach dem Push-Event.
#    In dieser Zeit KEIN Status abfragen, KEINEN Erfolg behaupten.
Start-Sleep -Seconds 120
# 3) Build auf 'completed success' verifizieren (sonst: FAILED melden)
gh run list --limit 5 --workflow build-and-push --json databaseId,headSha,status,conclusion
gh run watch <id> --exit-status
# 4) Erst jetzt deployen
$env:SHA = git rev-parse HEAD
pwsh ./scripts/castel-restart.ps1 -WaitForSha $env:SHA -WaitTimeoutSec 300
```

Schritt 2 ist nicht optional: Wer sofort `gh run list` abfragt, sieht einen
noch nicht gestarteten Lauf und meldet fälschlich Erfolg. Schritt 3 ist erst
nach dem Delay sinnvoll — davor existiert der Run unter Umständen gar nicht.
Ein gecrashter Build (`conclusion: failure|cancelled|timed_out|startup_failure`)
wird mit `gh run view <id> --log-failed` als Ursache gemeldet, **nicht**
kaschiert.

`castel-restart.ps1 -WaitForSha <sha>` pollt das GHCR-Registry-HTTP-API
für **beide** Images (api + pwa) und startet erst, wenn beide Manifeste
für den Commit verfügbar sind. Timeout default 60 s — bei Cold-Cache
(frisches Image, kein Layer-Cache auf GHCR) auf 300 s setzen. Den
passenden SHA bekommt man alternativ mit
`git log -1 --format=%H origin/main`.

**Manuelle Variante** wenn der User keinen SHA-Parameter mag:

```
git push
# Status pruefen ohne das Terminal zu blockieren:
gh run list --limit 1 --workflow build-and-push
# Sobald dort "completed success" steht:
docker compose pull
docker compose up -d
```

Finger weg von `docker compose up -d` zwischen Push und erfolgreichem
CI-Build — der laufende Stack faengt sich entweder das alte Image
(`pull` zieht nichts Neues) oder, schlimmer, einen halbfertigen
Container, der in der Restart-Schleife haengt (`pull` macht bei
„No such image" mit dem Digest-Mismatch nicht immer das, was man will).

Siehe `README.md` → „Installation (nur Docker Compose)" für die Erstinstallation
(inkl. `.env`); `docker-compose.override.yml` ist lokal und nicht eingecheckt.

## Agent-Umgebung (Container)

- **Git-Zugang**: Ein Fine-grained PAT von `icem0` liegt in `~/.git-credentials`
  (chmod 600, `credential.helper store` in der Repo-Git-Config). `git fetch`/
  `git push` laufen damit ohne Prompt. Der Token-Wert selbst darf **niemals**
  in Dateien, Commits oder GitHub-Actions-Secrets landen — ein PAT mit
  Code-Schreibrecht im eigenen Repo als Secret ist ein Zirkelschluss.
- **Kein `gh` im Container**: Build-Verifikation statt `gh run list` über die
  GitHub-API (Token aus `~/.git-credentials`):
  `GET https://api.github.com/repos/icem0/castel/actions/runs?head=<full-sha>`.
  Die API antwortet pretty-printed — grep-Muster müssen das Leerzeichen nach
  dem Doppelpunkt berücksichtigen (`"status": "completed"`).
- **GHCR**: Beide Pakete (`castel-api`, `castel-pwa`) sind aktuell `public` —
  Pull ohne Login, `GHCR_ADMIN_TOKEN` ist derzeit nicht gesetzt und nicht
  nötig (der Visibility-Flip im Workflow bleibt optional).
- **Node/npm**: im Container via `apk add nodejs npm` installiert. Server-Tests
  brauchen eine `.env` in Root **und** in `server/` (nur `DATABASE_URL` und
  `JWT_SECRET` ≥ 32 Zeichen sind Pflicht; sonst beendet
  `server/src/config/config.ts` den Prozess mit Exit 1). Beide `.env`-Dateien
  sind gitignored.

## Finetuning-Runden — Abschluss-Status

Jede Finetuning-Runde (Bereich 1–N) endet mit einem klaren **Commit-und-Push-Status**
in der letzten Antwort des Agents an den User. Das Format ist verbindlich:

```
Commit-Status: committed <hash> | not committed | partially committed
Push-Status:   pushed to origin/<branch> | not pushed | rejected (<Grund>)
Build-Status:  verified success | FAILED (<conclusion>) | not pushed | pending verification
Version:       v<MAJOR.MINOR.PATCH> (<sha>) | n/a (not committed)
```

**Regeln:**

- `Version` ist **verbindlich**, sobald committet/pusht wurde, und nennt die
  Version **des gepushten Commits** — nicht die des Arbeitstrees vor dem
  Commit. Der Husky-`pre-commit`-Hook bumped die Patch-Nummer erst während
  des Commits; die Zahl davor ist also wertlos. Verbindliche Beschaffung
  (liest den Stand *im* Commit, nicht die Dateien auf der Platte):
  ```bash
  git show <sha>:package.json        # version-Feld -> v<...>
  git show <sha>:server/package.json # muss identisch sein
  ```
  Root und Server MÜSSEN in dem Commit dieselbe Version tragen. Weichen sie
  ab, ist das ein Fehler: der Agent meldet beide Werte explizit und verbucht
  keinen sauberen Abschluss.
- Die gemeldete Version ist die, die der CI-Build für denselben SHA in die
  Images schreibt (`write-version.mjs` liest `package.json`) — das ist die
  Antwort auf „unter welcher Version ist dasDeployment?" nach dem Deploy
  (`docker compose exec api node -e "console.log(require('./package.json').version)"`).
- Kein `v*` Git-Tag (bestehende Regel): `v0.4.120` in der Meldung bezeichnet
  die **package.json-Version** des Commits, nicht einen Tag.

- `Build-Status` wird **nie** ohne die Verifikation aus dem Build-&-Deployment-
  Abschnitt gefüllt. Ohne den 2-Minuten-Delay + `gh run watch` auf
  `completed success` gilt der Build als `pending verification` — nicht als
  Erfolg. Ein gecrashter Build wird als `FAILED (<conclusion>)` gemeldet, mit
  Ursache aus `gh run view <id> --log-failed`, und **nicht** durch einen
  weiteren Commit kaschiert, sondern offen benannt.
- Ein `push` allein ist **nie** ein Erfolgsbeleg. Wer `pushed` meldet, ohne
  `Build-Status: verified success` (oder `not pushed`) anzugeben, hat gegen
  diese Regel verstoßen.
- Der Agent committed und pusht **nur Dateien, die im aktuellen Auftrag
  geändert oder angelegt wurden**. Dateien mit Pre-existing-Modifikationen
  (z. B. aus einer früheren, nicht abgeschlossenen Sitzung) werden **nicht
  mitgenommen** — sie werden explizit aufgelistet und der User entscheidet.
- Prettier-/`lint:fix`-Auto-Formatierungen in **nicht angefassten Dateien**
  werden mit committet, wenn sie im selben Commit-Lauf anfallen — sonst
  verwirft der Agent sie (`git restore --staged`).
- Untracked Files, die nicht zum aktuellen Auftrag gehören, bleiben
  untracked; der Agent weist explizit darauf hin.
- Nach dem Push bestätigt der Agent die Remote-SHA (`git rev-parse
  origin/<branch>`) und nennt sie in der Abschluss-Antwort.
- Wird der Auftrag ohne Push abgeschlossen (z. B. weil der User keinen
  Push angefordert hat, oder weil er fehlgeschlagen ist), sagt der Agent
  das **explizit** — Stillschweigen ist nicht zulässig.

## End-of-Run Workflow (jeder Lauf)

Am Ende **jedes** Laufs, in dem Code geändert wurde, gilt folgende
verbindliche Reihenfolge:

1. **Commit** — nur Dateien, die im aktuellen Auftrag geändert oder
   angelegt wurden (Conventional Commits, Husky-Hooks beachten).
2. **Push** — `git push origin <branch>`.
3. **Remote-SHA prüfen** — `git rev-parse origin/<branch>` muss
   `git rev-parse HEAD` entsprechen.
4. **Pflicht-Delay 2 Minuten** — in dieser Zeit wird kein Build-Status
   abgefragt und kein Erfolg behauptet (der CI-Workflow braucht Zeit,
   bis der Run in der GitHub-UI existiert).
5. **Build verifizieren** — `gh run list` / `gh run watch <id> --exit-status`
   auf `completed success` warten. Steht dort
   `failure|cancelled|timed_out|startup_failure`, ist der Build
   **gecrasht**: Ursache mit `gh run view <id> --log-failed` melden und
   **keinen** Erfolg verbuchen.
6. **Erfolgsmeldung** — erst nach verifiziertem `completed success` wird
   Erfolg verbucht und ein Deploy empfohlen. Die Meldung enthält zwingend
   den Abschluss-Status inkl. `Version:` (Version des gepushten Commits,
   via `git show <sha>:package.json` gelesen — siehe *Finetuning-Runden —
   Abschluss-Status*).
   Ohne Schritt 5 gilt der Build als `pending verification`, nicht als
   Erfolg.

Ein `push` allein ist **nie** ein Erfolgsbeleg.
