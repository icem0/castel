// Mindestbestand je (Artikel, Standort): reaktiver Spiegel + Outbox-Schreibpfad.
//
// Die Tabelle ist sparse: eine Zeile existiert nur, wenn fuer das Lager ein
// positiver Wert konfiguriert ist. Ein Wert <= 0 bedeutet "kein Mindestbestand"
// und loescht die Zeile (Outbox-`delete`).
//
// Identitaet ist das Paar `[artikelId, standortId]` — es gibt keine UUID.
// Die Outbox-Payload enthaelt beide IDs; `payloadIdFor` bildet daraus
// `${artikelId}#${standortId}` (Spiegel der Server-Logik).

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { computed, onScopeDispose, ref } from 'vue'
import { getDb } from '../db/database'
import type { ArtikelStandortMindestbestand } from '../db/types'
import { jetztIso } from '../domain/ids'
import { queueOp } from '../services/sync/worker'

export const useArtikelStandortMindestbestandStore = defineStore(
  'artikelStandortMindestbestand',
  () => {
    const eintraege = ref<ArtikelStandortMindestbestand[]>([])
    const geladen = ref(false)
    let subscription: Subscription | null = null

    function start() {
      if (subscription) return
      subscription = liveQuery(() => getDb().artikelStandortMindestbestaende.toArray()).subscribe({
        next: (rows) => {
          eintraege.value = rows
          geladen.value = true
        },
        error: (e) => {
          console.error('artikelStandortMindestbestand liveQuery error:', e)
        },
      })
    }

    function stop() {
      subscription?.unsubscribe()
      subscription = null
    }

    onScopeDispose(stop)

    const byPaar = computed(
      () => new Map(eintraege.value.map((e) => [`${e.artikelId}#${e.standortId}`, e] as const)),
    )

    /** Konfigurierter Wert oder 0 (= kein Mindestbestand). */
    function wertFuer(artikelId: string, standortId: string): number {
      return byPaar.value.get(`${artikelId}#${standortId}`)?.mindestbestand ?? 0
    }

    /** Nur die konfigurierten Lager eines Artikels (positive Werte). */
    function fuerArtikel(artikelId: string): ArtikelStandortMindestbestand[] {
      return eintraege.value.filter((e) => e.artikelId === artikelId)
    }

    /**
     * Setzt den Mindestbestand fuer ein Paar. `wert <= 0` entfernt die Zeile
     * (sparse). Die Schreiboperation landet in der Outbox und wird beim
     * naechsten Sync gepusht.
     */
    async function setzen(artikelId: string, standortId: string, wert: number): Promise<void> {
      // Leere Eingabefelder liefern '' (v-model.number) — das bedeutet
      // "kein Mindestbestand" und entfernt die Zeile.
      const zahl = typeof wert === 'number' && Number.isFinite(wert) ? Math.trunc(wert) : 0
      const db = getDb()
      const now = jetztIso()
      const existing = await db.artikelStandortMindestbestaende.get([artikelId, standortId])

      if (zahl <= 0) {
        if (!existing) return
        await db.artikelStandortMindestbestaende.delete([artikelId, standortId])
        await queueOp('artikel_standort_mindestbestand', 'delete', {
          artikelId,
          standortId,
          mindestbestand: 0,
          geaendertAm: now,
          erstelltAm: existing.erstelltAm,
        })
        return
      }

      const row: ArtikelStandortMindestbestand = {
        artikelId,
        standortId,
        mindestbestand: zahl,
        geaendertAm: now,
        erstelltAm: existing?.erstelltAm ?? now,
      }
      await db.artikelStandortMindestbestaende.put(row)
      await queueOp('artikel_standort_mindestbestand', existing ? 'update' : 'create', row)
    }

    return {
      eintraege,
      geladen,
      start,
      stop,
      byPaar,
      wertFuer,
      fuerArtikel,
      setzen,
    }
  },
)
