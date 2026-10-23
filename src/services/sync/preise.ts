// Rollenabhaengige Preis-Bereinigung auf dem Client.
//
// Der Netto-Einkaufspreis (`artikel.einkaufspreis`) ist vertraulich und
// wird vom Server nur an Admins ausgeliefert. Auf einem geteilten Geraet
// koennen nach einem Admin-Login jedoch noch lokale Preise in IndexedDB
// (und in pending Outbox-Payloads) stehen. Beim Wechsel auf eine
// Nicht-Admin-Rolle werden sie deshalb entfernt.
//
// Umgekehrt reicht ein inkrementeller Snapshot nach einer BeFOERDERUNG
// zum Admin nicht aus: unveraenderte Artikel-Zeilen wuerden nicht erneut
// geliefert. Deshalb wird in diesem Fall der `sync.lastPullAt`-Marker
// geleert, damit der naechste Lauf einen vollen Snapshot zieht.

import { getDb } from '../../db/database'
import { jetztIso } from '../../domain/ids'

const ROLLE_KEY = 'castel.sync.lastRole'

function leseLetzteRolle(): string | null {
  try {
    return localStorage.getItem(ROLLE_KEY)
  } catch {
    return null
  }
}

function schreibeLetzteRolle(rolle: 'admin' | 'user'): void {
  try {
    localStorage.setItem(ROLLE_KEY, rolle)
  } catch {
    // localStorage kann in privaten Kontexten gesperrt sein — dann greift
    // die Bereinigung beim naechsten Rollenwechsel trotzdem noch.
  }
}

/**
 * Entfernt lokal gespeicherte Einkaufspreise aus Artikeln und aus noch
 * nicht gepushten Artikel-Outbox-Eintraegen.
 *
 * Bewusst ohne `geaendertAm`-Update: die Bereinigung ist eine lokale
 * Sicherheitsmaßnahme, keine fachliche Aenderung. Es wird kein Outbox-Op
 * erzeugt und der Server bleibt unberuehrt.
 */
export async function bereinigeEinkaufspreiseLokal(): Promise<void> {
  const db = getDb()
  await db.artikel
    .filter((a) => a.einkaufspreis !== null && a.einkaufspreis !== undefined)
    .modify({ einkaufspreis: null })

  const artikelOps = await db.outbox.where('entity').equals('artikel').toArray()
  for (const op of artikelOps) {
    try {
      const payload = JSON.parse(op.payload) as Record<string, unknown>
      if (!payload || typeof payload !== 'object') continue
      if (payload['einkaufspreis'] === null || payload['einkaufspreis'] === undefined) continue
      payload['einkaufspreis'] = null
      await db.outbox.update(op.id, { payload: JSON.stringify(payload) })
    } catch {
      // Korrupte Outbox-Payloads werden vom Sync separat behandelt.
    }
  }
}

/**
 * Wird vor jedem Sync-Lauf aufgerufen. Haelt die lokale Preissicht mit
 * der aktuellen Rolle konsistent.
 */
export async function prepareRoleForSync(istAdmin: boolean): Promise<void> {
  const letzteRolle = leseLetzteRolle()

  if (istAdmin) {
    if (letzteRolle !== 'admin') {
      // Foerderung zum Admin (oder erster Lauf nach dem Update): voller
      // Pull, damit die zuvor gestrippten Preise ankommen.
      await getDb().einstellungen.put({
        key: 'sync.lastPullAt',
        userId: '',
        value: '',
        geaendertAm: jetztIso(),
      })
    }
    schreibeLetzteRolle('admin')
    return
  }

  if (letzteRolle !== 'user') {
    await bereinigeEinkaufspreiseLokal()
  }
  schreibeLetzteRolle('user')
}
