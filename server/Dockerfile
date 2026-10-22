# Multi-Stage Build für den Fastify-API-Server.
# - deps:   installiert nur Production-Deps
# - build:  baut TypeScript nach JavaScript
# - runtime: minimaler Container mit Node + argon2-Binary

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# argon2 + node-gyp brauchen ggf. python3/make/g++ — vorinstallieren
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# argon2 braucht libc / libstdc++. postgresql-client-16 liefert pg_dump und
# pg_restore — OHNE das Binary kann der Server kein Backup erstellen
# ("spawn pg_dump ENOENT"). Der Backup-Cron und der Admin-Download
# brauchen es zwingend. unzip entpackt das Backup-ZIP beim Restore
# ("spawn unzip ENOENT" ohne es).
#
# WICHTIG: Die Client-Version MUSS zur Major-Version des Postgres-Servers
# passen (docker-compose.yml: db -> postgres:16-alpine). Ein aelterer
# pg_dump verweigert einen neueren Server ("aborting because of server
# version mismatch"), liefert einen 0-Byte-Dump und das Backup ist wertlos.
# Deshalb installieren wir den Client explizit aus dem PGDG-Repo in der
# passenden Major-Version (ARG PG_MAJOR) statt des Debian-Meta-Pakets
# 'postgresql-client' (bookworm = Version 15).
ARG PG_MAJOR=16
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl dumb-init unzip; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    . /etc/os-release; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}"; \
    apt-get purge -y --auto-remove curl || true; \
    rm -rf /var/lib/apt/lists/*; \
    pg_dump --version; \
    pg_restore --version

COPY --from=deps   /app/node_modules ./node_modules
COPY --from=build  /app/dist          ./dist
# SQL-Migrationen: werden vom migrator zur Laufzeit gelesen.
# Liegen unter dist/migrations/, damit der Pfad relativ zu
# dist/db/migrate.js ('../migrations') direkt stimmt.
COPY --from=build  /app/src/db/migrations ./dist/migrations
COPY package.json ./

# Verzeichnisse für Foto-Speicher und Backups. Absolute Pfade, weil
# der Container-User (castel) relativ zum Working-Dir (/app) keine
# Schreibrechte hat. BACKUP_DIR wird zusaetzlich in docker-compose.yml
# als ENV gesetzt und auf das Volume 'backups-data' gemountet.
RUN mkdir -p /var/lib/castel/fotos /var/lib/castel/backups
ENV FOTOS_DIR=/var/lib/castel/fotos
ENV BACKUP_DIR=/var/lib/castel/backups

# Non-root-User
RUN groupadd -r castel && useradd -r -g castel castel \
 && chown -R castel:castel /var/lib/castel
USER castel

EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
# Migrationen vor jedem Server-Start ausfuehren (idempotent: bereits
# angewendete SQL-Dateien werden uebersprungen). Im Image verankert, damit
# es auch ohne angepasstes docker-compose.yml auf dem Deployer funktioniert.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]