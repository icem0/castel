# AGENTS

Regeln für alle Coding-Agents und Entwickler, die an diesem Projekt arbeiten.

## Architektur

- **Web-App / PWA** – läuft im Browser, installierbar, offline-fähig.
- **Offline-first** – die App funktioniert ohne Netzverbindung. Synchronisation, falls später nötig, ist explizit als Feature zu planen.
- **Lokale Datenbank im Browser** – alle Daten werden lokal persistiert (IndexedDB via Dexie o. ä.). Kein Backend erforderlich.

## Datenmodell

- **Bestand ist die Summe von Buchungen.** Es gibt keine überschreibenden Mengenupdates.
- Jede Buchung hat eine **UUID** (kein auto-increment, keine laufende Nummer) und einen Zeitstempel.
- Buchungen sind unveränderlich. Korrekturen erfolgen durch Storno- oder Gegenbuchungen.

### Konfiguration vs. Einstellungen

Klar trennen — beides kommt **nicht** zusammen in der DB ab:

- **Konfiguration** (App-weit, ENV, beim Container-Start): `JWT_SECRET`, `CORS_ORIGIN`, `FOTOS_MAX_BYTES`, `RATE_LIMIT_*`, `LOG_LEVEL`, `COOKIE_*`, `DB_*`. Wird vom API-Container aus der `.env` gelesen, lebt nicht in PostgreSQL.
- **Postgres-Loglevel**: `PG_LOG_LEVEL` in der `.env` (Postgres-GUC `log_min_messages`, Werte `debug5`..`panic`). Wenn leer, wird aus `LOG_LEVEL` gemappt (`trace→debug2`, `debug→debug1`, `info→info`, `warn→warning`, `error→error`); Default ohne beide: `warning`. Bei `debug*/info/notice` aktiviert der `db.command:` in `docker-compose.yml` zusätzlich `log_statement=all` + `log_duration=on` → **jedes** SQL-Statement landet im Log. Nur zum Debuggen setzen, danach wieder auf `warning`/`error` (Log-Flut!).
- **Einstellungen** (User-/Fach-Präferenzen, änderbar zur Laufzeit, Cross-Device-synchronisiert): `artikelTypen` (global, Admin-only), `sprache` und `standardStandortId` (per-User). Liegen in der `einstellungen`-Tabelle (PK = `(key, user_id)`), LWW auf `geaendert_am`. Die PWA spiegelt sie zusätzlich in IndexedDB (Dexie v5, Compound-Key `[key+userId]`, `userId = ''` als globaler Marker — Domäne arbeitet mit `null`).
- **Persistenz**: `einstellungen` läuft über das `pgdata`-Volume des API-Containers, nicht über ein eigenes Volume. Backups via `pg_dump`.

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
  - `npm test`
- Build muss sauber durchlaufen: `npm run build`.

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
- **Alles läuft in-process im API-Service** (kein Host-Skript, kein Cron, kein SSH). Das API-Image bringt `postgresql-client` (für `pg_dump`/`pg_restore`) und `archiver` (npm) mit. Die Volumes `pgdata`, `fotos-data` und `backups-data` sind named Volumes aus `docker-compose.yml`; sie sind vom externen Snapshot/Borg des Deployers unabhängig.
- **Drei Wege zum Backup** (alle admin-only):
  1. **Sofort-Download** — `POST /api/admin/backup/download`. Streamt das ZIP als Response.
  2. **Datei im Server speichern** — `POST /api/admin/backup/run`. Schreibt nach `BACKUP_DIR` (`/var/lib/castel/backups`, Volume `backups-data`).
  3. **Cronjob** — `GET/PUT /api/admin/backup/settings` (Schedule = HH:MM, Keep-Copies = 1–365). Der Server-Cron (`server/src/admin/backup-cron.ts`) tickt jede Minute und feuert genau einmal pro Tag zur eingestellten Zeit, rotiert nach `keepCopies`.
- **Ablauf pro Backup** (sync-first):
  1. `POST /api/admin/sync/all` setzt `sync.forceAt`-Marker in `einstellungen`.
  2. Polling auf `GET /api/sync/status`, bis `buchungen`-Count stabil ist. **Zwei Zeitfenster**: Die HTTP-Endpoints `download`/`run` warten kurz (2 s Ruhe / 15 s Cap — nginx im PWA-Container killt Proxy-Requests nach 60 s, und der Sync-Worker pusht ohnehin alle 30 s). Der Cron nutzt die vollen Config-Defaults `BACKUP_SYNC_QUIET_MS` (8 s) / `BACKUP_SYNC_TIMEOUT_MS` (120 s).
  3. `pg_dump -Fc` → Custom-Format-Dump.
  4. `FOTOS_DIR` → `fotos/` (Artikel-IDs als Unterordner).
  5. `manifest.json` (`schema: 'castel-backup-1'`) + ZIP via `archiver`.
- **Restore**: `POST /api/admin/backup/restore` mit `{ name, confirm: 'yes' }` — der Server entpackt das ZIP in tmpdir, ruft `pg_restore --clean --if-exists --single-transaction` und kopiert die Fotos zurück. **Vorbedingung**: API-Service muss gestoppt sein (Admin-Disziplin, kein Auto-Stop).
- **Manifest-Schema**: `castel-backup-1`. Unbekannte Schemata werden verweigert.
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
- **GHCR-Token**: Für private Pakete braucht der Deployer einen GitHub-PAT mit Scope `read:packages`. Bare Docker / Coolify: `docker login ghcr.io`. Arcane: einmalig `POST /container-registries` mit dem PAT. Für öffentliche Pakete reicht kein Token.
- **GHCR-Visibility-Automation**: `build-and-push.yml` ruft am Ende jedes Jobs `PATCH /user/packages/container/{pkg}` mit `{"visibility":"public"}`. Der automatische `GITHUB_TOKEN` darf das für User-Repos **nicht** (gibt 404). Lösung: klassischen PAT mit Scopes `repo` + `write:packages` unter dem Secret-Namen **`GHCR_ADMIN_TOKEN`** im Repo hinterlegen (`Settings → Secrets and variables → Actions`). Ohne Secret wird der Flip mit `::warning::` übersprungen — das Image wird trotzdem gepusht, das Paket bleibt aber `private`. Für server-seitige Pulls reicht das (Auth gegen `ghcr.io` via `docker login` bzw. Coolify-/Arcane-Registry-Config). Wer das Paket wirklich öffentlich haben will, legt den Secret an, der Flip läuft dann automatisch.
- **Arcane / Coolify / bare Docker** funktionieren ohne Anpassung — sie alle ziehen `image:`-Referenzen transparent. Der frühere `build:`-Pfad ist absichtlich entfernt.
- **Update-Workflow**: `git pull && docker compose pull && docker compose up -d` (nicht `--build` — es gibt nichts Lokales zu bauen).
- **Deploy-Falle DEV_MODE / DB-Volume-Reset.** Symptom: nach einem Deploy antwortet die API mit `401 USER_INACTIVE` („User ist deaktiviert"), die PWA springt auf den First-Register-Screen. Bedeutung: die `users`-Tabelle ist **leer** — der API-Container hat beim Start truncatiert (`server/src/dev/dev-reset.ts`) oder das DB-Volume wurde zurückgesetzt. Ursachen: `DEV_MODE=true` in der `.env` (jeder Container-Start = TRUNCATE aller Tabellen) oder Override-File / `docker compose down -v` / `castel-restart.ps1` im Livebetrieb. Fix: `DEV_MODE=false` setzen, Stack neu starten, Admin über das Setup-Formular neu anlegen. **Das ist KEIN Backup-Bug** — `POST /api/admin/backup/run` ist nur der erste Request, bei dem der 401 sichtbar wird. Diagnose: `docker compose logs api` nach `[dev-reset] TRUNCATE` durchsuchen.
- **Lockfiles pro Paket**: `package-lock.json` im Root (PWA), `server/package-lock.json` (API). Beide müssen in ihrem jeweiligen Verzeichnis für `npm ci` liegen — beim CI-Build übernimmt das `working-directory` bzw. `cache-dependency-path`.

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

Siehe `README.md` → „Lokales Test-Setup" für die Erstinstallation
(Docker Desktop, WSL 2, `.env`, `docker-compose.override.yml`).

## Finetuning-Runden — Abschluss-Status

Jede Finetuning-Runde (Bereich 1–N) endet mit einem klaren **Commit-und-Push-Status**
in der letzten Antwort des Agents an den User. Das Format ist verbindlich:

```
Commit-Status: committed <hash> | not committed | partially committed
Push-Status:   pushed to origin/<branch> | not pushed | rejected (<Grund>)
Build-Status:  verified success | FAILED (<conclusion>) | not pushed | pending verification
```

**Regeln:**

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
