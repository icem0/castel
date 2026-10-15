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
# argon2 braucht libc / libstdc++
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps   /app/node_modules ./node_modules
COPY --from=build  /app/dist          ./dist
# SQL-Migrationen: werden vom migrator zur Laufzeit gelesen.
# Liegen unter dist/migrations/, damit der Pfad relativ zu
# dist/db/migrate.js ('../migrations') direkt stimmt.
COPY --from=build  /app/src/db/migrations ./dist/migrations
COPY package.json ./

# Verzeichnis für Foto-Speicher
RUN mkdir -p /var/lib/castel/fotos
ENV FOTOS_DIR=/var/lib/castel/fotos

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