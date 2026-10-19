# castel – Implementierungsplan

Migration der bisherigen PowerApps-/SharePoint-Lösung zu einer **offline-fähigen PWA** auf Basis Vue 3 + Vite + Dexie (IndexedDB), ohne Backend.

> Verbindlich für jede Umsetzungsphase sind die Regeln in [`AGENTS.md`](./AGENTS.md):
> - Bestand = Summe unveränderlicher Buchungen (UUID + Zeitstempel)
> - TypeScript strict
> - `npm run lint` / `npm test` / `npm run build` müssen nach Änderungen grün sein
> - keine Secrets im Code

---

## 1. Ausgangslage (Ist-Stand PowerApps)

Zwei SharePoint-Listen:

- **`Lager`** – aktueller Bestand pro Artikel
  Felder: `ID, Foto, Title, Status, Type, Lieferant, VE, Bestand, Bestand-min, Nachbestellung, Bestellnr., Listenpreis, Geändert`
- **`Warenfluss`** – jede Bewegung als Zeile
  Felder: `Entnahme, Projekt-AA-SA-Nummer, Artikel, Menge, Erstellt, Erstellt-von, Entnommen aus, Artikel:ID, Artikel:Title, Kommentar, Mitteilung an`

Spalten `Entnahme` und `Entnommen aus` deuten auf Typ- und Standortinformation in der Buchungszeile hin.

## 2. Zielbild (Soll-Stand)

| Aspekt | Wert |
|---|---|
| Architektur | **Hybrid**: Offline-fähige PWA (lokal in IndexedDB) **+** zentrales Sync-Backend (Node/PostgreSQL). PWA bleibt offline voll funktionsfähig (Buchen, Inventur, Bilder aufnehmen, Bestand lesen). Sync wenn online. |
| Endgeräte | ca. 10 PWA-Installationen (Android, iOS, Desktop-Browser), jede mit eigenem Login |
| Multi-User | Admin + User, JWT-basierte Auth gegen das Backend, lokaler Session-Cache |
| Zentrale DB | PostgreSQL als Source-of-Truth; PWA-Dexie ist lokaler Cache + Outbox |
| Bestand | lokal **und** server-seitig `Σ buchungen.menge where storno=false` pro (Artikel, Standort) |
| Korrekturen | Storno-Buchung mit `stornoVon`-Verweis, niemals Original überschreiben (lokal + Server) |
| Kommission | echtes Storno + Neubuchung mit korrigiertem Projekt, Bestand bleibt konstant |
| Standorte | flach: `lager \| auto \| baustelle \| extern`, optional mit `projekt` |
| Bilder | Erfassung per Kamera (PWA, `<input type=file capture>` oder `ImageCapture`), komprimiert (≤ 320 kB), Backend speichert im Dateisystem-Volume, signierte URLs zurück |
| Barcode | Kamera-Scan via [`BarcodeDetector`-Web-API](https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API) (Android-Chrome, iOS 17+), Fallback Library (`@zxing/browser`). Wird in Buchungsmaske direkt über Eingabefeld gelegt |
| Sprachen | DE (Default) + EN, Sprachumschalter, `vue-i18n` |
| Deployment | Docker-Compose (PWA-Static, Backend-API, Postgres, Caddy als Reverse-Proxy, optional Cloudflare-Tunnel). Eine `docker compose up` startet alles |
| Build/Lint/Tests | `npm run build` / `lint` / `test` durchgehend grün (Frontend **und** Backend) |

---

## 3. Tech-Stack & Versionen

### Frontend (PWA) — wie bisher
| Paket | Version | Zweck |
|---|---|---|
| `vue` | ^3.5 | UI |
| `vue-router` | ^4.5 | Navigation |
| `pinia` | ^2.3 | State, gespiegelt aus Dexie |
| `vue-i18n` | ^11 | i18n DE/EN |
| `dexie` | ^4 | IndexedDB-Wrapper |
| `papaparse` | ^5 | CSV-Parser für Import |
| `vite` | ^6 | Build/Dev |
| `@vitejs/plugin-vue` | ^6 | SFC-Compile |
| `vite-plugin-pwa` | ^0.21 | PWA-Shell, Service Worker, Manifest |
| `typescript` | ~5.9 | strict |
| `vue-tsc` | ^2.2 | Typecheck für SFCs |
| `eslint` | ^9 + `@vue/eslint-config-typescript` + `eslint-plugin-vue` | Lint |
| `prettier` | ^3.4 | Format |
| `vitest` | ^5 | Tests (Frontend) |
| `@vue/test-utils` | ^2.4 | Component-Tests (optional) |
| `fake-indexeddb` | ^6 | Dexie-Tests im Node-Runner |
| `@zxing/browser` | ^0.1.5 | **Barcode-Scan Fallback** (falls `BarcodeDetector` fehlt) |
| `browser-image-compression` | ^2 | **Bild-Kompression** vor Upload |

### Backend (Monorepo: `server/`)
| Paket | Version | Zweck |
|---|---|---|
| `node` | ≥ 22 LTS | Runtime |
| `fastify` | ^5 | HTTP-Framework (TypeScript-first, schnell, schema-validiert) |
| `@fastify/jwt` | ^9 | JWT-Login, geschützte Routen |
| `@fastify/multipart` | ^9 | Bild-Upload (Foto pro Artikel) |
| `@fastify/cors` | ^10 | CORS für PWA-Domain |
| `@fastify/helmet` | ^12 | HTTP-Header-Härtung |
| `@fastify/static` | ^8 | Auslieferung der gebauten PWA aus `dist/` (optional) |
| `drizzle-orm` + `drizzle-kit` | ^0.36 / ^0.30 | SQL-ORM + Migrationen (TS, typsicher) |
| `postgres` | ^3.4 | Postgres-Driver |
| `argon2` | ^0.41 | Passwort-Hashing (argon2id, besser als PBKDF2) |
| `zod` | ^3.23 | Schema-Validierung der API-Payloads |
| `pino` | — | strukturiertes Logging |
| `dotenv` | ^16 | `.env` laden (siehe §18.4) |
| `vitest` | ^5 | Tests (Backend, gleiche Version wie Frontend) |
| `typescript` | ~5.9 | strict |

### Infrastruktur (Docker-Compose)
| Service | Zweck |
|---|---|
| `pwa` | statisches nginx, das die gebaute PWA (`dist/`) ausliefert |
| `api` | Fastify-Backend |
| `db` | PostgreSQL 16 |
| `caddy` | Reverse-Proxy (TLS, Routing `/api/*` → API, Rest → PWA); alternativ Traefik |
| `cloudflared` | Cloudflare-Tunnel (Quick-Tunnel für Dev, Named Tunnel mit `CLOUDFLARE_TUNNEL_TOKEN` für Prod) |
| `adminer` | optional, DB-Web-UI nur in Dev |

> Anmerkung: Das mit `package.json` ausgelieferte Grundgerüst pinnte u. a. `typescript@~6.0.2`, `vue-tsc@^3.3.11`, `vue-i18n@^10.2.0`, `vite@^8.3.0` – das sind keine stabil verfügbaren Versionen. Wir gehen auf die oben gelisteten, aktuell stabilen Versionen zurück. Das gilt jetzt auch für die Backend-Pakete: bewährte Stable, kein Bleeding-Edge.

---

## 4. Datenmodell (Dexie v1)

Alle Tabellen haben `id: string` (UUID via `crypto.randomUUID()`), Zeitstempel als ISO-8601-UTC. Soft-Delete via `archiviert` (kein Hard-Delete in Domänen-Entitäten).

### 4.1 `artikel`
| Feld | Typ | Quelle | Hinweis |
|---|---|---|---|
| `id` | UUID | neu | **eigener** Schlüssel, SharePoint-`ID` separat |
| `sharePointId` | number \| null | `Lager.ID` | für Migration/Sync |
| `foto` | string \| null | `Lager.Foto` | URL/Pfad |
| `titel` | string | `Lager.Title` | |
| `status` | enum | `Lager.Status` | `verfuegbar \| reserviert \| gesperrt \| ausgesondert` |
| `typ` | string | `Lager.Type` | z. B. „Alarmierung" |
| `lieferant` | string \| null | `Lager.Lieferant` | |
| `verpackungseinheit` | number | `Lager.VE` | |
| `mindestbestand` | number \| null | `Lager.Bestand-min` | |
| `nachbestellHinweis` | enum | `Lager.Nachbestellung` | `i.O \| bald \| dringend \| null` |
| `bestellnummer` | string \| null | `Lager.Bestellnr.` | |
| `listenpreis` | number \| null | `Lager.Listenpreis` | |
| `geaendertAm` | ISO | `Lager.Geändert` | |
| `erstelltAm` | ISO | set-on-create | |
| `archiviert` | boolean | default `false` | |

Indizes: `id, sharePointId, typ, status, archiviert, titel`.

### 4.2 `standorte`
| Feld | Typ |
|---|---|
| `id` | UUID |
| `name` | string (eindeutig) |
| `typ` | `lager \| auto \| baustelle \| extern` |
| `projekt` | string \| null (für `auto`) |
| `kennzeichen` | string \| null (für `auto`) |
| `standard` | boolean (genau ein Hauptlager) |
| `archiviert` | boolean |

Indizes: `id, name, typ, archiviert`.

### 4.3 `buchungen` – das Herzstück, **append-only**
| Feld | Typ | Hinweis |
|---|---|---|
| `id` | UUID | unveränderlich |
| `artikelId` | UUID FK | |
| `standortId` | UUID FK | Quell- oder alleiniger Standort |
| `standortZielId` | UUID \| null | nur bei `umlagerung` |
| `typ` | enum | `einlagerung \| entnahme \| umlagerung \| inventur \| kommission \| storno` |
| `menge` | number (signed) | `inventur` ist **Differenz** (soll − ist) |
| `paarId` | UUID \| null | `umlagerung`: identische `paarId` auf `entnahme` + `einlagerung` |
| `projekt` | string \| null | `Projekt-AA-SA-Nummer` |
| `erstelltAm` | ISO | Buchungsdatum (zeitliche Reihenfolge) |
| `clientEingabeAm` | ISO | Erfassungszeitpunkt in der UI |
| `erstelltVon` | string | Anzeigename (keine Auth) |
| `kommentar` | string \| null | |
| `mitteilungAn` | string \| null | |
| `stornoVon` | UUID \| null | gesetzt auf `storno`-Buchungen |
| `storno` | boolean | schneller Filter |
| `storniertDurch` | UUID \| null | Back-Ref auf Storno-Buchung |

Indizes: `id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId`.

### 4.4 `projekte`
| Feld | Typ |
|---|---|
| `id` | UUID |
| `nummer` | string (z. B. `220405`) |
| `name` | string \| null |
| `archiviert` | boolean |

### 4.5 `einstellungen`
`key, value` (z. B. `sprache: 'de' | 'en'`, `standardStandortId`, `artikelTypen`).

### 4.6 `auditLog` – append-only
`id, aktion, entitaet, entitaetId, daten, zeit` – wird ausschließlich vom Service befüllt.

### 4.7 `outbox` — Sync-Queue (NEU)
Jede Schreiboperation in der PWA läuft **erst** in die lokale DB **und sofort** in eine Outbox. Der Sync-Worker (`src/services/sync/worker.ts`) sendet diese an das Backend. Append-only.

| Feld | Typ | Hinweis |
|---|---|---|
| `id` | UUID | lokal generiert |
| `entity` | `'artikel' \| 'buchung' \| 'standort' \| 'projekt' \| 'foto'` | |
| `op` | `'create' \| 'update' \| 'delete' \| 'upload'` | |
| `payload` | string (JSON) | exakt das, was das Backend bekommt |
| `createdAt` | ISO | Reihenfolge |
| `syncedAt` | ISO \| null | null → noch nicht gesynct |
| `attempts` | number | exponentielles Backoff (1s, 2s, 4s, …, max 5min) |
| `lastError` | string \| null | |

Indizes: `id, syncedAt, createdAt, entity`.

### 4.8 `userCache` — lokaler Spiegel des Login-Users
| Feld | Typ | Hinweis |
|---|---|---|
| `id` | UUID | vom Server |
| `email` | string | |
| `rolle` | `'admin' \| 'user'` | |
| `loginAt` | ISO | für Audit „wer war eingeloggt als …" |

> Beim Logout werden Outbox und Caches nicht gelöscht — nur das JWT. Mehrere Nutzer können sich am selben Gerät nacheinander anmelden (z. B. Tablet im Lager wird geteilt).

### 4.9 Erweiterungen an `artikel` und `buchung`
- `artikel.fotoUrls: string[]` — eine Artikel kann jetzt mehrere Bilder haben (statt `foto: string | null`). Das Legacy-Feld `foto` wird beim Import als erstes Foto übernommen.
- `buchung.serverId: string \| null` — wird beim erfolgreichen Sync gesetzt, damit ein Retry die gleiche Server-Buchung findet (Idempotenz).

### Bestandsformel
```
bestand(artikelId, standortId)
  = Σ buchungen.menge
    WHERE storno = false
      AND (standortId = :s OR (typ='umlagerung' AND standortZielId = :s))
```
(`umlagerung` als „virtuelle Einlagerung" am Ziel – oder über `paarId` auflösen. Variante wird in Domain-Schicht entschieden, Begründung: `entnahme` an Quelle trägt negative Menge, `einlagerung` an Ziel trägt positive Menge, einfache Summe reicht.)

**Auf dem Server** wird dieselbe Formel in einer materialized View (oder als Function `berechne_bestand(art, stand)`) gehalten und bei Bedarf live berechnet. **Wichtig**: Buchungen werden serverseitig gegen den Bestand validiert (insbesondere `entnahme` darf nicht ins Negative gehen), die PWA zeigt nur eine Soft-Warnung.

---

## 5. Domänenschicht (`src/domain/`)

Pure Functions, ohne UI-Abhängigkeit, vollständig unit-testbar. Dexie-Wrapper rufen sie auf, niemals umgekehrt.

### 5.1 Operationen
- `createEinlagerung({artikelId, standortId, menge, projekt?, erstelltVon, kommentar?, mitteilungAn?, erstelltAm?})` – validiert `menge > 0`
- `createEntnahme(...)` – validiert `menge > 0`; Soft-Warnung wenn `bestand < menge` (kein Hard-Lock, da Offline-DAU-Workflow)
- `createUmlagerung({artikelId, vonId, nachId, menge, ...})` – atomar: 2 Buchungen mit gleicher `paarId`
- `createKommission({buchungId, neuesProjekt, erstelltVon, kommentar?})` – Storno + Neubuchung mit neuem Projekt, **Bestand bleibt konstant**
- `createInventur({artikelId, standortId, sollMenge, erstelltVon, kommentar?})` – schreibt `inventur` mit `menge = soll − bestand`
- `stornieren({buchungId, grund, erstelltVon})` – 1 Storno-Buchung mit `stornoVon` und `menge = -original.menge`, setzt `storno=true` und `storniertDurch` am Original
- `getBestand({artikelId, standortId})` und `getBestandProStandort({artikelId})`

### 5.2 Invarianten (Tests verifizieren das)
- Storno einer bereits stornierten Buchung → `BereitsStorniertError`
- Umlagerung mit `vonId === nachId` → `GleicherStandortError`
- Inventur, wenn keine Buchungen existieren → schreibt `inventur` mit `menge = soll`
- Kommission immer 2 Buchungen mit `sum = 0` auf demselben Standort
- `Σ menge where storno=false` ergibt exakt den Bestand
- jede Schreiboperation läuft in einer Dexie-Transaktion (`rw: ['buchungen', 'artikel', 'auditLog']`)

### 5.3 Modulstruktur
```
src/domain/
  buchungen.ts          create*, stornieren
  bestand.ts            getBestand*, Listen
  validierung.ts        reine Validatoren
  errors.ts             BuchungsError-Hierarchie
  __tests__/            Vitest-Specs
  __fixtures__/         Test-Daten
```

---

## 6. Persistenz (`src/services/db.ts`)

Dexie-Klasse, exportiert eine einzige Singleton-Instanz `db`. Schema-Versionierung explizit:

```ts
db.version(1).stores({
  artikel:    'id, sharePointId, typ, status, archiviert, titel',
  standorte:  'id, name, typ, archiviert',
  buchungen:  'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId',
  projekte:   'id, nummer, archiviert',
  einstellungen: 'key',
  auditLog:   'id, aktion, entitaet, entitaetId, zeit'
})
```

Reactive Queries via `liveQuery()` → fließen in Pinia-Stores.

---

## 7. Stores (`src/stores/`)

- `useArtikelStore` – Selektoren, Suche, CRUD
- `useBuchungStore` – CRUD über Domäne, Live-Bestände
- `useStandortStore` – Liste, Standard-Standort
- `useProjektStore`
- `useSettingsStore` – Locale, Benutzer, Default-Standort
- `useAuditStore`

Stores halten **keine** dauerhaften Spiegel, sondern konsumieren `liveQuery` und rufen Domänenfunktionen für Mutationen auf.

---

## 8. Routing (`src/router/`)

| Pfad | Komponente | Zweck | Rolle |
|---|---|---|---|
| `/login` | `LoginView` | E-Mail/Passwort → JWT | public |
| `/` | `DashboardView` | Bestand-Übersicht, „bald nachbestellen", Sync-Status | user+ |
| `/artikel` | `ArtikelListView` | Suche/Filter, Foto-Vorschau | user+ |
| `/artikel/neu` | `ArtikelFormView` | Neuanlage **mit Foto-Upload** | user+ |
| `/artikel/:id` | `ArtikelDetailView` | Bestand je Standort, Historie, „Buchen", Foto-Galerie | user+ |
| `/scan` | `BarcodeScanView` | **Kamera-Barcode-Scan** → Direktbuchung | user+ |
| `/buchungen` | `BuchungListView` | globale Buchungsliste | user+ |
| `/buchung/neu` | `BuchungFormView` | Maske (typ, artikel, standort, menge, …) | user+ |
| `/buchung/neu?barcode=…` | `BuchungFormView` | Deep-Link aus Scanner | user+ |
| `/kommission/:buchungId` | `KommissionView` | Storno + Neubuchung mit Projektwahl | user+ |
| `/inventur/:artikelId?` | `InventurView` | Erfassung Soll-Bestand → Defizit-Buchung | user (nur admin bei Inventur über alle) |
| `/standorte` | `StandortListView` | Hauptlager + Autos verwalten | user+ |
| `/users` | `UserListView` | User anlegen/deaktivieren, Rollen setzen | **nur admin** |
| `/einstellungen` | `SettingsView` | Sprache, Sync-Intervall, Export/Import | user+ |

Jeder Route hat ein `meta.requiresAuth: true` (default) und optional `meta.roles: ['admin']`. Auth-Guard (`beforeEach`) prüft Token und Rolle und routet ggf. zu `/login` oder `/`.

---

## 9. i18n (`src/locales/`)

- `de-DE.json` (Default), `en-US.json`
- Schlüssel hierarchisch (`artikel.list.empty`, `buchung.form.submit`, …)
- Sprachumschalter in AppShell, persistiert in `einstellungen.sprache`
- Initial-Locale aus `einstellungen.sprache`, Fallback `de-DE`

---

## 9a. Authentifizierung & Autorisierung

### Login-Flow
1. PWA zeigt `LoginView` als ersten Screen (vor Dashboard). Es gibt keinen lokalen Bypass — das Login ist **erforderlich**, damit Buchungen einem Benutzer zugeordnet werden können.
2. `POST /api/auth/login { email, password }` → Backend liefert `{ token, user: { id, email, rolle } }`. Passwort-Hash argon2id.
3. JWT wird in `localStorage` (Key `castel.auth.token`) gespeichert; `userCache` in Dexie.
4. Jede API-Anfrage: `Authorization: Bearer <jwt>`. JWT-Lebensdauer 12 h, Refresh-Token (Sliding-Window, 7 d) im httpOnly-Cookie — **bei Docker + Cloudflare-Tunnel unbedingt `SameSite=Lax; Secure; Path=/api/auth`**.
5. Logout invalidiert Refresh-Token serverseitig (DB-Eintrag `refresh_tokens.revoked_at`).

### Rollen
| Rolle | darf |
|---|---|
| `user` | buchen, inventur, artikel lesen, eigene Buchungen stornieren, Standorte/Projekte lesen |
| `admin` | alles von `user` + User-Verwaltung (anlegen, deaktivieren, Rolle wechseln), Artikel anlegen/bearbeiten/löschen, CSV-Import, Storno **jeder** Buchung |

> Hinweis: In **offline**-Phasen prüft die PWA die Rolle lokal nur als UI-Hint (Buttons ausblenden). Die echte Prüfung passiert serverseitig beim nächsten Sync. Stornos/Korrekturen eines `user`, die ein `admin`-Recht bräuchten, werden in der Outbox mit `pending_approval: true` markiert.

### Bootstrap
- Beim ersten Start (`db.users` leer) zeigt die Login-View ein Setup-Formular (Anzeigename + E-Mail + Passwort mit Bestätigung). Das Formular ruft `POST /api/auth/setup` auf, der Endpoint legt den ersten User als Admin an und verweigert sich, sobald bereits ein User existiert (`409 SETUP_DONE`). Anschließend läuft der Login normal über `/api/auth/login`. Es gibt keinen CLI-Bootstrap mehr — die `.env` enthält keine Admin-Credentials.

---

## 9b. Sync-Architektur

### Richtung
- **PWA → Backend**: alle lokalen Mutationen (Outbox). Pull für Read-Aktualisierungen.
- **Backend → PWA**: nichts proaktiv; PWA pullt in Intervallen oder bei `visibilitychange`.

### Endpoints (Server)
| Method | Path | Zweck |
|---|---|---|
| `POST` | `/api/auth/login` | Login → JWT + Refresh |
| `POST` | `/api/auth/refresh` | Refresh JWT |
| `POST` | `/api/auth/logout` | Refresh-Token revoke |
| `GET`  | `/api/sync/snapshot?since=<iso>` | Voll-Snapshot aller Entities, geändert seit `since`. Default `since=1970` für Erstsync. |
| `POST` | `/api/sync/push` | Bulk-Push der Outbox (max. 500 Einträge pro Call). Antwort: `{ accepted: id[], conflicts: { id, reason }[] }` |
| `POST` | `/api/fotos/upload` (multipart) | Bild-Upload zu einem Artikel, antwortet mit `fotoId` + `url` |
| `GET`  | `/api/fotos/:id` | Bild ausliefern (oder signierte URL — siehe §9d) |
| `POST` | `/api/users` (admin) | User anlegen |
| `PATCH`| `/api/users/:id` (admin) | Rolle ändern / deaktivieren |
| `GET`  | `/api/healthz` | Liveness |

### Conflict-Strategie
Wir nutzen die **append-only**-Eigenschaft der Buchungen: jede Buchung hat eine UUID und einen Zeitstempel. Konflikte können nur bei **Artikel-Stammdaten** auftreten (z. B. Admin ändert den Titel, während ein User offline denselben Artikel bearbeitet). Resolution: **Last-Writer-Wins auf `geaendertAm`** (Server-Version gewinnt, lokale Änderung wird verworfen, PWA bekommt die Server-Version im nächsten Pull). Bei Buchungen gibt es **keine** Konflikte — jede UUID ist eindeutig.

### Sync-Worker (`src/services/sync/worker.ts`)
- Läuft in einem `setInterval(15s)` (konfigurierbar in `einstellungen.syncIntervallSek`), zusätzlich bei `online`-Event und bei `visibilitychange`.
- **Push zuerst**, dann **Pull** (so sehen andere Geräte die eigenen Änderungen sofort).
- Backoff bei Fehler: 1s → 2s → 4s → 8s → … bis 5min, Reset bei nächstem Erfolg.
- Wenn ein Push fehlschlägt, weil der User keine Berechtigung hat (403): Eintrag bleibt in Outbox mit `attempts++` und `lastError`, wird nicht verworfen. Admin sieht das in einer separaten Ansicht.

### `useSyncStore` (Pinia)
- `status: 'idle' | 'syncing' | 'offline' | 'error'`
- `pendingCount`, `lastSyncAt`, `lastError`
- Wird in AppShell als Status-Indikator angezeigt (Ampel grün/gelb/rot).

---

## 9c. Barcode-Scan

`src/views/BarcodeScanView.vue` — zentrale Ansicht fürs schnelle Buchen.

### Implementierung
```ts
const supported = 'BarcodeDetector' in window
const formats = ['ean_13', 'ean_8', 'code_128', 'qr_code']
const detector = supported
  ? new BarcodeDetector({ formats })
  : null
// Fallback @zxing/browser lädt dynamisch
```

### Ablauf
1. Kamera öffnen (`getUserMedia({ video: { facingMode: 'environment' } })`)
2. `detector.detect(videoFrame)` alle 200ms in `requestAnimationFrame`
3. Treffer → Vibration (`navigator.vibrate(50)`) + Sound + Direktnavigation in `BuchungFormView` mit `artikelId` (per `bestellnummer` oder neu zu erstellendem Artikel) vorausgefüllt.
4. Falls Artikel nicht gefunden: modaler Dialog „Artikel anlegen oder scannen fortsetzen?".

### Berechtigungen
- HTTPS erforderlich (Cloudflare-Tunnel liefert TLS, localhost in Dev).
- iOS-Standort: PWA muss „添加到主屏幕"-installiert sein, damit Kamera ohne Permission-Prompt-Ausnahmen funktioniert.

---

## 9d. Bilder

### Capture-Flow (`src/views/ArtikelFormView.vue` + `ArtikelDetailView.vue`)
- `<input type="file" accept="image/*" capture="environment" multiple>` öffnet Kamera oder Datei-Picker.
- `browser-image-compression` komprimiert clientseitig auf `maxSizeMB: 0.3, maxWidthOrHeight: 1280`.
- Vorschau sofort lokal in Dexie (Base64 in `artikel.fotoUrls` als Übergang), dann Upload:
  1. Datei in `FormData`, `POST /api/fotos/upload` mit `artikelId` + `Authorization`.
  2. Server speichert unter `/var/lib/castel/fotos/<artikelId>/<uuid>.<ext>` (Volume `fotos-data`).
  3. Server trägt `fotos`-Zeile in DB ein, liefert `{ id, url }`.
  4. PWA ersetzt Base64 durch die URL, schreibt in Outbox (damit Artikel-Sync konsistent bleibt).
- Fallback ohne Backend (offline): Base64 bleibt, wird beim nächsten Sync hochgeladen (Migration zu URL im Hintergrund).

### Server liefert Bilder
- Direkt aus Fastify (`@fastify/static`, Route `/fotos/*`, Cache-Control 7d).
- Hinter Cloudflare-Tunnel wird `/fotos/` gecached → bei 10 Geräten kein doppelter Traffic.

---

## 9e. Backend-Layout (Monorepo)

```
castel/
├── src/                  # PWA (Vue)
├── server/               # Backend
│   ├── src/
│   │   ├── index.ts      # Server-Bootstrap
│   │   ├── config.ts     # ENV → typed config
│   │   ├── db/
│   │   │   ├── schema.ts       # Drizzle Schema
│   │   │   ├── migrations/     # SQL-Migrationen
│   │   │   └── client.ts
│   │   ├── auth/
│   │   │   ├── routes.ts       # login, refresh, logout
│   │   │   ├── jwt.ts
│   │   │   └── middleware.ts   # requireAuth, requireRole('admin')
│   │   ├── sync/
│   │   │   ├── routes.ts       # snapshot, push
│   │   │   └── resolver.ts     # Konfliktauflösung
│   │   ├── fotos/
│   │   │   └── routes.ts
│   │   ├── users/
│   │   │   └── routes.ts
│   │   └── domain/
│   │       ├── bestandsformel.ts   # Σ menge (lokal auf Server)
│   │       └── validierung.ts
│   ├── drizzle.config.ts
│   ├── package.json
│   └── tsconfig.json
├── docker-compose.yml
├── docker-compose.dev.yml  # overrides mit adminer, Mailhog
├── Caddyfile
└── .env.example
```

### Wichtige Server-Regeln
- **Kein Auto-Delete, kein Hard-Delete** — Storno/Korrektur nur via Buchungen (gleiche Domänenregel wie PWA).
- **Buchungs-Validierung serverseitig**:
  - `entnahme` darf Bestand nicht negativ machen → 422 `NEGATIVE_BESTAND` mit `currentBestand`.
  - `inventur` darf nur von `admin` durchgeführt werden (bzw. vom `user`, wenn in Settings `inventurFuerUserErlaubt=true`).
- **Idempotenz**: Push verarbeitet `(clientId, entity)` Paare; Dubletten (gleiche UUID) werden mit HTTP 200 + `{ duplicate: true }` quittiert.
- **Audit-Log** wird serverseitig in `audit_log` mitgeschnitten (für Forensik, nicht nur lokal).

---

## 9f. Docker-Compose

### `docker-compose.yml`
```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: castel
      POSTGRES_USER: castel
      POSTGRES_PASSWORD: ${DB_PASSWORD}   # aus .env
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U castel -d castel"]
      interval: 5s

  api:
    build: { context: ., dockerfile: server/Dockerfile }
    environment:
      DATABASE_URL: postgres://castel:${DB_PASSWORD}@db:5432/castel
      JWT_SECRET: ${JWT_SECRET}
      ADMIN_EMAIL: ${ADMIN_EMAIL}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      FOTOS_DIR: /var/lib/castel/fotos
    volumes:
      - fotos-data:/var/lib/castel/fotos
    depends_on:
      db: { condition: service_healthy }

  pwa:
    image: nginx:alpine
    volumes:
      - ./dist:/usr/share/nginx/html:ro
    depends_on: [api]

  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [pwa, api]

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on: [caddy]

volumes:
  pgdata:
  fotos-data:
  caddy-data:
  caddy-config:
```

### `Caddyfile`
```
castel.example.com {
    reverse_proxy pwa:80
    reverse_proxy /api/* api:3000
    reverse_proxy /fotos/* api:3000
    encode gzip zstd
}
```

### Reverse-Proxy-Modi
1. **Cloudflare-Tunnel** (Standard): nichts im Internet exponieren außer `cloudflared`. Vorteil: kein offener Port, keine eigene TLS-Pflege, IP-Spoofing-Schutz kostenlos.
3. **Eigener Reverse-Proxy** (Fallback): Caddy mit Let's Encrypt, Port 80/443 am eigenen Server. Identische Caddyfile-Konfiguration.

### `.env.example`
```
DB_PASSWORD=bitte-ändern
JWT_SECRET=openssl rand -hex 32
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=bitte-ändern
CLOUDFLARE_TUNNEL_TOKEN=
```
Datei **nie** committen — siehe §18.4 (Secrets).

---

## 10. PWA (`vite-plugin-pwa`) & Auth-Guard

- `registerType: 'autoUpdate'`
- Manifest: Name „castel", `display: 'standalone'`, Icons (eigene Platzhalter, aus Vite-Logo wird eine monochrome Variante)
- Workbox-Strategie: App-Shell `precache`, Bilder (`/fotos/*`) `StaleWhileRevalidate` mit `maxEntries: 200, maxAgeSeconds: 60d`. Eigene User-Daten werden **nicht** im SW gecached (Auth-Token lebt im localStorage).
- Offline-Indikator in der AppShell (jetzt zusätzlich: Sync-Status aus §9b)
- **Auth-Guard** in `src/router/index.ts`: jeder Pfad außer `/login` verlangt gültigen Token. Bei 401 aus API → automatischer Re-Login-Screen.
- Service-Worker bekommt Version-Bump → erzwingt Logout-Cache-Reset.

---

## 11. CSV-Import-Wizard (`src/services/import/`)

Voraussetzung: Du lieferst die vollständigen CSVs (oder Beispieldatensätze).

Flow:
1. **Datei wählen** → `papaparse` parst (Encoding, `;` vs `,`, Quotes)
2. **Vorschau** – erste 20 Zeilen, erkannte Spalten
3. **Mapping-UI** – SharePoint-Spalte → Dexie-Feld
4. **Validierung** – Pflichtfelder, Status/Type-Enum-Mapping, doppelte `sharePointId`
5. **Bestandsabgleich** – Vorschau-Vergleich `Lager.Bestand` gegen aus dem Warenfluss rekonstruierten Bestand; Konfliktliste zur Klärung
6. **Atomarer Import** in einer Dexie-Transaktion; bei Fehler vollständiger Rollback
7. **Ergebnis-Report** – importiert / übersprungen / Konflikte

Export analog als JSON (voll) und CSV (Buchungen je Standort) für Backup.

---

## 12. Tests (`vitest`)

### Frontend (Pflicht-Unit-Tests in `src/domain/__tests__/`)
- **Summen-Property** (Kernregel aus AGENTS.md): Beispieldatensätze, Bestand == Summe, alle Buchungstypen
- **Storno-Eindeutigkeit**: Original darf nicht zweimal storniert werden, Storno- und Original-Buchung koppeln sauber
- **Kommission**: genau 2 Buchungen, `Σ menge = 0` auf Standort, neues `projekt` sichtbar
- **Umlagerung**: genau 2 Buchungen, gleiche `paarId`, Quellbestand sinkt, Ziel steigt
- **Inventur**: `menge = soll − bestand`, danach Summe == Soll
- **Edge Cases**: Negativmengen, fehlende Pflichtfelder, unbekannte IDs → werfen definierte Errors
- **CSV-Parser** mit den mitgelieferten CSVs als Fixture
- **Outbox**: Reihenfolge wird gewahrt, Failed-Push bleibt mit Backoff in der Queue
- **Sync-Worker** (Mock-Fetch): Push akzeptiert, Pull aktualisiert Dexie, Conflict-Resolution `Last-Writer-Wins`

### Backend (`server/src/__tests__/`)
- **Auth**: Login liefert JWT, falsches Passwort → 401, abgelaufenes Token → 401, Refresh → neues JWT, Logout → 204
- **Rollen**: `user` darf keine User-Verwaltung treffen → 403
- **Bestands-Endpoint**: `berechne_end` spiegelt PWA-Logik, gleiche Test-Fixtures
- **Push**: Bulk-Push verarbeitet, Duplikate werden als `{ duplicate: true }` quittiert (Idempotenz)
- **Pull/Snapshot**: nur Entities mit `geaendertAm > since` zurück, korrekte ISO-Sortierung
- **Negative-Bestand-Schutz**: `POST /api/sync/push` mit `entnahme` über Bestand → 422 `NEGATIVE_BESTAND`
- **Foto-Upload**: multipart-Datei landet im Volume, URL wird zurückgegeben
- **Inventur nur admin** (oder je nach Setting)

Test-Setup mit `fake-indexeddb` fürs Frontend und `pg-mem` (oder echtes Test-Postgres via `docker compose run db`) fürs Backend. **Keine** Test-DB in der Produktiv-DB — separate `DATABASE_URL` in `.env.test`.

---

## 13. Sicherheit

- **JWT-Secret** (`JWT_SECRET`) und alle Passwörter **nur** in `.env` (nicht eingecheckt).
- `.env.example` enthält Platzhalter mit Kommentaren, **nie** echte Werte.
- Passwort-Hashing serverseitig: argon2id (default-Parameter aus dem `argon2`-Paket).
- Refresh-Tokens in httpOnly-Cookie, `SameSite=Lax; Secure; HttpOnly`. JWT nur im localStorage (PWA-Komfort), mit kurzer Lebensdauer (12 h).
- Rate-Limit auf `/api/auth/login` (`@fastify/rate-limit`, 5/min/IP) gegen Brute-Force.
- Helmet-Header gegen XSS, Clickjacking, MIME-Sniffing.
- CORS: nur die eigene PWA-Domain (`CORS_ORIGIN` aus `.env`). Hinter Cloudflare-Tunnel ist die Domain klar definiert.
- `git status`/`git diff` vor jedem Commit: keine `.env`, keine Tokens, keine Test-Passwörter.
- `npm audit` im CI: bei `high`/`critical` blocken.

---

## 14. Reihenfolge der Umsetzung

> Die Schritte 1–9 sind bereits erledigt (siehe §17). Neu ab Schritt 10.

10. **Backend-Monorepo anlegen** — `server/` mit eigener `package.json`, `tsconfig.json`, Fastify-Bootstrap, Healthz-Endpoint. `npm run dev` startet beides (PWA + API) parallel.
11. **Datenbank & Migrationen** — Drizzle-Schema (`users`, `refresh_tokens`, `artikel`, `standorte`, `buchungen`, `projekte`, `fotos`, `audit_log`), Migrationen generieren, `db:migrate`-Skript.
12. **Auth-Backend** — Login/Refresh/Logout, JWT-Helper, `requireAuth`/`requireRole`-Middleware, Rate-Limit. **Tests** für Login-Flow.
13. **Bootstrap-Admin via PWA-Setup** — `GET /api/auth/setup-status` + `POST /api/auth/setup`. LoginView zeigt das Setup-Formular, wenn `users` leer ist.
14. **Docker-Compose-Grundgerüst** — `docker-compose.yml` mit `db`, `api`, `pwa`, `caddy`. Lokal `docker compose up` startet alles. Volumes, Healthcheck.
15. **Caddyfile + Cloudflare-Tunnel** — Reverse-Proxy konfigurieren, `cloudflared`-Service, `.env.example`.
16. **PWA-Auth** — `LoginView`, `useAuthStore`, Auth-Guard im Router, Token-Storage, Auto-Logout bei 401.
17. **Outbox + Sync-Worker** — `outbox`-Tabelle, `useSyncStore`, `services/sync/worker.ts` (Push/Pull, Backoff), Tests mit Mock-Fetch.
18. **Sync-Endpoints** — `GET /api/sync/snapshot`, `POST /api/sync/push` (Idempotenz, negative-Bestand-Schutz), Tests.
19. **Foto-Upload** — `multipart`-Route, lokales Volume, URL-Rückgabe, clientseitige Kompression.
20. **Barcode-Scan** — `BarcodeScanView`, `BarcodeDetector` + `@zxing/browser`-Fallback, Deep-Link auf `/buchung/neu?barcode=…`.
21. **Rollenprüfung in UI** — Buttons ausblenden für `user`, Inventur nur admin (oder per Setting).
22. **User-Verwaltung** — `UserListView`, `POST /api/users`, `PATCH /api/users/:id` (admin-only).
23. **End-to-End-Test** — Zwei Browser-Fenster mit unterschiedlichen Logins, offline Buchen, online Sync, beide sehen den neuen Bestand.
24. **Feinschliff** — README mit Setup-Anleitung (Docker + Tunnel), Build/Lint/Tests grün (Frontend **und** Backend), `npm audit` clean.
25. **Mindestbestand-Push** (PLAN-Update 2026-10-19) — Server-Resolver schreibt `mindestbestand_ereignisse` bei jeder Buchung, die einen Artikel unter seinen Mindestbestand drückt. PWA zeigt die Events im Glocken-Panel (Admin-only) und in `/einstellungen/mindestbestand`. Optionaler SMTP-Notification-Gateway ist als Skeleton vorbereitet (LogNotificationGateway aktiv, SmtpNotificationGateway wirft `not implemented`). Notification-API-Permission wird beim Mount der Glocke einmalig erfragt (nur solange PWA offen — kein Web-Push). Trigger-Regel: "bei jeder Unterschreitung" (User-Entscheidung); Storno/Kommission lösen kein Event aus; Umlagerung prüft nur Quellstandort.

---

## 15. Benötigte Eingaben vom Auftraggeber

- **Vollständige CSVs** `Lager.csv` und `Warenfluss.csv` (oder Beispieldatensätze, falls der Rest nicht herausgegeben werden soll)
- Optional: **Logo/Farbschema** für PWA-Icons, App-Farbe, Splash
- Optional: echte **Projekt-Stammdatenliste** (oder wachsen sie aus den Buchungen heraus?)
- **Admin-Credentials** für Erst-Bootstrap (`ADMIN_EMAIL`, `ADMIN_PASSWORD`) — kommen in `.env`, nicht ins Repo
- **Cloudflare-Tunnel-Token** (`CLOUDFLARE_TUNNEL_TOKEN`) — Account-spezifisch
- **DB-Passwort** (`DB_PASSWORD`) — pro Instanz, nicht eingecheckt

---

## 16. Offene Punkte / Risiken

- **Versions-Konflikt TypeScript**: das mitgelieferte Grundgerüst pinnte nicht-existente Versionen. Wir gehen auf stabile Releases zurück; bei späterer Migration auf TS 6 / vue-tsc 3 erneut prüfen.
- **Datenverlust bei Migration**: kein automatischer Sync zurück nach SharePoint geplant; Export als JSON-Backup ist Pflicht.
- **Sync-Konflikte bei Artikel-Stammdaten**: zwei Geräte ändern denselben Artikel offline → Last-Writer-Wins auf `geaendertAm`. Verlorene Arbeit möglich. Mitigation: Admin zentralisiert Stammdaten-Pflege, User dürfen nur Buchungen + Notizen.
- **JWT im localStorage**: ein XSS-Angriff könnte das Token stehlen. Mitigation: strikte CSP (`script-src 'self'`), keine Inline-Eval, Helmet-Header, kurze Lebensdauer (12 h).
- **Negative-Bestand-Schutz nur online**: bei Offline-Buchungen kann kurzzeitig der Bestand negativ werden. Server korrigiert das beim Push (422 `NEGATIVE_BESTAND`). Die PWA muss den Fehler klar anzeigen und einen Korrektur-Storno anbieten.
- **Bild-Speicher wächst**: kein Auto-Resize/Compression am Server. Mitigation: clientseitige Kompression (320 kB), max. 5 Bilder pro Artikel.
- **Backup**: Postgres-Volume (`pgdata`) muss extern gesichert werden — kein PITR out-of-the-box. Für Produktiv: `pg_dump` Cron oder WAL-Archivierung in separatem Container.
- **Cloudflare-Tunnel = SPOF**: bei Cloudflare-Ausfall keine Verbindung. Fallback: eigener Reverse-Proxy (Caddy mit Let's Encrypt) als Backup-Variante.

---

## 17. Aktueller Bearbeitungsstand

> Stand 2026-10-14 — nach Vorgaben-Update auf Multi-User + zentrales Backend.

### PWA (Frontend) — abgeschlossen
| Schritt | Status | Notiz |
|---|---|---|
| Plan | ✅ fertig | dieses Dokument |
| Schritt 1 (Tooling/Skripte) | ✅ fertig | ESLint-Flat, Prettier, Vitest, `tsconfig` strict (`noUncheckedIndexedAccess`, `noImplicitOverride`), Skripte (`lint`, `lint:fix`, `format`, `test`, `test:run`, `typecheck`, `build`) |
| Schritt 2 (Dependencies) | ✅ fertig | stable Releases; nach Audit-Major-Sprung: `vitest@5`, `@vitest/coverage-v8@5`, `eslint-plugin-vue@10`. `vue-i18n` v11, `vue-tsc` v2.2, `vite` v6, `typescript` ~5.9. |
| Schritt 3 (Dexie-Schema) | ✅ fertig | `CastelDb` mit `version(1).stores(...)`, Singleton-Getter, Test-Reset-Helfer |
| Schritt 4 (Domain + Tests) | ✅ fertig | `createEinlagerung/Entnahme/Umlagerung/Kommission/Inventur`, `stornieren`, `berechneBestand*`; 16 Unit-Tests (Vitest 5 + `fake-indexeddb`) |
| Schritt 5 (PWA) | ✅ fertig | `vite-plugin-pwa` mit `autoUpdate`, Manifest, Workbox (precache, CacheFirst für Bilder 60/30d, Navigation-Fallback), SVG-Icon, Offline-Indikator in AppShell |
| Schritt 6 (Stores/Router) | ✅ fertig | Pinia-Stores (`artikel`, `standort`, `buchung`, `projekt`, `settings`, `audit`) mit `liveQuery`; vue-Router mit 8 Pfaden + Catch-all |
| Schritt 7 (i18n + UI) | ✅ fertig | vue-i18n v11 (de-DE, en-US), typsichere Schlüssel; 9 Views (Dashboard, Artikel-Liste/-Form/-Detail, Buchungs-Liste/-Form, Kommission, Standorte, Settings) + Offline-Banner in AppShell |
| Schritt 8 (CSV-Import) | ✅ fertig | Wizard (`ImportView`), Parser, Mapping-Heuristik, Validierung, atomarer Import, JSON-Backup; 9 zusätzliche Tests (gesamt 25) |
| Schritt 9 (Auth-Modul) | ✅ fertig | `src/auth/{users,crypto,policy,session,errors}.ts` existiert (PBKDF2, Security-Question). Wird durch Backend-Implementation auf argon2 + Server-Session migriert. |
| Final (lint/test/build) | ✅ grün | `lint`: 0 errors/0 warnings, `typecheck`: 0 errors, `test:run`: 25/25, `build`: grün, PWA-SW generiert |

### Backend / Multi-User / Sync (neu) — **offen**
| Schritt | Status | Notiz |
|---|---|---|
| Schritt 10 (Backend-Monorepo) | ✅ fertig | Fastify + TS, `server/`-Ordner |
| Schritt 11 (DB + Migrations) | ✅ fertig | Drizzle + Postgres 16 |
| Schritt 12 (Auth-Backend) | ✅ fertig | Login/Refresh/Logout, argon2, JWT |
| Schritt 13 (Bootstrap-Admin) | ✅ fertig | via PWA-Setup-Formular |
| Schritt 14 (Docker-Compose) | ✅ fertig | Images aus GHCR, `db`, `api`, `pwa`, `migrate` |
| Schritt 15 (Tunnel) | ✅ fertig | Caddyfile + `cloudflared` |
| Schritt 16 (PWA-Auth) | ✅ fertig | LoginView, `useAuthStore`, Router-Guard |
| Schritt 17 (Outbox + Sync-Worker) | ✅ fertig | Push/Pull, Backoff, Marker |
| Schritt 18 (Sync-Endpoints) | ✅ fertig | Snapshot + Push + Mindestbestand-Events |
| Schritt 19 (Foto-Upload) | ✅ fertig | multipart, Volume-Speicher |
| Schritt 20 (Barcode-Scan) | ✅ fertig | `BarcodeScanView`, ZXing-Fallback |
| Schritt 21 (Rollenprüfung) | ✅ fertig | UI + Server |
| Schritt 22 (User-Verwaltung) | ✅ fertig | `UserVerwaltungView` |
| Schritt 25 (Mindestbestand-Push) | ✅ fertig | Server-Trigger, PWA-Glocke + Panel, Mail-Gateway-Skeleton |
| Schritt 23 (E2E-Test) | ⏳ offen | zwei Browser, offline + online |
| Schritt 24 (Feinschliff) | ⏳ offen | README, `npm audit` clean |

### Verbleibende Audit-Vulnerabilities

`npm audit` zeigt nach den Major-Sprüngen **4 high** (`brace` Stack-DoS, transitiv über `braces`/`micromatch`/`fast-glob` in `@vue/eslint-config-typescript`). Es gibt **keine** critical-RCE-Funde mehr (tinypool-RCE wurde durch `vitest@5` behoben). Die verbleibenden Funde sind rein im Lint-Dev-Stack und nicht in der App-Laufzeit erreichbar. Fix nur durch Major-Sprung auf eine zukünftige `@vue/eslint-config-typescript`-Version.

### Bereits durchgeführte Änderungen am Repo

- `package.json` – Skripte ergänzt, Dependencies aktualisiert, `name` → `castel`, `version` → `0.1.0`
- Tooling-Konfigs: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`, `vitest.setup.ts` (`fake-indexeddb/auto`)
- `tsconfig.app.json` – strict + `noUncheckedIndexedAccess` + `noImplicitOverride`
- `vite.config.ts` – `VitePWA` mit Manifest + Workbox
- `public/pwa-icon.svg`, `index.html` mit `theme-color`/Apple-Touch
- `src/db/{database,types}.ts` – Dexie v1-Schema, Singleton-Getter
- `src/domain/{buchungen,bestand,errors,ids,validierung}.ts` – Domain-Operationen + Errors-Hierarchie
- `src/services/import/{csv-parser,mapping,validierung,import,export}.ts` – CSV-Import-Pipeline + JSON-Backup
- `src/stores/{artikel,standort,buchung,projekt,settings,audit}.ts` – Pinia-Stores mit `liveQuery`
- `src/router/index.ts` – 8 Routen + Catch-all
- `src/views/*.vue` – DashboardView, ArtikelListView, ArtikelFormView, ArtikelDetailView, BuchungListView, BuchungFormView, KommissionView, StandortListView, SettingsView, ImportView
- `src/locales/{de-DE,en-US}.ts`, `src/locales/i18n.d.ts` – Übersetzungen + typ-sichere Schlüssel
- `src/{App.vue,main.ts,i18n.ts,vite-env.d.ts}` – App-Shell + PWA-Registrierung + i18n + Types
- `src/auth/{users,crypto,policy,session,errors}.ts` – lokales Auth-Modul (PBKDF2, Security-Question); Tests in `src/auth/__tests__/`. Wird in §9a durch Backend-Auth ersetzt.
- Tests: `src/__tests__/smoke.test.ts`, `src/domain/__tests__/buchungen.test.ts` (16), `src/services/import/__tests__/import.test.ts` (9)

**Diese Änderungen sind committed noch nicht** (lt. AGENTS.md-Regel „nur auf explizite Aufforderung committen").
