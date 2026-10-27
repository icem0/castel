<div align="center">

[**English**](./README.md) · [Deutsch](./README.de.md)

<img src="public/castel-logo.png" width="120" alt="castel logo"><br/>
# castel

**Offline-first inventory management as a PWA – multi-user, append-only, ready to use.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3.5-42b883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Node 22](https://img.shields.io/badge/Node-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000?logo=fastify)](https://fastify.dev/)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org/)

Mobile-first inventory for workshops and construction sites. Works offline, syncs when online.
10+ devices, JWT auth, barcode scanning, photo capture, stocktaking with deficit bookings,
A4 labels, minimum-stock alerts and DATANORM catalog import.

[Features](#-features) • [Installation](#-installation-docker-compose-only) • [Architecture](#-architecture) • [Deployment](#-deployment) • [Agent API](#-agent-api--mcp) • [Development](#-development) • [Contributing](#-contributing)

</div>

---

## 📦 Features

| | |
|---|---|
| 📱 **Offline-first** | IndexedDB cache (Dexie). All bookings work without a network – the sync worker pushes automatically once the connection is back. |
| 🔄 **Multi-user sync** | Around 10 devices sync through a central server (Node + Fastify + Postgres 16). Outbox with quarantine for permanently rejected changes. |
| 👥 **Roles** | Admins manage users, master data and backups; users book, count stock and scan. |
| 📊 **Dashboard** | KPIs, stock movements, inventory value and action items for 7/30/90 days. |
| 📷 **Barcode scanning** | Camera scan via `BarcodeDetector` (web API) with a ZXing fallback for fast bookings. |
| 🏷️ **Labels** | Single labels and DIN A4 sheets as PDF (21/30/12/8 per sheet, list or custom layout), including a “new” marker for recently created articles. |
| 📸 **Photo capture** | Images per article, compressed on the client and stored in the backend file system. |
| 📦 **Stock formula** | `Σ bookings where storno = false` — append-only, always correct, never overwritten. |
| 🔁 **Reversal, transfer, commission** | Originals stay immutable. Corrections and relocations are recorded as new bookings. |
| 🧮 **Stocktaking** | Recording the target quantity automatically creates a difference booking. |
| 🔔 **Minimum stock** | Alert when stock falls below the threshold, optional repeating sound, order status and “Order now” directly from the alert. |
| 🏭 **Manufacturers** | Master data with order email and order website – the basis for the ordering workflow. |
| 💰 **Avg. discount & inventory value** | Discount per supplier: the purchase price is generated automatically from the list price. Purchase price × stock yields the inventory value in the dashboard (admins only). |
| 📚 **DATANORM catalogs** | Upload DATANORM 4/5 files, search supplier catalogs and copy fields directly into the article form. Includes import history and duplicate detection. |
| 📥 **CSV import** | Wizard with column mapping and validation for article master data. |
| 🌓 **Theme & language** | Dark/light/system and German/English – per user, applied immediately and synced across devices. |
| 📲 **Installable PWA** | iOS, Android, desktop – no app store required, via `vite-plugin-pwa` + Workbox, including onboarding. |
| 🔐 **JWT auth** | Server-authoritative, refresh token as an `httpOnly` cookie, offline cache for token expiry. |
| 🤖 **Agent API & MCP** | Scoped API keys, REST API v1, OpenAPI/Swagger and an MCP server for AI agents. |

## 🧰 Tech stack

**Frontend (PWA):** Vue 3 · Vite · TypeScript · Pinia · Vue Router · Dexie · Vue I18n · Workbox · ZXing · jsPDF · JsBarcode · PapaParse  
**Backend:** Node 22 · Fastify · Drizzle ORM · Postgres 16 · argon2 · JWT · Zod · Swagger · MCP SDK · archiver  
**DevOps:** Docker · Docker Compose · GitHub Actions · GHCR

---

## 🚀 Installation (Docker Compose only)

Prerequisites: Docker and Docker Compose are installed. No other tools (Node, npm, …) are required for running the stack.

```bash
# 1) Clone the repository
git clone https://github.com/icem0/castel.git /opt/castel
cd /opt/castel

# 2) Copy and edit .env
cp .env.example .env
$EDITOR .env

# Required values:
#   DB_PASSWORD      — strong database password (at least 16 characters)
#   JWT_SECRET       — secret key for JWT (at least 64 characters)
#   PWA_PORT         — port for the PWA (default: 4280)
#   COOKIE_DOMAIN    — PWA hostname without protocol
#   CORS_ORIGIN      — PWA origin including protocol

# Optional: pin the image version (default: latest)
#   IMAGE_TAG=latest | <semver> | <commit-sha>

# 3) Start the stack (pulls the prebuilt images automatically)
docker compose up -d

# Migrations run automatically and idempotently when the API starts.
# A separate migration run is only needed manually:
#   docker compose --profile migrate run --rm migrate

# 4) Open the app in your browser
#    http://localhost:<PWA_PORT>   (default: http://localhost:4280)
#    On first launch, the initial admin user is created via the setup form.

# 5) (Optional) Set up a tunnel/reverse proxy to make castel reachable
#    from the internet — e.g. Cloudflare Tunnel, Caddy, nginx or Traefik
#    pointing at localhost:<PWA_PORT>.
```

The PWA is then available at `http://localhost:<PWA_PORT>` (default: `4280`). The API is proxied internally through the PWA container and does not need its own host port.

Updates:

```bash
git pull origin main
docker compose pull && docker compose up -d
```

> **Important:** `docker compose down -v` or a reset `pgdata` volume deletes the database. Afterwards the user table is empty, the PWA falls back to first-time setup and a previously created admin no longer exists.

---

## 🏗️ Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                        Browser (PWA)                         │
│                                                              │
│  ┌──────────┐   ┌────────────┐   ┌────────────────────┐      │
│  │ Vue UI   │←→│ Pinia      │←→│ Dexie (IndexedDB)  │      │
│  │ (i18n)   │   │ stores     │   │  - articles        │      │
│  └──────────┘   └────────────┘   │  - bookings        │      │
│       ↑              ↑           │  - outbox          │      │
│       │              │           └────────────────────┘      │
│       │              ▼                   ↑                   │
│       │      ┌──────────────────────┐    │                   │
│       │      │ Sync worker          │────┘                   │
│       │      │ (push + pull, 30 s)  │                        │
│       │      └──────────────────────┘                        │
└───────┴──────────────────────────────────────────────────────┘
        │ HTTP/HTTPS
        ▼
┌──────────────────────────────────────────────────────────────┐
│  External reverse proxy (nginx, Caddy, Cloudflare, …)        │
│  optional, not part of the repo or docker-compose.yml        │
└───────────────────────┬──────────────────────────────────────┘
                        │ plain HTTP (internal network)
          ┌─────────────┴─────────────┐
          │ /api/*, /fotos/*          │ /
          ▼                           ▼
   ┌──────────┐               ┌──────────┐
   │ Fastify  │      ←→       │ nginx    │
   │ (API)    │               │ (PWA)    │
   │ port 3000│               │ port 3000│
   └────┬─────┘               └──────────┘
        │
   ┌────▼────────┐
   │ PostgreSQL  │
   │ 16          │
   └─────────────┘
```

### Persistent volumes

| Volume | Contents |
|---|---|
| `pgdata` | PostgreSQL data (source of truth for all domain data) |
| `fotos-data` | Article photos (`FOTOS_DIR`) |
| `backups-data` | Backup ZIPs (`BACKUP_DIR`, default `/var/lib/castel/backups`) |
| `datanorm-data` | Original DATANORM files (`DATANORM_DIR`) |

### Data model (simplified)

**`buchungen`** (bookings) is **append-only** — stock is always `Σ menge where storno = false`:

| Type | Sign | Effect |
|---|---|---|
| `einlagerung` | `+` | adds stock |
| `entnahme` | `−` | removes stock |
| `umlagerung` | `±` (two bookings sharing a `paarId`) | transfers between locations |
| `inventur` | difference `target − stock` | reconciles target vs. actual |
| `kommission` | `±` | reversal + new booking with a new project |
| `storno` | inverts the original | marks the original as reversed |

Every booking has an immutable `id` (UUID) and a timestamp. Corrections are made exclusively through reversal or counter-bookings, never by overwriting.

`hersteller` (manufacturer/order contact) and the free-text `lieferant` (supplier) on an article remain separate: the former drives the ordering workflow, the latter comes from CSV/DATANORM imports. `einstellungen` (settings) use the compound key `(key, user_id)` in Postgres and are synced via LWW (`geaendert_am`).

---

## 🤖 Agent API & MCP

Besides the PWA, AI agents and scripts can access castel through a dedicated,
documented interface. Authentication uses API keys with scopes (`read`,
`write`, `admin`), managed in the PWA under **Settings → Data → API keys**.
Keys are shown only once; the server stores only the SHA-256 hash and a prefix.

- **REST:** `/api/v1` — meta/status, articles, locations, stock, bookings,
  reversal, commissions, minimum stock, photos and audit
- **OpenAPI/Swagger UI:** `/api/docs` (JSON: `/api/docs/json`)
- **MCP:** `/api/mcp` (Streamable HTTP, stateless) with 14 tools
- **Discovery:** `GET /api/v1/meta`

The full reference including curl and MCP examples lives in
[docs/AGENT-API.md](docs/AGENT-API.md). Key rules: stock is the sum of all
non-reversed bookings, quantities are never overwritten, corrections go
through reversal.

```bash
# Create a key: PWA → Settings → Data → API keys
export CASTEL_KEY='castel_...'
curl -s -H "Authorization: Bearer $CASTEL_KEY" \
  "$CASTEL_URL/api/v1/artikel?q=kabel&limit=20"
```

---

## 💾 Backup & Restore

**The server is the source of truth** (Postgres + `fotos-data` volume). The client is ephemeral: its IndexedDB is overwritten on the next online sync anyway. Backups are therefore created server-side — not in the browser.

**Everything happens in the web UI** under *Settings → Data → Backup & Restore*. There are three options:

1. **Immediate download** — the “Download as ZIP now” button. The server triggers an internal sync, briefly waits for all clients to push, runs `pg_dump -Fc`, adds the `fotos-data` volume and streams the finished ZIP to the browser.
2. **Store the file on the server** — the “Write to backup folder now” button. Same flow, but the ZIP is stored in the `backups-data` volume (path: `/var/lib/castel/backups`).
3. **Cron job** — settings for *time* (HH:MM, server time) and *number of copies* (1–365). The server cron fires once a day at the configured time and rotates automatically.

**ZIP layout:**

```text
castel-backup-<stamp>.zip
├── manifest.json      # schema: castel-backup-1, createdAt, serverTime,
│                      # dbCounts, fotoCount, pgDumpVersion
├── dump.pgdump        # pg_dump -Fc — custom format, compressed
└── fotos/             # mirror of FOTOS_DIR (article IDs as subfolders)
```

The server checks both the dump’s exit code **and** its byte size. A failed or empty dump makes the backup invalid; such ZIPs are marked as unusable in the list and cannot be restored.

### Restore

In the backup list, click the red “Restore” button for the desired backup. **Stop the API service first** (`docker compose stop api`) — otherwise the running sync and the restore will overwrite each other. The server does **not** stop the service automatically; that is admin discipline.

The restore validates the dump first (file exists, > 0 bytes, `PGDMP` header), extracts the ZIP and runs `pg_restore --clean --if-exists --single-transaction`. Any exit code ≠ 0 is an error. Start the API again afterwards (`docker compose start api`).

### What happens on the host

All backups run **in-process** inside the API service. No host script, no cron and no SSH is required. The API container ships with `postgresql-client` (for `pg_dump`/`pg_restore`) and `archiver`. The `pgdata`, `fotos-data` and `backups-data` volumes are managed by the Compose stack — external snapshots/Borg backups are independent of this and are the deployer’s responsibility.

**The Postgres client and server must use the same major version** (currently 16). An older `pg_dump` refuses a newer server, produces a 0-byte dump and the backup would be worthless. The server checks this at startup and logs an error on a mismatch.

---

## 🚢 Deployment

Images are built and pushed to GHCR by GitHub Actions on every push to `main`:

```text
ghcr.io/icem0/castel-api:latest
ghcr.io/icem0/castel-pwa:latest
```

There are also the moving `:pre-release` tag and a per-commit SHA tag. For production, pin `IMAGE_TAG` in `.env` (semver or SHA) instead of implicitly pulling `latest`.

`docker-compose.yml` references only prebuilt images — there is **no** `build:` block. The `migrate` service uses the same API entry point (`node dist/db/migrate.js`) and is intended for manual runs only; the regular API start already migrates on its own.

### Configuration

The most important `.env` variables (full list in `.env.example`):

| Variable | Purpose |
|---|---|
| `IMAGE_TAG` | Image tag (`latest`, semver or commit SHA) |
| `PWA_PORT` | Host port for the PWA (default `4280`) |
| `DB_PASSWORD`, `JWT_SECRET` | Required secrets |
| `COOKIE_DOMAIN`, `CORS_ORIGIN`, `COOKIE_SECURE` | Auth cookies and CORS (`COOKIE_SECURE=true` with HTTPS) |
| `FOTOS_MAX_BYTES`, `FOTOS_MAX_PER_ARTIKEL` | Photo limits |
| `RATE_LIMIT_LOGIN_*`, `RATE_LIMIT_API_*` | Rate limits |
| `API_KEYS_ENABLED`, `MCP_ENABLED`, `API_DOCS_ENABLED` | Agent API features |
| `DATANORM_*` | Upload limits, parser behavior and retention |
| `PG_LOG_LEVEL` | Postgres log level (`debug5`…`panic`); empty = mapped from `LOG_LEVEL` |

### Reverse proxy & TLS

TLS and a custom domain are handled externally in front of the stack (nginx, Caddy, Traefik, Cloudflare Tunnel). The `pwa` service is the only publicly exposed port; `/api/*` and `/fotos/*` are proxied internally to the API. If you need direct API access on the host, enable the commented-out `ports:` block on the `api` service (`API_PORT`, default `4242`).

### Operational notes

- **Postgres logging:** `PG_LOG_LEVEL=debug*`/`info` additionally enables `log_statement=all` — use only briefly for debugging, then switch back to `warning`/`error`.
- **DATANORM uploads:** nginx allows request bodies up to 512 MB (files up to 500 MB). The `datanorm-data` volume must be writable by the non-root user `castel`; on EACCES run `docker compose exec --user root api chown -R castel:castel /var/lib/castel/datanorm` once.
- **Database volume:** `docker compose down -v` removes `pgdata`. In production, only use `docker compose pull && docker compose up -d`.

---

## 🛠️ Development

Prerequisites: Node 22 and npm. For local development, the PWA and API are started separately.

```bash
# PWA (repository root)
npm install
npm run dev            # Vite dev server

# API (second terminal)
cd server
npm install
npm run dev            # Fastify with tsx watch
```

The API requires a `.env` in the root **and** in `server/` with at least `DATABASE_URL` and `JWT_SECRET` (≥ 32 characters).

### Quality gates

```bash
# PWA
npm run lint
npm run test:run       # one-off; `npm test` starts watch mode
npm run typecheck
npm run build

# API
cd server
npm run test:run
npm run typecheck
npm run build
```

### Local Docker test

An optional, gitignored `docker-compose.override.yml` can run the stack locally at `http://localhost:4280` (PWA) and `http://localhost:4242` (API) and reset the `pgdata` volume on every run. Details are in `AGENTS.md`; production remains unaffected.

### Versioning

`scripts/write-version.mjs` writes `src/version.ts` (version, commit, branch, build date) before each build. A Husky `pre-commit` hook automatically bumps the patch version in both `package.json` files. Commit messages follow [Conventional Commits](https://conventionalcommits.org/).

---

## 🤝 Contributing

Issues and pull requests are welcome. Before opening a PR, please run the quality gates (lint, tests, typecheck, build) and use Conventional Commits. Always add data model changes as a migration under `server/src/db/migrations/`.

---

## 📄 License

[MIT](./LICENSE) — see the license file.

---

## 🙏 Acknowledgements

- [Dexie.js](https://dexie.org/) for the IndexedDB abstraction
- [Fastify](https://fastify.dev/) for the fast HTTP framework
- [Drizzle ORM](https://orm.drizzle.team/) for type-safe database queries
- [ZXing](https://github.com/zxing-js/library) for the barcode decoding fallback
- [browser-image-compression](https://www.npmjs.com/package/browser-image-compression) for client-side image compression
- [jsPDF](https://github.com/parallax/jsPDF) and [JsBarcode](https://github.com/lindell/JsBarcode) for label printing
- [PapaParse](https://www.papaparse.com/) for CSV import
