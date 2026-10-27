<div align="center">

[English](./README.md) · [**Deutsch**](./README.de.md)

<img src="public/castel-logo.png" width="120" alt="castel-Logo"><br/>
# castel

**Offline-fähige Lagerverwaltung als PWA – Multi-User, append-only, einsatzbereit.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3.5-42b883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Node 22](https://img.shields.io/badge/Node-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000?logo=fastify)](https://fastify.dev/)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org/)

Mobile-First-Lager für Werkstatt und Baustelle. Funktioniert offline, synct wenn online.
10+ Geräte, JWT-Auth, Barcode-Scan, Foto-Erfassung, Inventur mit Defizit-Buchung,
A4-Etiketten, Mindestbestands-Alarme und DATANORM-Katalogimport.

[Features](#-features) • [Installation](#-installation-nur-docker-compose) • [Architektur](#-architektur) • [Deployment](#-deployment) • [Agenten-API](#-agenten-api--mcp) • [Entwicklung](#-entwicklung) • [Mitmachen](#-mitmachen)

</div>

---

## 📦 Features

| | |
|---|---|
| 📱 **Offline-First** | IndexedDB-Cache (Dexie). Alle Buchungen sind ohne Netz möglich – der Sync-Worker pusht automatisch, sobald die Verbindung wieder steht. |
| 🔄 **Multi-User-Sync** | ca. 10 Geräte syncen über einen zentralen Server (Node + Fastify + Postgres 16). Outbox mit Quarantäne für dauerhaft abgelehnte Änderungen. |
| 👥 **Rollen** | Admin verwaltet User, Stammdaten und Backups; User bucht, inventuriert und scannt. |
| 📊 **Dashboard** | KPIs, Warenbewegungen, Lagerwert und Handlungsbedarf für 7/30/90 Tage. |
| 📷 **Barcode-Scan** | Kamera-Scan via `BarcodeDetector` (Web-API) mit ZXing-Fallback für schnelles Buchen. |
| 🏷️ **Etiketten** | Einzel-Etiketten sowie DIN-A4-Bögen als PDF (21er/30er/12er/8er, Liste oder eigenes Layout), inkl. „neu“-Markierung für frisch angelegte Artikel. |
| 📸 **Foto-Erfassung** | Bilder pro Artikel, clientseitig komprimiert, im Backend-Dateisystem gespeichert. |
| 📦 **Bestandsformel** | `Σ Buchungen where storno = false` — append-only, immer korrekt, nie überschrieben. |
| 🔁 **Storno, Umlagerung, Kommission** | Originale bleiben unveränderlich. Korrekturen und Umbuchungen entstehen als eigene Buchungen. |
| 🧮 **Inventur** | Soll-Erfassung erzeugt automatisch eine Differenz-Buchung. |
| 🔔 **Mindestbestand** | Alarm bei Unterschreitung, Klingelton (optional wiederholend), Bestellstatus und „Jetzt bestellen“ direkt aus dem Alarm. |
| 🏭 **Hersteller** | Stammdaten mit Bestell-E-Mail und Bestell-Webseite – Grundlage für den Bestell-Workflow. |
| 📚 **DATANORM-Kataloge** | DATANORM 4/5 hochladen, Lieferantenkataloge durchsuchen und Felder direkt ins Artikelformular übernehmen. Inkl. Import-Historie und Duplikat-Erkennung. |
| 📥 **CSV-Import** | Wizard mit Spalten-Mapping und Validierung für Artikel-Stammdaten. |
| 🌓 **Design & Sprache** | Dark/Light/System und Deutsch/Englisch – pro User, sofort wirksam und cross-device synchronisiert. |
| 📲 **PWA installierbar** | iOS, Android, Desktop – auch ohne App-Store, über `vite-plugin-pwa` + Workbox, inkl. Onboarding. |
| 🔐 **JWT-Auth** | Server-Authoritative, Refresh-Token als `httpOnly`-Cookie, Offline-Cache für Token-Ablauf. |
| 🤖 **Agenten-API & MCP** | Scoped API-Keys, REST-API v1, OpenAPI/Swagger und MCP-Server für KI-Agenten. |

## 🧰 Tech-Stack

**Frontend (PWA):** Vue 3 · Vite · TypeScript · Pinia · Vue Router · Dexie · Vue I18n · Workbox · ZXing · jsPDF · JsBarcode · PapaParse  
**Backend:** Node 22 · Fastify · Drizzle ORM · Postgres 16 · argon2 · JWT · Zod · Swagger · MCP SDK · archiver  
**DevOps:** Docker · Docker Compose · GitHub Actions · GHCR

---

## 🚀 Installation (nur Docker Compose)

Voraussetzung: Docker und Docker Compose sind installiert. Weitere Tools (Node, npm, …) sind für den Betrieb nicht nötig.

```bash
# 1) Repo klonen
git clone https://github.com/icem0/castel.git /opt/castel
cd /opt/castel

# 2) .env kopieren und anpassen
cp .env.example .env
$EDITOR .env

# Mindestens ausfüllen:
#   DB_PASSWORD      — starkes Datenbank-Passwort (mind. 16 Zeichen)
#   JWT_SECRET       — geheimer Schlüssel für JWT (mind. 64 Zeichen)
#   PWA_PORT         — Port für die PWA (Default: 4280)
#   COOKIE_DOMAIN    — Hostname der PWA ohne Protokoll
#   CORS_ORIGIN      — Origin der PWA inkl. Protokoll

# Optional: Image-Version pinnen (Default: latest)
#   IMAGE_TAG=latest | <semver> | <commit-sha>

# 3) Stack starten (zieht die fertigen Images automatisch)
docker compose up -d

# Migrationen laufen beim API-Start automatisch und idempotent.
# Ein separater Migrationslauf ist nur noch manuell nötig:
#   docker compose --profile migrate run --rm migrate

# 4) Im Browser aufrufen
#    http://localhost:<PWA_PORT>   (Default: http://localhost:4280)
#    Beim ersten Aufruf wird der erste Admin-User per Setup-Formular angelegt.

# 5) (Optional) Tunnel/Reverse-Proxy einrichten, damit castel von außen
#    erreichbar ist — z. B. Cloudflare Tunnel, Caddy, nginx oder Traefik
#    auf localhost:<PWA_PORT>.
```

Die PWA läuft danach unter `http://localhost:<PWA_PORT>` (Default: `4280`). Die API wird intern über den PWA-Container proxied und benötigt keinen eigenen Port am Host.

Updates erfolgen mit:

```bash
git pull origin main
docker compose pull && docker compose up -d
```

> **Wichtig:** `docker compose down -v` oder ein zurückgesetztes `pgdata`-Volume löscht die Datenbank. Danach ist die User-Tabelle leer, die PWA springt auf das Erst-Setup und ein zuvor erstellter Admin existiert nicht mehr.

---

## 🏗️ Architektur

```text
┌─────────────────────────────────────────────────────────────┐
│                    Browser (PWA)                            │
│                                                             │
│  ┌──────────┐   ┌────────────┐  ┌────────────────────┐    │
│  │ Vue UI   │←→│ Pinia      │←→│ Dexie (IndexedDB) │    │
│  │ (i18n)   │   │ Stores     │  │  - artikel         │    │
│  └──────────┘   └────────────┘  │  - buchungen       │    │
│       ↑             ↑           │  - outbox          │    │
│       │             │           └────────────────────┘    │
│       │             │                  ↑                   │
│       │             ▼                  │                   │
│       │      ┌─────────────────────┐   │                   │
│       │      │ Sync-Worker         │───┘                   │
│       │      │ (Push + Pull, 30s)  │                       │
│       │      └─────────────────────┘                       │
└──────┴──────────────────────────────────────────────────────┘
       │  HTTP/HTTPS
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Externer Reverse-Proxy (nginx, Caddy, Cloudflare, …)      │
│  — optional, nicht im Repo, nicht im docker-compose.yml     │
└─────────────────────┬───────────────────────────────────────┘
                      │ Plain HTTP (internes Netz)
        ┌─────────────┴─────────────┐
        │ /api/*, /fotos/*        │ /
        ▼                         ▼
┌──────────┐             ┌──────────┐
│ Fastify  │    ←→       │ nginx    │
│  (API)   │             │  (PWA)   │
│ Port 3000│             │ Port 3000│
└────┬─────┘             └──────────┘
     │
┌────▼────────┐
│ PostgreSQL  │
│   16        │
└─────────────┘
```

### Persistente Volumes

| Volume | Inhalt |
|---|---|
| `pgdata` | PostgreSQL-Daten (Source of Truth für alle Domain-Daten) |
| `fotos-data` | Artikel-Fotos (`FOTOS_DIR`) |
| `backups-data` | Backup-ZIPs (`BACKUP_DIR`, Default `/var/lib/castel/backups`) |
| `datanorm-data` | Original-DATANORM-Dateien (`DATANORM_DIR`) |

### Datenmodell (vereinfacht)

**`buchungen`** ist **append-only** — Bestand ist immer `Σ menge where storno = false`:

| Typ | Vorzeichen | Effekt |
|---|---|---|
| `einlagerung` | `+` | addiert |
| `entnahme` | `−` | subtrahiert |
| `umlagerung` | `±` (zwei Buchungen, gleiche `paarId`) | verschiebt zwischen Standorten |
| `inventur` | Differenz `soll − bestand` | gleicht Soll/Ist aus |
| `kommission` | `±` | storno + neubuchung mit neuem Projekt |
| `storno` | invertiert Original | markiert Original als storniert |

Jede Buchung hat eine unveränderliche `id` (UUID) und einen `erstelltAm`-Zeitstempel. Korrekturen erfolgen ausschließlich über Storno- oder Gegenbuchungen, niemals durch Überschreiben.

`hersteller` (Bestellkontakt) und der Freitext-`lieferant` am Artikel bleiben getrennt: Ersterer steuert den Bestell-Workflow, Letzterer stammt aus CSV-/DATANORM-Importen. `einstellungen` liegen mit Compound-Key `(key, user_id)` in Postgres und werden per LWW (`geaendert_am`) synchronisiert.

---

## 🤖 Agenten-API & MCP

Neben der PWA können KI-Agenten und Skripte über eine eigene, dokumentierte
Schnittstelle auf castel zugreifen. Die Authentifizierung läuft über
API-Keys mit Scopes (`read`, `write`, `admin`), verwaltbar in der PWA
unter **Einstellungen → Daten → API-Keys**. Keys werden nur einmal
angezeigt; der Server speichert ausschließlich SHA-256-Hash und Prefix.

- **REST:** `/api/v1` — Meta/Status, Artikel, Standorte, Bestand, Buchungen,
  Storno, Kommissionen, Mindestbestand, Fotos und Audit
- **OpenAPI/Swagger UI:** `/api/docs` (JSON: `/api/docs/json`)
- **MCP:** `/api/mcp` (Streamable HTTP, stateless) mit 14 Tools
- **Discovery:** `GET /api/v1/meta`

Die vollständige Referenz inkl. Curl- und MCP-Beispielen steht in
[docs/AGENT-API.md](docs/AGENT-API.md). Wichtige Regeln: Bestand ist die
Summe aller nicht stornierten Buchungen, Mengen werden nie überschrieben,
Korrekturen laufen über Storno.

```bash
# Key anlegen: PWA → Einstellungen → Daten → API-Keys
export CASTEL_KEY='castel_...'
curl -s -H "Authorization: Bearer $CASTEL_KEY" \
  "$CASTEL_URL/api/v1/artikel?q=kabel&limit=20"
```

---

## 💾 Backup & Restore

**Source of truth ist der Server** (Postgres + `fotos-data`-Volume). Der Client ist flüchtig: seine IndexedDB wird beim nächsten Online-Sync ohnehin überschrieben. Backups werden daher serverseitig erzeugt — nicht im Browser.

**Alles passiert in der Web-Oberfläche** unter *Einstellungen → Daten → Backup & Restore*. Es gibt drei Wege:

1. **Sofort-Download** — Button „Jetzt als ZIP herunterladen“. Der Server triggert intern einen Sync, wartet kurz bis alle Clients gepusht haben, ruft `pg_dump -Fc` auf, packt das `fotos-data`-Volume dazu und streamt das fertige ZIP an den Browser.
2. **Datei im Server speichern** — Button „Jetzt im Backup-Ordner ablegen“. Gleicher Ablauf, das ZIP landet im `backups-data`-Volume (Pfad: `/var/lib/castel/backups`).
3. **Cronjob** — Einstellungen für *Uhrzeit* (HH:MM, Server-Zeit) und *Anzahl Kopien* (1–365). Der Server-Cron feuert einmal täglich zur eingestellten Zeit und rotiert automatisch.

**Reihenfolge im ZIP:**

```text
castel-backup-<stamp>.zip
├── manifest.json      # schema: castel-backup-1, createdAt, serverTime,
│                      # dbCounts, fotoCount, pgDumpVersion
├── dump.pgdump        # pg_dump -Fc — Custom-Format, komprimiert
└── fotos/             # Spiegel von FOTOS_DIR (Artikel-IDs als Unterordner)
```

Der Server prüft Exit-Code **und** Byte-Größe des Dumps. Ein fehlgeschlagener oder leerer Dump macht das Backup ungültig; solche ZIPs werden in der Liste als unbrauchbar markiert und lassen sich nicht einspielen.

### Restore

In der Backup-Liste auf den roten „Einspielen“-Button des gewünschten Backups klicken. **Vorher den API-Service stoppen** (`docker compose stop api`) — sonst überschreiben sich der laufende Sync und der Restore gegenseitig. Der Server bietet **keinen** automatischen Service-Stop, das ist Admin-Disziplin.

Der Restore validiert den Dump vorab (Datei vorhanden, > 0 Bytes, Header `PGDMP`), entpackt das ZIP und ruft `pg_restore --clean --if-exists --single-transaction` auf. Jeder Exit-Code ≠ 0 ist ein Fehler. Nach dem Restore die API wieder starten (`docker compose start api`).

### Was passiert auf dem Host

Alle Backups laufen **in-process** im API-Service. Es ist kein Host-Skript, kein Cron und kein SSH nötig. Der API-Container bringt `postgresql-client` (für `pg_dump`/`pg_restore`) und `archiver` mit. Die Volumes `pgdata`, `fotos-data` und `backups-data` werden vom Compose-Stack verwaltet — externe Snapshots/Borg-Backups sind davon unabhängig und Sache des Deployers.

**Postgres-Client und Server müssen dieselbe Major-Version haben** (aktuell 16). Ein älterer `pg_dump` verweigert einen neueren Server, liefert einen 0-Byte-Dump und das Backup wäre wertlos. Der Server prüft das beim Start und loggt einen Fehler bei einer Abweichung.

---

## 🚢 Deployment

Die Images werden bei jedem Push auf `main` über GitHub Actions gebaut und nach GHCR gepusht:

```text
ghcr.io/icem0/castel-api:latest
ghcr.io/icem0/castel-pwa:latest
```

Zusätzlich gibt es die beweglichen Tags `:pre-release` und den Commit-SHA als Tag. Für den Live-Betrieb empfiehlt es sich, `IMAGE_TAG` in der `.env` zu pinnen (Semver oder SHA), statt implizit `latest` zu ziehen.

`docker-compose.yml` referenziert ausschließlich fertige Images — es gibt **keinen** `build:`-Block. Der `migrate`-Service ist derselbe API-Entry-Point (`node dist/db/migrate.js`) und nur für manuelle Läufe gedacht; der normale API-Start migriert bereits selbst.

### Konfiguration

Die wichtigsten Variablen aus `.env` (vollständige Liste in `.env.example`):

| Variable | Zweck |
|---|---|
| `IMAGE_TAG` | Image-Tag (`latest`, Semver oder Commit-SHA) |
| `PWA_PORT` | Host-Port der PWA (Default `4280`) |
| `DB_PASSWORD`, `JWT_SECRET` | Pflicht-Geheimnisse |
| `COOKIE_DOMAIN`, `CORS_ORIGIN`, `COOKIE_SECURE` | Auth-Cookies und CORS (bei HTTPS `COOKIE_SECURE=true`) |
| `FOTOS_MAX_BYTES`, `FOTOS_MAX_PER_ARTIKEL` | Foto-Limits |
| `RATE_LIMIT_LOGIN_*`, `RATE_LIMIT_API_*` | Rate-Limits |
| `API_KEYS_ENABLED`, `MCP_ENABLED`, `API_DOCS_ENABLED` | Agenten-API-Features |
| `DATANORM_*` | Upload-Limits, Parser-Verhalten und Aufbewahrung |
| `PG_LOG_LEVEL` | Postgres-Loglevel (`debug5`…`panic`); leer = Mapping aus `LOG_LEVEL` |

### Reverse-Proxy & TLS

TLS und eine eigene Domain stellt man extern vor den Stack (nginx, Caddy, Traefik, Cloudflare Tunnel). Der `pwa`-Service ist der einzige öffentlich erreichbare Port; `/api/*` und `/fotos/*` werden intern an die API proxied. Wer die API direkt am Host braucht, aktiviert den auskommentierten `ports:`-Block am `api`-Service (`API_PORT`, Default `4242`).

### Betriebshinweise

- **Postgres-Logging:** `PG_LOG_LEVEL=debug*`/`info` aktiviert zusätzlich `log_statement=all` — nur kurzfristig zum Debuggen setzen, danach wieder auf `warning`/`error`.
- **DATANORM-Uploads:** nginx erlaubt bis 512 MB Request-Body (Dateien bis 500 MB). Das Volume `datanorm-data` muss für den Non-Root-User `castel` schreibbar sein; bei EACCES einmalig `docker compose exec --user root api chown -R castel:castel /var/lib/castel/datanorm`.
- **Datenbank-Volume:** `docker compose down -v` entfernt `pgdata`. Im Livebetrieb ausschließlich `docker compose pull && docker compose up -d` verwenden.

---

## 🛠️ Entwicklung

Voraussetzungen: Node 22 und npm. Für die lokale Entwicklung werden PWA und API getrennt gestartet.

```bash
# PWA (Repo-Root)
npm install
npm run dev            # Vite Dev-Server

# API (zweites Terminal)
cd server
npm install
npm run dev            # Fastify mit tsx watch
```

Die API benötigt eine `.env` im Root **und** in `server/` mit mindestens `DATABASE_URL` und `JWT_SECRET` (≥ 32 Zeichen).

### Qualitäts-Gates

```bash
# PWA
npm run lint
npm run test:run       # einmalig; `npm test` startet den Watch-Mode
npm run typecheck
npm run build

# API
cd server
npm run test:run
npm run typecheck
npm run build
```

### Lokaler Docker-Test

Ein optionales, gitignored `docker-compose.override.yml` kann den Stack lokal unter `http://localhost:4280` (PWA) bzw. `http://localhost:4242` (API) betreiben und das `pgdata`-Volume pro Lauf zurücksetzen. Details stehen in `AGENTS.md`; die Produktion bleibt davon unberührt.

### Versionierung

`scripts/write-version.mjs` schreibt vor jedem Build `src/version.ts` mit Version, Commit, Branch und Build-Datum. Ein Husky-`pre-commit`-Hook erhöht die Patch-Version in beiden `package.json`-Dateien automatisch. Commit-Messages folgen [Conventional Commits](https://conventionalcommits.org/).

---

## 🤝 Mitmachen

Issues und Pull Requests sind willkommen. Bitte vor dem PR die Qualitäts-Gates (Lint, Tests, Typecheck, Build) laufen lassen und Conventional Commits verwenden. Änderungen am Datenmodell immer als Migration unter `server/src/db/migrations/` ergänzen.

---

## 📄 Lizenz

[MIT](./LICENSE) — siehe Datei.

---

## 🙏 Dankeschön

- [Dexie.js](https://dexie.org/) für die IndexedDB-Abstraktion
- [Fastify](https://fastify.dev/) für das flotte HTTP-Framework
- [Drizzle ORM](https://orm.drizzle.team/) für typsichere DB-Queries
- [ZXing](https://github.com/zxing-js/library) für Barcode-Decoding-Fallback
- [browser-image-compression](https://www.npmjs.com/package/browser-image-compression) für clientseitige Bildkompression
- [jsPDF](https://github.com/parallax/jsPDF) und [JsBarcode](https://github.com/lindell/JsBarcode) für den Etiketten-Druck
- [PapaParse](https://www.papaparse.com/) für den CSV-Import
