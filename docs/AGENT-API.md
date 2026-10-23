# castel Agent API

Machine-readable access for AI agents, scripts and integrations.

- REST base: `/api/v1`
- MCP endpoint: `/api/mcp` (Streamable HTTP, stateless)
- OpenAPI UI: `/api/docs`
- OpenAPI JSON: `/api/docs/json`
- Discovery: `GET /api/v1/meta` (public, no key)

The existing PWA/sync endpoints remain JWT-only. API keys are accepted
exclusively on `/api/v1/*` and `/api/mcp`.

## Authentication

Create a key in the PWA under **Settings → Data → API keys** (or
**Einstellungen → Daten → API-Keys**). The plaintext key is shown exactly
once. The server stores only a SHA-256 hash and a short prefix.

Send the key with either header:

```http
Authorization: Bearer castel_ab12cd34_...
```

```http
X-API-Key: castel_ab12cd34_...
```

### Scopes

| Scope | Allows |
| --- | --- |
| `read` | List/read articles, locations, stock, bookings, commissions and minimum-stock events |
| `write` | Create/update articles, create bookings, cancel bookings, reassign commissions |
| `admin` | Read the audit log. Implies `read` and `write` |

`write` does **not** imply `read`. A key can hold multiple scopes. Only
admin users may create a key with `admin`.

Keys can only be managed with a JWT session. An API key cannot create or
revoke other API keys.

### Rate limit

Default: 120 requests per minute per key (`RATE_LIMIT_API_MAX`,
`RATE_LIMIT_API_WINDOW`). Exceeding it returns HTTP 429 `RATE_LIMITED`.

## Domain rules

- Stock is the sum of all non-cancelled bookings. Amounts are never
  overwritten.
- Bookings are immutable. Corrections use `storno` (cancellation) or a
  compensation booking.
- Amounts are integers in pieces (`menge`), prices are integers in cents
  (`listenpreis`), IDs are UUIDs, timestamps are ISO-8601 UTC.
- `einlagerung` and `entnahme` take a **positive** `menge`; the server
  stores the correct sign.
- `umlagerung` requires `vonStandortId` and `nachStandortId`, no `menge`.
- `inventur` requires `sollMenge` (target amount, not the difference).
- Removing more than available returns HTTP 409 `NEGATIVE_BESTAND` and
  changes nothing.

See `src/api/v1/schemas.ts` for the exact Zod contracts; the OpenAPI
document is generated from the same schemas.

## REST quick start

```bash
export CASTEL_KEY='castel_...'
export CASTEL_URL='https://castel.example.com'

curl -s "$CASTEL_URL/api/v1/meta"

curl -s -H "Authorization: Bearer $CASTEL_KEY" \
  "$CASTEL_URL/api/v1/artikel?q=kabel&limit=20"

curl -s -H "Authorization: Bearer $CASTEL_KEY" \
  "$CASTEL_URL/api/v1/bestand?artikelId=<uuid>"

curl -s -X POST -H "Authorization: Bearer $CASTEL_KEY" \
  -H 'Content-Type: application/json' \
  "$CASTEL_URL/api/v1/buchungen" \
  -d '{
    "typ": "entnahme",
    "artikelId": "<uuid>",
    "standortId": "<uuid>",
    "menge": 3,
    "projekt": "Baustelle Nord",
    "kommentar": "Agenten-Test"
  }'
```

Create a booking supports an optional client `id` (UUID) for idempotent
retries: the same UUID is not booked twice.

## Endpoints

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/meta` | public | Version, docs, MCP endpoint, units, limits, error codes |
| GET | `/api/v1/status` | read | Server time and row counts |
| GET | `/api/v1/artikel` | read | Search/filter articles (`q`, `typ`, `status`, `barcode`, `limit`, `offset`) |
| POST | `/api/v1/artikel` | write | Create article |
| GET | `/api/v1/artikel/:id` | read | Article with stock per location and total |
| PATCH | `/api/v1/artikel/:id` | write | Update article fields |
| DELETE | `/api/v1/artikel/:id` | admin | Hard delete; 409 `HAS_DEPENDENCIES` if bookings exist |
| GET | `/api/v1/standorte` | read | List locations (`alle=true` includes archived) |
| POST | `/api/v1/standorte` | write | Create location |
| PATCH | `/api/v1/standorte/:id` | write | Update location |
| GET | `/api/v1/bestand` | read | Stock for `artikelId`, optional `standortId` |
| GET | `/api/v1/buchungen` | read | List bookings (`artikelId`, `standortId`, `typ`, `von`, `bis`, `nurAktive`) |
| POST | `/api/v1/buchungen` | write | Create booking |
| POST | `/api/v1/buchungen/:id/storno` | write | Cancel booking (`{ "grund": "..." }`) |
| POST | `/api/v1/buchungen/:id/kommission` | write | Cancel and rebook under another commission |
| GET | `/api/v1/kommissionen` | read | List commissions/projects |
| GET | `/api/v1/mindestbestand` | read | Minimum-stock events |
| GET | `/api/v1/audit` | admin | Audit log |

Pagination uses `limit` (1–200, default 50) and `offset`.

### Error shape

```json
{
  "code": "NEGATIVE_BESTAND",
  "message": "Bestand reicht nicht aus",
  "details": { "currentBestand": 2 }
}
```

Codes: `VALIDATION`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `NEGATIVE_BESTAND`, `UNKNOWN_REFERENCE`, `HAS_DEPENDENCIES`,
`RATE_LIMITED`, `INTERNAL`.

## MCP

The server exposes a stateless Streamable-HTTP MCP endpoint at
`/api/mcp`. Configure the agent with the API key as bearer token:

```json
{
  "mcpServers": {
    "castel": {
      "type": "http",
      "url": "https://castel.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer castel_..."
      }
    }
  }
}
```

Tools (all map to the REST service layer and enforce scopes):

| Tool | Scope | Purpose |
| --- | --- | --- |
| `castel_get_meta` | read | Discovery metadata |
| `castel_get_status` | read | Server time and row counts |
| `castel_search_artikel` | read | Search/filter articles |
| `castel_get_artikel` | read | Article with stock |
| `castel_list_standorte` | read | List locations |
| `castel_get_bestand` | read | Stock per article/location |
| `castel_list_buchungen` | read | Booking history |
| `castel_create_buchung` | write | Create booking |
| `castel_storno_buchung` | write | Cancel booking |
| `castel_kommissioniere_buchung` | write | Reassign commission |
| `castel_create_artikel` | write | Create article |
| `castel_update_artikel` | write | Update article |
| `castel_list_mindestbestand` | read | Minimum-stock events |
| `castel_list_kommissionen` | read | List commissions |

The server sends usage instructions during MCP initialization. GET and
DELETE on the endpoint return 405 by design (stateless mode has no
standalone SSE stream).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_KEYS_ENABLED` | `true` | Enable key management endpoints |
| `API_KEY_MAX_PER_USER` | `10` | Max active keys per user |
| `RATE_LIMIT_API_MAX` | `120` | Requests per window per key |
| `RATE_LIMIT_API_WINDOW` | `1 minute` | Rate-limit window |
| `MCP_ENABLED` | `true` | Enable `/api/mcp` |
| `MCP_PATH` | `/api/mcp` | MCP endpoint path |
| `API_DOCS_ENABLED` | `true` | Serve `/api/docs` and `/api/docs/json` |

## Security notes

- Never commit keys. Store them in the agent's secret store.
- Revoke a key immediately if it leaks: Settings → API keys → Revoke.
- Prefer short expiry dates for temporary agents.
- Use the smallest scope set that works. A read-only agent only needs
  `read`.
