// Settings-Store: liest die `einstellungen`-Tabelle reaktiv via Dexie liveQuery.
// Speichert sprache, standardStandortId, artikelTypen.
//
// Ab Dexie v5 sind die Einstellungen Cross-Device-synchronisiert:
//   - artikelTypen → userId = null (global, vom Admin gepflegt)
//   - sprache, standardStandortId → userId = <current user>
// Beim Setzen wird ein Outbox-Eintrag erzeugt, den der Sync-Worker zum
// Server pusht. Der Server ist Source of Truth (LWW auf geaendertAm).
//
// IndexedDB-Konvention: Dexie erlaubt kein `null` in Primary-Key-Komponenten.
// Wir speichern "global" als userId = '' (leerer String) und übersetzen
// in der Domain-Schicht zu/von null. Der TypeScript-Type bleibt null.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import { sessionLesen } from '../auth/session'
import { jetztIso, neueUuid } from '../domain/ids'
import { queueOp } from '../services/sync/worker'
import type { Einstellung } from '../db/types'

export type Sprache = 'de' | 'en'

export interface Settings {
  sprache: Sprache
  standardStandortId: string | null
  /** Konfigurierbare Liste der Artikel-Typen (Reihenfolge wie angelegt). */
  artikelTypen: string[]
}

const DEFAULTS: Settings = {
  sprache: 'de',
  standardStandortId: null,
  artikelTypen: ['Zubehör', 'Verbrauchsmaterial'],
}

const GLOBAL_KEYS = new Set<string>(['artikelTypen'])
const PER_USER_KEYS = new Set<string>(['sprache', 'standardStandortId'])
const GLOBAL_INDEX = ''

function scopeForKey(key: string): 'global' | 'user' {
  return GLOBAL_KEYS.has(key) ? 'global' : 'user'
}

function fromRows(rows: Einstellung[], currentUserId: string | null): Settings {
  // Domain-normalisierte Sicht: userId = '' wird wie null behandelt.
  const norm = (uid: string | null): string | null => (uid === '' ? null : uid)
  const byKey = new Map<string, Einstellung>()
  for (const r of rows) {
    const isGlobal = norm(r.userId) === null
    if (isGlobal) {
      byKey.set(r.key, r)
    } else if (currentUserId !== null && norm(r.userId) === currentUserId) {
      byKey.set(r.key, r)
    }
  }

  // artikelTypen wird als JSON-Array serialisiert; Fehlertoleranz bei Altbestand.
  let typen: string[] = DEFAULTS.artikelTypen
  const typenRow = byKey.get('artikelTypen')
  if (typenRow) {
    try {
      const parsed: unknown = JSON.parse(typenRow.value)
      if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) {
        typen = parsed
      }
    } catch {
      // bewusst ignorieren → Defaults
    }
  }

  const spracheRow = byKey.get('sprache')
  const spracheRaw = spracheRow?.value as Sprache | undefined
  const sprache: Sprache =
    spracheRaw === 'en' || spracheRaw === 'de' ? spracheRaw : DEFAULTS.sprache

  const standortRow = byKey.get('standardStandortId')
  const standardStandortId = standortRow?.value ? standortRow.value : DEFAULTS.standardStandortId

  return {
    sprache,
    standardStandortId,
    artikelTypen: typen,
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>({ ...DEFAULTS, artikelTypen: [...DEFAULTS.artikelTypen] })
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    const currentUserId = sessionLesen()?.userId ?? null
    const observable = liveQuery(() => getDb().einstellungen.toArray())
    subscription = observable.subscribe({
      next: (rows) => {
        settings.value = fromRows(rows, currentUserId)
        geladen.value = true
      },
      error: (e) => {
        console.error('settings liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  /**
   * Setzt eine Einstellung. userId wird automatisch aus dem aktuellen
   * Auth-State abgeleitet: global für artikelTypen, sonst current user.
   * Erzeugt zusätzlich einen Outbox-Eintrag für den Server-Sync.
   */
  async function setKey(key: string, value: string): Promise<void> {
    if (!PER_USER_KEYS.has(key) && !GLOBAL_KEYS.has(key)) {
      throw new Error(`Unbekannter Einstellungs-Key: ${key}`)
    }
    const scope = scopeForKey(key)
    const session = sessionLesen()
    const userId: string | null = scope === 'user' ? (session?.userId ?? null) : null
    if (scope === 'user' && userId === null) {
      // Vor Login sollte der User-Key gar nicht geschrieben werden. Wir
      // loggen und brechen ab, damit keine ungewollten globalen Zeilen
      // entstehen, die ein später angemeldeter User erbt.
      console.warn(`[settings] Per-User-Key "${key}" ohne aktiven User übersprungen`)
      return
    }
    const geaendertAm = jetztIso()
    // Domain-Sicht: userId = null für global. IndexedDB-Sicht: '' als
    // Primary-Key-Marker. Wir schreiben den normalisierten Datensatz in
    // die Outbox (an den Server geht null).
    const outboxRow: Einstellung = { key, userId, value, geaendertAm }
    const indexedRow: Einstellung = {
      key,
      userId: userId === null ? GLOBAL_INDEX : userId,
      value,
      geaendertAm,
    }
    await getDb().einstellungen.put(indexedRow)
    await queueOp('einstellung', 'upsert', outboxRow)
  }

  async function setSprache(sprache: Sprache): Promise<void> {
    await setKey('sprache', sprache)
  }

  async function setStandardStandort(id: string | null): Promise<void> {
    await setKey('standardStandortId', id ?? '')
  }

  async function setArtikelTypen(typen: string[]): Promise<void> {
    await setKey('artikelTypen', JSON.stringify(typen))
  }

  // Hilfsfunktion: legt eine UUID-basierte ID an (für Outbox-Einträge).
  void neueUuid

  return {
    settings,
    geladen,
    start,
    stop,
    setSprache,
    setStandardStandort,
    setArtikelTypen,
  }
})
