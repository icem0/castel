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
**DevOps:** Docker · Docker Compose · GitHub Actions

---

## 🚀 Installation (nur Docker Compose)

Voraussetzung: Docker und Docker Compose sind installiert. Keine weiteren Tools (Node, npm, …) nötig.

```bash
# 1) Repo klonen
git clone https://github.com/icem0/castel.git /opt/castel
cd /opt/castel

# 2) .env kopieren und anpassen
cp .env.example .env
$EDITOR .env

# Mindestens ausfüllen:
#   DB_PASSWORD      — starkes Datenbank-Passwort
#   JWT_SECRET       — geheimer Schlüssel für JWT (mind. 32 Zeichen)
#   PWA_PORT         — Port für die PWA (Default: 4280)

# 3) Erste Migration ausführen
docker compose --profile migrate up

# 4) Stack starten (zieht die fertigen Images automatisch)
docker compose up -d

# 5) Im Browser aufrufen
#    http://localhost:4280   (oder der in PWA_PORT gesetzte Port)
#    Beim ersten Login wird der erste Admin-User per Setup-Formular angelegt.

# 6) (Optional) Tunnel einrichten, damit castel von außen erreichbar ist
#    z. B. Cloudflare Tunnel, ngrok oder ein eigener Reverse-Proxy auf
#    localhost:<PWA_PORT> leiten.
```

Die PWA läuft danach unter `http://localhost:<PWA_PORT>` (Default: `4280`). Die API wird intern über den PWA-Container proxied und benötigt keinen eigenen Port am Host.

Updates erfolgen mit:

```bash
git pull origin main
docker compose pull && docker compose up -d
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

## 💾 Backup & Restore

**Source of truth ist der Server** (Postgres + `fotos-data`-Volume). Der Client ist flüchtig: seine IndexedDB wird beim nächsten Online-Sync ohnehin überschrieben. Backups werden daher serverseitig erzeugt — nicht im Browser.

Die zwei Skripte liegen in `scripts/`:

| Skript | Aufgabe |
|---|---|
| `scripts/backup.mjs` | Sync-Trigger anstoßen, auf Idle warten, `pg_dump` + Fotos kopieren, ZIP schreiben |
| `scripts/restore.mjs` | ZIP entpacken, `pg_restore` einspielen, Fotos zurückspielen |

### Voraussetzungen

- `pg_dump` und `pg_restore` lokal installiert (Postgres-Client-Tools).
- Zugriff auf den Postgres-Container (`DATABASE_URL`) und das `fotos-data`-Volume (`FOTOS_DIR`).
- Ein gültiges Admin-JWT (`ADMIN_TOKEN`).

### Backup

```bash
# .env muss die üblichen DB-Variablen enthalten (DB_NAME, DB_USER, DB_PASSWORD)
export $(grep -E '^(DB_|JWT_)' .env | xargs)
export ADMIN_TOKEN="<jwt eines admin-users>"
export FOTOS_DIR=/srv/castel/fotos          # Mount des fotos-data-Volumes
export BACKUP_DIR=/srv/castel/backups       # Zielordner
export API_BASE_URL=http://localhost:4280   # PWA-Origin (für /api/admin/sync/all)

node scripts/backup.mjs
# → [backup] 1/5 Sync-Trigger an Server …
# → [backup] 2/5 warte auf Sync-Idle …
# → [backup] 3/5 pg_dump …
# → [backup] 4/5 fotos …
# → [backup] 5/5 zip -> /srv/castel/backups/castel-backup-2026-10-19T…zip
# → [backup] fertig: … (412 Buchungen, 28 Foto-Artikel)
```

Das Skript fordert den Server per `POST /api/admin/sync/all` auf, alle verbundenen PWA-Worker zum sofortigen Pushen zu bewegen, pollt `/api/sync/status` und wartet, bis sich der `buchungen`-Count für `SYNC_QUIET_MS` (Default 8 s) nicht mehr erhöht. Erst dann geht es an `pg_dump` und das Foto-Verzeichnis. So landen ausstehende Client-Outbox-Items im Backup.

**Reihenfolge im ZIP:**

```
castel-backup-<stamp>.zip
├── manifest.json      # Metadaten: createdAt, serverTime, dbCounts, fotoCount
├── dump.pgdump        # pg_dump -Fc — Custom-Format, komprimiert
└── fotos/             # Spiegel von FOTOS_DIR (Artikel-IDs als Unterordner)
```

### Restore

```bash
# WICHTIG: vor dem Restore den api-Service stoppen, sonst überschreiben
# sich Resolver und Restore gegenseitig:
#   docker compose stop api

export $(grep -E '^DB_' .env | xargs)
export FOTOS_DIR=/srv/castel/fotos

node scripts/restore.mjs /srv/castel/backups/castel-backup-2026-10-19T…zip
# → [restore] entpacke …
# → [restore] manifest: …
# → [restore] pg_restore …
# → [restore] Fotos zurückgespielt
# → [restore] fertig. API kann jetzt wieder gestartet werden.
```

Das Skript bricht mit Exit-Code 2 ab, wenn `/api/healthz` noch antwortet — das ist die Aufforderung, den Service vorher zu stoppen. Mit `RESTORE_FORCE=1` lässt sich der Check überschreiben (für Test-Setups, nicht für den Ernstfall).

### Automatisierung

Die Skripte sind bewusst Framework-frei (plain Node + `pg_dump`/`pg_restore` + `zip`). Sie lassen sich direkt per Cron, systemd-Timer oder aus einem Backup-Wrapper-Skript heraus aufrufen. Beispiel:

```bash
# /etc/cron.d/castel-backup — täglich 02:00
0 2 * * * castel /opt/castel/scripts/castel-backup-cron.sh
```

`scripts/castel-backup-cron.sh` ist als Vorlage im Repo (Dummy-Skript, eigene Implementierung).

## 📄 Lizenz

[MIT](./LICENSE) — siehe Datei.

---

## 🙏 Dankeschön

- [Dexie.js](https://dexie.org/) für die IndexedDB-Abstraktion
- [Fastify](https://fastify.dev/) für das flotte HTTP-Framework
- [Drizzle ORM](https://orm.drizzle.team/) für typsichere DB-Queries
- [ZXing](https://github.com/zxing-js/library) für Barcode-Decoding-Fallback
- [browser-image-compression](https://www.npmjs.com/package/browser-image-compression) für clientseitige Bildkompression
