// dev-reset.ts — DEV_MODE Startup-Reset.
//
// Wenn config.DEV_MODE === true (gesteuert ueber .env / docker-compose),
// leert diese Funktion beim API-Startup alle Daten-Tabellen, BEVOR der
// HTTP-Server antwortet. Effekt: bei jedem Container-Start ist das
// System leer, der erste User muss ueber das PWA-Setup-Formular
// angelegt werden.
//
// Sicherheit:
//   * Bei DEV_MODE !== true ist die Funktion ein No-Op.
//   * Migrationen laufen vorher (siehe api entrypoint: node dist/db/migrate.js
//     && exec node dist/index.js in docker-compose.yml). Wir truncaten
//     also immer auf einem gueltigen Schema.
//   * Es wird auch ein Log-Eintrag auf WARN-Niveau geschrieben, damit
//     im Container-Log klar sichtbar ist, dass Daten verloren gehen.
//
// Reihenfolge beim Truncate:
//   * Erst abhaengige Daten (fotos, buchungen, audit_log, einstellungen,
//     refresh_tokens), dann die un-abhaengigen (artikel, standorte,
//     projekte, users). Postgres erlaubt TRUNCATE ... CASCADE, das alle
//     referenzierten Zeilen mitnimmt, aber wir machen es explizit
//     fuer mehr Kontrolle.
//
// Verwendung:
//   await truncateAllDataTables()   // in index.ts beim Startup,
//                                    // nur wenn config.DEV_MODE.

import postgres from 'postgres'
import { config } from '../config/config.js'

// Reihenfolge: leaf-zuerst (Daten), dann roots (Master).
// Wichtig: 'refresh_tokens' hat FK auf 'users' mit ON DELETE CASCADE,
// also muss users ZUERST geleert werden, damit die CASCADE greift und
// die refresh_tokens automatisch weg sind. Trotzdem listen wir sie
// explizit mit auf — schadet nicht und ist Audit-freundlicher.
const TABLES_IN_TRUNCATE_ORDER = [
  // Daten zuerst
  'buchungen',
  'fotos',
  'audit_log',
  'einstellungen',
  'refresh_tokens',
  // Master danach
  'artikel',
  'standorte',
  'projekte',
  'users',
] as const

/**
 * Loescht alle Zeilen aus den Daten- und Auth-Tabellen. Bei DEV_MODE=false
 * ein No-Op. Kehrt ohne Fehler zurueck, wenn die Tabellen noch nicht
 * existieren (z. B. wenn der erste API-Start vor den Migrationen laeuft —
 * sicherheitshalber, obwohl das normalerweise nicht passieren sollte).
 */
export async function truncateAllDataTables(): Promise<void> {
  if (!config.DEV_MODE) return

  // Eigener Client: getClient()/getDb() wuerde den Singleton initialisieren
  // und beim spaeteren closeDb() geschlossen werden, was wir hier nicht
  // brauchen. Direkter postgres-js-Client, einmalig, am Ende schliessen.
  const client = postgres(config.DATABASE_URL, {
    max: 1,
    connect_timeout: 5,
    prepare: false,
  })

  try {
    // Pruefen, welche der Tabellen tatsaechlich existieren. Falls die
    // Migrationen aus irgendeinem Grund noch nicht gelaufen sind (z. B.
    // der Aufruf wurde versehentlich vor node dist/db/migrate.js gemacht),
    // schlagen wir nicht hart fehl, sondern melden es im Log.
    const existingRows = await client`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY(${TABLES_IN_TRUNCATE_ORDER})
    `
    const existing = new Set(existingRows.map((r) => r.tablename as string))
    const vorhanden = TABLES_IN_TRUNCATE_ORDER.filter((t) => existing.has(t))

    if (vorhanden.length === 0) {
      console.warn(
        '[dev-reset] DEV_MODE=true, aber keine Daten-Tabellen vorhanden ' +
          '(Migrationen noch nicht gelaufen?). Ueberspringe Truncate.',
      )
      return
    }

    // eslint-disable-next-line no-console
    console.warn(
      `[dev-reset] DEV_MODE=true → TRUNCATE ${vorhanden.join(', ')} ` +
        '(Datenverlust!). Wird im Container-Log sichtbar gehalten.',
    )

    // Quote-Bezeichner: Tabellennamen sind statisch (von uns), nicht von
    // User-Input, aber pg-formatierung schadet nie.
    for (const t of vorhanden) {
      await client.unsafe(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`)
    }

    // eslint-disable-next-line no-console
    console.warn(
      '[dev-reset] TRUNCATE OK. System ist leer. Setup-Formular wartet ' +
        'auf den ersten Admin.',
    )
  } finally {
    await client.end({ timeout: 5 })
  }
}