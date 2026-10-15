# castel-server

Fastify-Backend für die castel PWA.

## Dev-Setup

```bash
npm install
cp .env.example .env
# .env anpassen (DATABASE_URL, JWT_SECRET)
npm run db:migrate
npm run dev   # tsx watch
```

Beim ersten Aufruf der Login-Seite wird der allererste Admin-User direkt in
der PWA angelegt (Setup-Formular: Anzeigename + E-Mail + Passwort). Es ist
kein Bootstrap-Schritt aus der .env noetig.

## End-to-End-Test ohne Docker

```bash
npm install --save-dev embedded-postgres
node scripts/smoke-server.mjs
```

Startet embedded Postgres, Migrationen, Server und testet Healthz + Login + /me.

## Endpoints

- `/api/healthz` — Liveness
- `/api/auth/*` — Login, Refresh, Logout, Me, Change-Password
- `/api/sync/snapshot` (GET) — Pull seit `since`
- `/api/sync/push` (POST) — Bulk-Push max. 500 ops
- `/api/fotos/upload/:artikelId` (POST, multipart) — Upload
- `/api/fotos/list/:artikelId` (GET)
- `/api/fotos/:id` (DELETE, admin)
- `/api/users` (GET, admin)
- `/api/users` (POST, admin)
- `/api/users/:id` (PATCH, admin)
- `/api/users/:id` (DELETE, admin — soft-delete)

Siehe [README des Hauptrepos](../README.md#api) für Body-/Response-Schemas.

## Tests

```bash
npm run typecheck
npm run test:run
```

## Migrations-Werkzeuge

- `npm run db:generate` — Schema-Diff in neue SQL-Migration verwandeln (drizzle-kit)
- `npm run db:migrate` — Migrationen ausführen (gegen `DATABASE_URL` in `.env`)
- `npm run db:push` — Schema direkt in DB pushen (Dev)
- `npm run db:studio` — drizzle-kit Studio öffnen
- Initial-Admin: wird beim ersten Aufruf der Login-Seite per Setup-Formular angelegt.

## Container-Build

```bash
docker build -t castel-api .
docker run --rm -p 4242:3000 \
  -e DATABASE_URL=postgres://castel:castel@host.docker.internal:5432/castel \
  -e JWT_SECRET=... \
  -e FOTOS_DIR=/var/lib/castel/fotos \
  -v $PWD/var:/var/lib/castel \
  castel-api
```
