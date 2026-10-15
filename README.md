<div align="center">

<img src="public/castel-logo.png"><br/>
# castel

**Offline-fähige Lagerverwaltung als PWA mit Multi-User-Sync**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3.5-42b883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Node 22](https://img.shields.io/badge/Node-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000?logo=fastify)](https://fastify.dev/)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

Mobile-First-Lager für Werkstatt und Baustelle. Funktioniert offline, synct wenn online.

[Features](#features) • [Quickstart](#quickstart) • [Architektur](#architektur) • [Deployment](#deployment) • [API](#api) • [Mitmachen](#mitmachen)

</div>

---

## Features

| | |
|---|---|
| 📦 **Offline-First** | IndexedDB-Cache lokal, alle Buchungen möglich auch ohne Netz |
| 🔄 **Multi-User-Sync** | ca. 10 Geräte syncen über zentralen Server (Node + Postgres) |
| 👥 **Rollen** | Admin verwaltet User + Inventur, User bucht |
| 📷 **Barcode-Scan** | Kamera-Scan (Web-API + ZXing-Fallback) für schnelles Buchen |
| 📸 **Foto-Erfassung** | Bilder pro Artikel, komprimiert, im Backend gespeichert |
| 📦 **Bestandsformel** | `Σ Buchungen where storno=false` — append-only, immer korrekt |
| 🔁 **Storno + Kommission** | Originale nie überschrieben, Korrekturen als eigene Buchungen |
| 🧮 **Inventur mit Defizit-Buchung** | Soll-Erfassung erzeugt automatisch Differenz-Buchung |
| 📲 **PWA installierbar** | iOS, Android, Desktop — auch ohne App-Store |
| 🔐 **JWT-Auth** | Server-Authoritative, Offline-Cache für Token-Ablauf |

## Tech-Stack

**Frontend (PWA):** Vue 3 · Vite · TypeScript · Pinia · Dexie · Vue I18n · Workbox · ZXing
**Backend:** Node 22 · Fastify · Drizzle ORM · Postgres 16 · argon2 · JWT
**DevOps:** Docker · Docker Compose · GitHub Actions → GHCR

---

## Quickstart

### Voraussetzungen

- Node ≥ 22
- Docker (für Postgres + Tests)
- Optional: Cloudflare-Account (für externen Tunnel)

### Frontend (Dev, ohne Backend)

```bash
npm install
npm run dev
# → http://localhost:5173
```

### Mit Backend (lokal, mit embedded Postgres)

Das Backend bringt ein Test-Skript mit, das eine embedded Postgres startet:

```bash
cd server
npm install
node scripts/smoke-server.mjs
```

Erwartete Ausgabe:

```
✓ Postgres läuft auf 5433
✓ Migrationen ausgeführt (idempotent)
✓ Server läuft auf Port 3001
✓ /api/healthz: {"status":"ok",…}
✓ Login erfolgreich: {…,"rolle":"admin",…}
✓ /api/auth/me: {…}
✅ Alle End-to-End-Tests bestanden.
```

### Mit Production-Datenbank

```bash
# 1) Postgres via Docker (oder nativ)
docker run -d --name castel-pg \
  -e POSTGRES_USER=castel \
  -e POSTGRES_PASSWORD=castel-dev \
  -e POSTGRES_DB=castel \
  -p 5432:5432 \
  postgres:16-alpine

# 2) Backend
cd server
cp .env.example .env
# .env anpassen (DATABASE_URL, JWT_SECRET)
npm install
npm run db:migrate
npm run dev
# → http://localhost:4242
# Beim ersten Aufruf der Login-Seite wird der Admin-User per Setup-Formular angelegt.

# 3) Frontend
cd ..
npm install
# VITE_API_URL=http://localhost:3000 npm run dev  # Dev-API bleibt auf 3000
```

---

## Architektur

```
┌─────────────────────────────────────────────────────────┐
│                  Browser (PWA)                          │
│                                                         │
│  ┌──────────┐   ┌────────────┐  ┌──────────────────┐    │
│  │ Vue UI   │←→│ Pinia      │←→│ Dexie (IndexedDB) │    │
│  │ (i18n)   │   │ Stores     │  │  - artikel       │    │
│  └──────────┘   └────────────┘  │  - buchungen     │    │
│       ↑              ↑          │  - outbox        │    │
│       │              │          └──────────────────┘    │
│       │              │                  ↑                │
│       │              ▼                  │                │
│       │      ┌─────────────────────┐    │                │
│       │      │  Sync-Worker        │────┘                │
│       │      │  (Push + Pull, 30s) │                     │
│       │      └─────────────────────┘                     │
└──────│──────────────────────────────────────────────────┘
       │  HTTP/HTTPS
       ▼
┌──────────────────────────────────────────┐
│  Externer Reverse-Proxy (nginx, Caddy,   │
│  Cloudflare, HAProxy, …) — nicht im     │
│  Repo, nicht im docker-compose.yml      │
└─────────────────┬────────────────────────┘
                  │ Plain HTTP (internes Netz)
       ┌──────────┴──────────┐
       │ /api/*, /fotos/*   │ /
       ▼                     ▼
┌──────────┐           ┌──────────┐
│ Fastify  │    ←→     │ nginx    │
│  (API)   │           │  (PWA)   │
│ Port 3000│           │ Port 80  │
└────┬─────┘           └──────────┘
     │
┌────▼────────┐
│ PostgreSQL  │
└─────────────┘
```

### Datenmodell (vereinfacht)

**`buchungen`** ist **append-only** — Bestand ist immer `Σ menge where storno=false`:

| typ | vorzeichen | effekt |
|---|---|---|
| `einlagerung` | `+` | addiert |
| `entnahme` | `−` | subtrahiert |
| `umlagerung` | `±` (zwei Buchungen, gleiche `paarId`) | verschiebt zwischen Standorten |
| `inventur` | Differenz `soll − bestand` | gleicht Soll/Ist aus |
| `kommission` | `±` | storno + neubuchung mit neuem Projekt |
| `storno` | invertiert Original | markiert Original als storniert |

Jede Buchung hat eine unveränderliche `id` (UUID) und `erstelltAm`-Zeitstempel. Korrekturen nur via Storno, niemals überschrieben.

---

## Deployment

### Docker-Compose (ohne Tunnel, ohne Reverse-Proxy im Stack)

Die Container `castel-api` (Port 4242) und `castel-pwa` (Port 4280) werden **direkt am Host exponiert**. Wenn du TLS, eine Domain oder eine Firewall brauchst, kümmerst du dich **extern** darum — z. B. mit einem nginx, Caddy, Traefik, HAProxy, oder einem Cloud-Loadbalancer, der auf 4242/4280 proxied. In diesem Repo wird kein Reverse-Proxy mitgeliefert.

**Default-Workflow: clone + `.env` + `docker compose up -d` reicht.** Die Images werden direkt von GitHub Container Registry bezogen — `docker-compose.yml` referenziert sie hartkodiert als `ghcr.io/icem0/castel-api:latest` bzw. `…-pwa:latest` (für `migrate` wird dasselbe API-Image mit anderem Entrypoint verwendet). Der CI-Workflow [`.github/workflows/build-and-push.yml`](./.github/workflows/build-and-push.yml) baut und pusht diese Tags bei jedem Merge auf `main`.

```bash
# 1) Repo klonen
git clone https://github.com/icem0/castel.git /opt/castel
cd /opt/castel

# 2) .env ausfüllen
cp .env.example .env
$EDITOR .env  # DB-Password, JWT-Secret, Domain-Configs

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

#### Voraussetzung: GHCR-Images existieren

Die Tags `ghcr.io/icem0/castel-api:latest` und `…-pwa:latest` müssen in GHCR vorhanden sein. Sie werden vom CI-Workflow automatisch bei jedem Push auf `main` erzeugt und überschrieben. Für einen frischen Fork muss also zuerst einmal `main` gepusht werden (oder ein Maintainer mit Package-Schreibrechten), bevor der Deployer ziehen kann.

#### Private GHCR-Pakete

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

## API

### Auth

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` | `{ token, user }` (Set-Cookie refresh) |
| POST | `/api/auth/refresh` | — | `{ token }` (Cookie-Rotation) |
| POST | `/api/auth/logout` | — | 204 |
| GET | `/api/auth/me` | — | `{ id, email, rolle }` |
| POST | `/api/auth/change-password` | `{ oldPassword, newPassword }` | 204 |

### Sync

| Method | Path | Zweck |
|---|---|---|
| GET | `/api/sync/snapshot?since=<iso>` | Alle Entities geändert seit `since` |
| POST | `/api/sync/push` | Bulk-Push (max. 500 ops), Konflikt-Reporting pro-Struktur |

### Artikel & Fotos

| Method | Path | Zweck |
|---|---|---|
| POST | `/api/fotos/upload/:artikelId` | multipart `foto` (≤ 512 kB, jpeg/png/webp) |
| GET | `/api/fotos/list/:artikelId` | Liste der hochgeladenen Fotos |
| DELETE | `/api/fotos/:id` | Foto entfernen (admin only) |

### User-Verwaltung (admin only)

| Method | Path | Zweck |
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

## Entwicklung

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

## Projektstruktur

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
└── .env.example              # Prod-Env-Vorlage
```

---

## Sicherheit

- **JWT-Secret** in `.env` (nicht in Git), mind. 32 Zeichen
- **Passwort-Hashing** serverseitig mit argon2id (nicht PBKDF2)
- **Refresh-Tokens** als httpOnly-Cookie, `SameSite=Lax; Secure`
- **Rate-Limit** auf `/api/auth/login` (5 Versuche / Minute)
- **Helmet**-Header gegen XSS, Clickjacking, MIME-Sniffing
- **TLS** Pflicht — kein HTTP-Betrieb in Produktion
- **Keine Telemetrie**, kein Cloud-Call ohne expliziten User-Tunnel
- **Pre-Commit-Hook** (geplant): verhindert versehentliche Commits von `.env`/`secrets`

---

## Performance-Budget

- **JS gzip**: ≤ 130 kB (aktuell 122 kB) ✓
- **First Contentful Paint**: ≤ 1.5 s (im WLAN, lokal)
- **Offline-First-Load**: ≤ 0.5 s (Service Worker, precache)
- **Sync-Roundtrip (offline → sync)**: ≤ 3 s für 50 Buchungen

---

## Mitmachen

Pull Requests willkommen! Bitte:

1. Fork + Branch (`feature/mein-feature` oder `fix/bugbeschreibung`)
2. Tests schreiben (oder anpassen) — Coverage sollte nicht sinken
3. `npm run lint && npm run typecheck && npm run test:run && npm run build` muss grün sein
4. PR mit kurzer Beschreibung der Änderung

Vor größeren Änderungen: Issue aufmachen, damit wir uns abstimmen können.

### Roadmap

- [ ] Barcode-Scan-Bestätigungsdialog (Menge einstellen nach Scan)
- [ ] Mehrere Bilder pro Upload + Reihenfolge
- [ ] Inventur-Wizard mit Offline-Speicherung
- [ ] Push-Benachrichtigungen (Mindestbestand-Unterschreitung)
- [ ] CSV-Export mit konfigurierbarem Format
- [ ] LDAP / OIDC-Auth statt eigenem User-System
- [ ] Mobile-nativ-Apps (Capacitor) als Alternative zur PWA

---

## Lizenz

[MIT](./LICENSE) — siehe Datei.

## Dankschagen

- [Dexie.js](https://dexie.org/) für die IndexedDB-Abstraktion
- [Fastify](https://fastify.dev/) für das flotte HTTP-Framework
- [Drizzle ORM](https://orm.drizzle.team/) für typsichere DB-Queries
- [ZXing](https://github.com/zxing-js/library) für Barcode-Decoding-Fallback
- [browser-image-compression](https://www.npmjs.com/package/browser-image-compression) für clientseitige Bildkompression
