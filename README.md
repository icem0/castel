<div align="center">

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
10+ Geräte, JWT-Auth, Barcode-Scan, Foto-Erfassung, Inventur mit Defizit-Buchung.

[Features](#-features) • [Quickstart](#-quickstart) • [Architektur](#-architektur) • [Deployment](#-deployment) • [API-Referenz](#-api-referenz) • [Entwicklung](#-entwicklung) • [Mitmachen](#-mitmachen)

</div>

---

## 📦 Features

| | |
|---|---|
| 📱 **Offline-First** | IndexedDB-Cache (Dexie). Alle Buchungen möglich ohne Netz – Sync läuft automatisch, wenn online. |
| 🔄 **Multi-User-Sync** | ca. 10 Geräte syncen über zentralen Server (Node + Fastify + Postgres 16). |
| 👥 **Rollen** | Admin verwaltet User & Stammdaten, User bucht und inventuriert. |
| 📷 **Barcode-Scan** | Kamera-Scan via `BarcodeDetector` (Web-API) mit ZXing-Fallback für schnelles Buchen. |
| 📸 **Foto-Erfassung** | Bilder pro Artikel, clientseitig komprimiert, im Backend-Dateisystem gespeichert. |
| 📦 **Bestandsformel** | `Σ Buchungen where storno = false` — append-only, immer korrekt, nie überschrieben. |
| 🔁 **Storno + Kommission** | Originale bleiben unveränderlich. Korrekturen als eigene Buchungen (Storno / Neubuchung). |
| 🧮 **Inventur** | Soll-Erfassung erzeugt automatisch eine Differenz-Buchung. |
| 📲 **PWA installierbar** | iOS, Android, Desktop – auch ohne App-Store, über `vite-plugin-pwa` + Workbox. |
| 🔐 **JWT-Auth** | Server-Authoritative, Refresh-Token als `httpOnly`-Cookie, Offline-Cache für Token-Ablauf. |

## 🧰 Tech-Stack

**Frontend (PWA):** Vue 3 · Vite · TypeScript · Pinia · Dexie · Vue I18n · Workbox · ZXing  
**Backend:** Node 22 · Fastify · Drizzle ORM · Postgres 16 · argon2 · JWT  
**DevOps:** Docker · Docker Compose · GitHub Actions → GitHub Container Registry (GHCR)

---

## 🚀 Quickstart

### Empfohlener Weg: Docker Compose

Die Images `castel-api` und `castel-pwa` werden direkt von GitHub Container Registry (GHCR) bezogen — kein lokaler Build nötig.

```bash
# 1) Repo klonen
git clone https://github.com/icem0/castel.git /opt/castel
cd /opt/castel

# 2) .env kopieren und anpassen (mindestens DB_PASSWORD und JWT_SECRET setzen)
cp .env.example .env
$EDITOR .env

# 3) Erste Migration ausführen
docker compose --profile migrate up

# 4) Stack starten (zieht Images von GHCR)
docker compose up -d

# 5) Im Browser /login aufrufen — der erste Admin wird per Setup-Formular angelegt,
#    sobald die users-Tabelle leer ist.

# 6) Updates nach neuen Releases
git pull origin main
docker compose pull && docker compose up -d
```

→ PWA unter `http://localhost:4280`, API intern unter Port `3000` (über PWA-nginx proxied).  
Für direkte API-Zugriffe (z. B. CLI, curl) den auskommentierten `ports:`-Block beim `api`-Service in `docker-compose.yml` aktivieren (`4242:3000`).

> 💡 Für private GHCR-Pakete braucht der Deployer einen GitHub-PAT mit Scope `read:packages` (`docker login ghcr.io` oder Arcane `POST /container-registries`). Siehe Deployment → Private GHCR-Pakete.

### Voraussetzungen

- Docker + Docker Compose
- Optional: Node ≥ 22 (nur für lokale Entwicklung ohne Docker)

### Alternativ: Frontend allein (Dev, ohne Backend)

```bash
npm install
npm run dev
# → http://localhost:5173
```

### Alternativ: Backend lokal mit embedded Postgres (für Tests)

```bash
cd server
npm install
node scripts/smoke-server.mjs
```

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
│  — nicht im Repo, nicht im docker-compose.yml               │
└─────────────────────┬───────────────────────────────────────┘
                      │ Plain HTTP (internes Netz)
        ┌─────────────┴─────────────┐
        │ /api/*, /fotos/*        │ /
        ▼                         ▼
┌──────────┐             ┌──────────┐
│ Fastify  │    ←→       │ nginx    │
│  (API)   │             │  (PWA)   │
│ Port 3000│             │ Port 80  │
└────┬─────┘             └──────────┘
     │
┌────▼────────┐
│ PostgreSQL  │
│   16        │
└─────────────┘
```

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

Jede Buchung hat eine unveränderliche `id` (UUID) und `erstelltAm`-Zeitstempel. Korrekturen nur via Storno, niemals überschrieben.

---

## 🌍 Deployment

### Docker-Compose (Production)

Die Container `castel-api` (Port 4242) und `castel-pwa` (Port 4280) werden **direkt am Host exponiert**. TLS, Domain und Firewall kümmerst du **extern** — z. B. mit nginx, Caddy, Traefik oder einem Cloud-Loadbalancer, der auf 4242/4280 proxied. In diesem Repo wird kein Reverse-Proxy mitgeliefert.

**Default-Workflow: clone + `.env` + `docker compose up -d` reicht.** Die Images werden direkt von GitHub Container Registry bezogen — `docker-compose.yml` referenziert sie hartkodiert als `ghcr.io/icem0/castel-api:latest` bzw. `…-pwa:latest` (für `migrate` wird dasselbe API-Image mit anderem Entrypoint verwendet). Der CI-Workflow [`.github/workflows/build-and-push.yml`](./.github/workflows/build-and-push.yml) baut und pusht diese Tags bei jedem Merge auf `main`.

```bash
# 1) Repo klonen
git clone https://github.com/icem0/castel.git /opt/castel
cd /opt/castel

# 2) .env ausfüllen
cp .env.example .env
$EDITOR .env   # DB-Password, JWT-Secret, Domain-Configs

# 3) Initial: Migration
docker compose --profile migrate up

# 4) Stack hochfahren (zieht Images von GHCR, startet den Stack)
docker compose up -d

# 5) Im Browser /login aufrufen — der erste Admin wird per Setup-Formular angelegt.

# 6) Update-Workflow nach jedem neuen Release
cd /opt/castel
git pull origin main
docker compose pull && docker compose up -d   # zieht neue :latest-Tags, startet neu
```

Fertig. Funktioniert auf einer frischen Maschine, in Arcane, Coolify oder bare Docker gleichermaßen — es wird **kein** GHCR-Login, **kein** vorheriger Build und **kein** Source-Workspace im Deployer benötigt.

### Voraussetzung: GHCR-Images existieren

Die Tags `ghcr.io/icem0/castel-api:latest` und `…-pwa:latest` müssen in GHCR vorhanden sein. Sie werden vom CI-Workflow automatisch bei jedem Push auf `main` erzeugt und überschrieben. Für einen frischen Fork muss also zuerst einmal `main` gepusht werden (oder ein Maintainer mit Package-Schreibrechten), bevor der Deployer ziehen kann.

### Private GHCR-Pakete

Sind die GHCR-Pakete privat (Default für neue Repos), braucht der Deployer einen GitHub-Personal-Access-Token mit Scope `read:packages`:

- **Bare Docker / Coolify**: `echo $TOKEN | docker login ghcr.io -u $USER --password-stdin` vor `docker compose pull`.
- **Arcane**: Container-Registry einmalig per `POST /container-registries` mit dem PAT hinterlegen — danach zieht der Deployer transparent.

Für **öffentliche** Pakete reicht kein Token. Die Images dieses Repos werden vom CI-Workflow per `PATCH /user/packages/container/{pkg}` explizit auf `public` gesetzt; der Status lässt sich unter `https://github.com/icem0?tab=packages` prüfen.

### Was hier **nicht** enthalten ist

- **Kein Reverse-Proxy** (Caddy, nginx, Traefik, …) — du nutzt deinen eigenen vor dem Stack
- **Kein Cloudflare-Tunnel** — wenn du den willst, läuft er als eigener Container/Service auf deinem Host, separat von diesem Compose
- **Keine TLS-Terminierung** — wenn der Stack direkt ins Internet zeigt, brauchst du dringend einen TLS-Proxy davor

### TLS / HTTPS vor dem Stack

Der einfachste Weg ist ein einzelner nginx auf dem Host (nicht in diesem Compose):

```nginx
server {
    listen 443 ssl http2;
    server_name castel.example.com;
    ssl_certificate /etc/letsencrypt/live/.../fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/.../privkey.pem;

    location /api/ { proxy_pass http://127.0.0.1:4242; }
    location /fotos/ { proxy_pass http://127.0.0.1:4242; }
    location / { proxy_pass http://127.0.0.1:4280; }
}
```

---

## 🔌 API-Referenz

### Auth

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` | `{ token, user }` (Set-Cookie refresh) |
| POST | `/api/auth/refresh` | — | `{ token }` (Cookie-Rotation) |
| POST | `/api/auth/logout` | — | 204 |
| GET | `/api/auth/me` | — | `{ id, email, rolle }` |
| POST | `/api/auth/change-password` | `{ oldPassword, newPassword }` | 204 |

### Sync

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/sync/snapshot?since=<iso>` | Alle Entities geändert seit `since` |
| POST | `/api/sync/push` | Bulk-Push (max. 500 ops), Konflikt-Reporting pro-Struktur |

### Artikel & Fotos

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/fotos/upload/:artikelId` | multipart `foto` (≤ 512 kB, jpeg/png/webp) |
| GET | `/api/fotos/list/:artikelId` | Liste der hochgeladenen Fotos |
| DELETE | `/api/fotos/:id` | Foto entfernen (admin only) |

### User-Verwaltung (admin only)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/users` | Liste |
| POST | `/api/users` | Anlegen |
| PATCH | `/api/users/:id` | Rolle / Aktiv / Passwort ändern |
| DELETE | `/api/users/:id` | Deaktivieren (soft-delete) |

### Konfliktauflösung

- **Buchungen**: append-only, keine Konflikte möglich (UUID-Kollisionen werden als `duplicate` quittiert)
- **Stammdaten (Artikel/Standort/Projekt)**: Last-Writer-Wins auf `geaendertAm`. Server prüft serverseitig; Client bekommt Server-Version in der nächsten Pull
- **Negativ-Bestand**: Server lehnt `entnahme`-Push ab, der Client muss einen Storno einleiten

---

## 🛠️ Entwicklung

### Lokal arbeiten

```bash
# Terminal 1: Backend
cd server
npm run dev          # tsx watch — startet automatisch neu

# Terminal 2: PWA
npm run dev          # vite dev server — HMR
```

### Tests

```bash
# Frontend
npm run test:run
npm run test:coverage

# Backend
cd server
npm run test:run

# End-to-End (Postgres + Server + Auth)
cd server
node scripts/smoke-server.mjs
```

### Lint + Typecheck + Build

```bash
npm run lint
npm run typecheck
npm run build

# Backend
cd server
npm run typecheck
```

### Test-Datenbank

Backend-Tests laufen mit `embedded-postgres` (kein Docker nötig). Production-Postgres separat via `docker run postgres:16`.

---

## 📁 Projektstruktur

```
castel/
├── src/                       # PWA (Vue 3 + TypeScript)
│   ├── auth/                 # Auth-Helfer, JWT-Storage, Offline-Cache
│   ├── components/           # Vue-Komponenten (FotoUpload, …)
│   ├── composables/          # useBarcode, useArtikelTypen
│   ├── db/                   # Dexie-Schema
│   ├── domain/               # Pure Business Logic (Buchungen, Bestand)
│   ├── locales/              # i18n DE/EN
│   ├── router/               # Vue-Router
│   ├── services/             # API-Client, Sync-Worker, Import, Export, Fotos
│   ├── stores/               # Pinia
│   └── views/                # Page-Components
├── server/                   # Backend (Fastify + Drizzle)
│   ├── src/
│   │   ├── auth/             # JWT, Cookies, Rate-Limit, Routes, Middleware, Setup
│   │   ├── config/           # ENV-Validierung (zod)
│   │   ├── db/               # Drizzle-Schema, Migrationen, Client
│   │   ├── domain/           # Errors, Bestandsformel, Validierung
│   │   ├── fotos/            # Foto-Upload + statische Auslieferung
│   │   ├── sync/             # Snapshot, Push, Resolver
│   │   └── users/            # User-Verwaltung
│   ├── scripts/              # smoke-server.mjs (E2E)
│   ├── Dockerfile            # API-Container
│   └── .env.example
├── docs/                     # Deployment, API, Operations
├── .github/workflows/        # CI: Lint, Test, Build, Push zu GHCR
├── Dockerfile.pwa            # PWA-Container (nginx)
├── nginx-pwa.conf            # nginx-Konfig
├── docker-compose.yml        # Komplette Prod-Stack (PWA + API + DB, direkt am Host)
├── .env.example              # Prod-Env-Vorlage
├── scripts/
│   ├── write-version.mjs     # Build-Metadaten (version.ts)
│   ├── bump-version.mjs      # Automatische Patch-Bumps
│   └── castel-restart.ps1    # Lokaler Restart-Wrapper (Dev)
├── package.json              # PWA (Root)
├── server/package.json       # Backend
└── LICENSE
```

---

## 🔒 Sicherheit

- **JWT-Secret** in `.env` (nicht in Git), mind. 32 Zeichen
- **Passwort-Hashing** serverseitig mit argon2id (nicht PBKDF2)
- **Refresh-Tokens** als `httpOnly`-Cookie, `SameSite=Lax; Secure`
- **Rate-Limit** auf `/api/auth/login` (5 Versuche / Minute)
- **Helmet**-Header gegen XSS, Clickjacking, MIME-Sniffing
- **TLS** Pflicht — kein HTTP-Betrieb in Produktion
- **Keine Telemetrie**, kein Cloud-Call ohne expliziten User-Tunnel
- Vor jedem Commit: keine `.env`/Secrets versehentlich committet

---

## 📊 Performance-Budget

| Kennzahl | Ziel | Status |
|---|---|---|
| JS gzip | ≤ 130 kB | 122 kB ✓ |
| First Contentful Paint | ≤ 1.5 s (WLAN, lokal) | ✓ |
| Offline-First-Load | ≤ 0.5 s (Service Worker, precache) | ✓ |
| Sync-Roundtrip (offline → sync) | ≤ 3 s für 50 Buchungen | ✓ |

---

## 🤝 Mitmachen

Pull Requests willkommen! Bitte:

1. Fork + Branch (`feature/mein-feature` oder `fix/bugbeschreibung`)
2. Tests schreiben (oder anpassen) — Coverage sollte nicht sinken
3. `npm run lint && npm run typecheck && npm run test:run && npm run build` muss grün sein
4. PR mit kurzer Beschreibung der Änderung

Vor größeren Änderungen: Issue aufmachen, damit wir uns abstimmen können.

### Commit-Convention

Conventional Commits sind Pflicht: `<type>(<scope>)?: <subject>`. Erlaubte Typen: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. `feat!`/`BREAKING CHANGE:` für Major-Bumps. Die Version läuft mit jedem Commit hoch (Patch-Bump über Husky `pre-commit`-Hook).

### Roadmap

- [ ] Barcode-Scan-Bestätigungsdialog (Menge einstellen nach Scan)
- [ ] Mehrere Bilder pro Upload + Reihenfolge
- [ ] Inventur-Wizard mit Offline-Speicherung
- [ ] Push-Benachrichtigungen (Mindestbestand-Unterschreitung)
- [ ] CSV-Export mit konfigurierbarem Format
- [ ] LDAP / OIDC-Auth statt eigenem User-System
- [ ] Mobile-nativ-Apps (Capacitor) als Alternative zur PWA

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
