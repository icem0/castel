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

## 📄 Lizenz

[MIT](./LICENSE) — siehe Datei.

---

## 🙏 Dankeschön

- [Dexie.js](https://dexie.org/) für die IndexedDB-Abstraktion
- [Fastify](https://fastify.dev/) für das flotte HTTP-Framework
- [Drizzle ORM](https://orm.drizzle.team/) für typsichere DB-Queries
- [ZXing](https://github.com/zxing-js/library) für Barcode-Decoding-Fallback
- [browser-image-compression](https://www.npmjs.com/package/browser-image-compression) für clientseitige Bildkompression
