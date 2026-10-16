// Vollständiger Daten-Backup als JSON.
// Enthält alle Tabellen und ist zur Wiederherstellung gedacht.

import { getDb } from '../../db/database'
import type {
  Artikel,
  AuditLogEintrag,
  Buchung,
  Einstellung,
  Projekt,
  Standort,
} from '../../db/types'

export interface Backup {
  schema: string
  exportiertAm: string
  artikel: Artikel[]
  standorte: Standort[]
  buchungen: Buchung[]
  commission: Projekt[]
  einstellungen: Einstellung[]
  auditLog: AuditLogEintrag[]
}

export async function exportVollBackup(): Promise<Backup> {
  const db = getDb()
  const [artikel, standorte, buchungen, commission, einstellungen, auditLog] = await Promise.all([
    db.artikel.toArray(),
    db.standorte.toArray(),
    db.buchungen.toArray(),
    db.commission.toArray(),
    db.einstellungen.toArray(),
    db.auditLog.toArray(),
  ])
  return {
    schema: 'castel-backup-1',
    exportiertAm: new Date().toISOString(),
    artikel,
    standorte,
    buchungen,
    commission,
    einstellungen,
    auditLog,
  }
}

/** Wandelt ein Backup in einen eingerückten JSON-String. */
export function backupAlsText(b: Backup): string {
  return JSON.stringify(b, null, 2)
}

/**
 * Stellt ein Backup wieder her. Schreibt in einer Dexie-Transaktion;
 * bei Fehler vollständiger Rollback.
 */
export async function restoreBackup(b: Backup): Promise<void> {
  if (b.schema !== 'castel-backup-1') {
    throw new Error(`Unbekanntes Backup-Schema: ${b.schema}`)
  }
  const db = getDb()
  await db.transaction(
    'rw',
    [db.artikel, db.standorte, db.buchungen, db.commission, db.einstellungen, db.auditLog],
    async () => {
      await db.artikel.clear()
      await db.standorte.clear()
      await db.buchungen.clear()
      await db.commission.clear()
      await db.einstellungen.clear()
      await db.auditLog.clear()
      await db.artikel.bulkAdd(b.artikel)
      await db.standorte.bulkAdd(b.standorte)
      await db.buchungen.bulkAdd(b.buchungen)
      await db.commission.bulkAdd(b.commission)
      await db.einstellungen.bulkAdd(b.einstellungen)
      await db.auditLog.bulkAdd(b.auditLog)
    },
  )
}
