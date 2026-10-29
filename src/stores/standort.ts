// Standort-Store: lädt die `standorte`-Tabelle reaktiv via Dexie liveQuery.
// Stellt außerdem Helfer für Standard-Standort und Filter bereit.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { computed, ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { Standort, StandortTyp } from '../db/types'
import { neueUuid, jetztIso } from '../domain/ids'
import { sortiereNachName } from '../domain/sortierung'
import { queueOp } from '../services/sync/worker'

export interface StandortEingabe {
  name: string
  typ: StandortTyp
  projekt?: string | null
  standard?: boolean
}

/**
 * Ein Standort kann nicht geloescht werden, solange Buchungen auf ihn
 * verweisen. Die View uebersetzt die Anzahl in eine lokalisierte Meldung
 * und bietet "Archivieren" als Alternative an.
 */
export class StandortHatBuchungenError extends Error {
  constructor(
    public readonly standortId: string,
    public readonly anzahl: number,
  ) {
    super(
      `Standort ${standortId} kann nicht gelöscht werden: ${anzahl} Buchung(en) verweisen auf ihn.`,
    )
    this.name = 'StandortHatBuchungenError'
  }
}

export const useStandortStore = defineStore('standort', () => {
  const standorte = ref<Standort[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    subscription = liveQuery(() => getDb().standorte.toArray()).subscribe({
      next: (rows) => {
        standorte.value = sortiereNachName(rows, (s) => s.name)
        geladen.value = true
      },
      error: (e) => {
        console.error('standort liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  const aktive = computed(() => standorte.value.filter((s) => !s.archiviert))
  const archivierte = computed(() => standorte.value.filter((s) => s.archiviert))
  const standardlager = computed(() => aktive.value.find((s) => s.standard) ?? null)
  const nachTyp = computed(() => {
    const m = new Map<StandortTyp, Standort[]>()
    for (const s of aktive.value) {
      const list = m.get(s.typ) ?? []
      list.push(s)
      m.set(s.typ, list)
    }
    return m
  })

  function byId(id: string): Standort | undefined {
    return standorte.value.find((s) => s.id === id)
  }

  async function anlegen(e: StandortEingabe): Promise<Standort> {
    const s: Standort = {
      id: neueUuid(),
      name: e.name,
      typ: e.typ,
      projekt: e.projekt ?? null,
      kennzeichen: null,
      standard: false,
      archiviert: false,
      geaendertAm: jetztIso(),
      erstelltAm: jetztIso(),
    }
    await getDb().transaction('rw', getDb().standorte, async () => {
      if (s.standard) {
        // Indexierter Zugriff auf `standard` (Dexie v5+).
        // IndexedDB speichert booleans als 0/1 — `equals(1)` = `true`.
        await getDb().standorte.where('standard').equals(1).modify({ standard: false })
      }
      await getDb().standorte.add(s)
    })
    await queueOp('standort', 'create', s)
    return s
  }

  async function setStandard(id: string): Promise<void> {
    const now = jetztIso()
    await getDb().transaction('rw', getDb().standorte, async () => {
      await getDb()
        .standorte.where('standard')
        .equals(1)
        .modify({ standard: false, geaendertAm: now })
      await getDb().standorte.update(id, { standard: true, geaendertAm: now })
    })
    const updated = await getDb().standorte.get(id)
    if (updated) await queueOp('standort', 'update', updated)
  }

  /**
   * Anzahl der Buchungen, die auf den Standort verweisen — als Quelle
   * (`standortId`) oder als Lagerungsziel (`standortZielId`). Beide
   * Indizes existieren in Dexie (`id, artikelId, standortId, standortZielId, …`).
   *
   * Buchungen sind append-only (Korrekturen laufen ueber Storno- bzw.
   * Gegenbuchungen), eine lokal vorhandene Buchung existiert also auch auf
   * dem Server. Der Zaehler ist damit eine verlaessliche Untergrenze fuer
   * die Server-Pruefung `HAS_DEPENDENCIES`.
   */
  async function referenzierteBuchungen(id: string): Promise<number> {
    const db = getDb()
    const [alsQuelle, alsZiel] = await Promise.all([
      db.buchungen.where('standortId').equals(id).count(),
      db.buchungen.where('standortZielId').equals(id).count(),
    ])
    return alsQuelle + alsZiel
  }

  /**
   * Umbenennen eines Standorts. Der Server wertet `update` per LWW ohne
   * Abhaengigkeits-Pruefung aus — Umbenennen ist deshalb auch moeglich,
   * wenn bereits Buchungen auf den Standort zeigen.
   */
  async function umbenennen(id: string, name: string): Promise<void> {
    const neuerName = name.trim()
    if (!neuerName) {
      throw new Error('Der Name darf nicht leer sein.')
    }
    const existing = await getDb().standorte.get(id)
    if (!existing) {
      throw new Error(`Standort ${id} nicht gefunden`)
    }
    const now = jetztIso()
    await getDb().standorte.update(id, { name: neuerName, geaendertAm: now })
    const updated = await getDb().standorte.get(id)
    if (updated) await queueOp('standort', 'update', updated)
  }

  async function archivieren(id: string): Promise<void> {
    const existing = await getDb().standorte.get(id)
    if (existing?.standard) {
      throw new Error('Das Hauptlager kann nicht archiviert werden.')
    }
    const now = jetztIso()
    await getDb().standorte.update(id, { archiviert: true, standard: false, geaendertAm: now })
    const updated = await getDb().standorte.get(id)
    if (updated) await queueOp('standort', 'update', updated)
  }

  async function wiederherstellen(id: string): Promise<void> {
    const now = jetztIso()
    await getDb().standorte.update(id, { archiviert: false, geaendertAm: now })
    const updated = await getDb().standorte.get(id)
    if (updated) await queueOp('standort', 'update', updated)
  }

  async function loeschen(id: string): Promise<void> {
    const existing = await getDb().standorte.get(id)
    if (!existing) return
    if (existing.standard) {
      throw new Error('Das Hauptlager kann nicht gelöscht werden.')
    }
    // Buchungen referenzieren den Standort ohne ON DELETE CASCADE — der
    // Server wuerde das Loeschen mit `HAS_DEPENDENCIES` ablehnen und der
    // Client legt das Outbox-Item in die Quarantaene. Wir pruefen vorab,
    // damit der User eine klare Handlungsanweisung bekommt statt eines
    // spaeten Sync-Fehlers. Der Server bleibt die Autoritaet: sind lokal
    // keine Buchungen sichtbar, entscheidet er.
    const anzahl = await referenzierteBuchungen(id)
    if (anzahl > 0) {
      throw new StandortHatBuchungenError(id, anzahl)
    }
    await getDb().standorte.delete(id)
    await queueOp('standort', 'delete', existing)
  }

  return {
    standorte,
    aktive,
    archivierte,
    standardlager,
    nachTyp,
    geladen,
    start,
    stop,
    byId,
    anlegen,
    setStandard,
    umbenennen,
    referenzierteBuchungen,
    archivieren,
    wiederherstellen,
    loeschen,
  }
})
