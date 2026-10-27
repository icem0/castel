// Composable: commissions (Kommissionen) for the booking form.
//
// Source: `einstellungen.kommissionen` (JSON array, configurable) plus the
//         distinct `projekt` values from `buchungen` (historical values that
//         are no longer part of the list) — same pattern as `useArtikelTypen`.
//
// Every user may add a commission from the form. The server merges such a
// contribution with the stored list (union), so a user can never remove
// entries — that stays exclusive to the admin.

import { computed } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useBuchungStore } from '../stores/buchung'

export interface KommissionVerwendung {
  name: string
  /** How many bookings reference this commission. */
  anzahl: number
  /** True when the name comes from the settings list. */
  konfiguriert: boolean
  /** True when the name only exists in bookings (not in the list). */
  verwaist: boolean
}

/** Upper bound for the length of a commission name (mirrors the server). */
export const MAX_KOMMISSION_LAENGE = 120

export type KommissionFehler = 'leer' | 'duplikat' | 'zuLang'

export function useKommissionen() {
  const settings = useSettingsStore()
  const buchungStore = useBuchungStore()

  /**
   * Union of configured commissions and the ones actually used in bookings.
   * Configured commissions come first (in the configured order), orphaned
   * ones follow alphabetically.
   */
  const verwendungen = computed<KommissionVerwendung[]>(() => {
    const konfiguriert = settings.settings.kommissionen
    const counts = new Map<string, number>()
    for (const b of buchungStore.buchungen) {
      const name = b.projekt?.trim()
      if (!name) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const verwaiste = [...counts.keys()].filter((n) => !konfiguriert.includes(n)).sort()

    const result: KommissionVerwendung[] = []
    for (const name of konfiguriert) {
      result.push({ name, anzahl: counts.get(name) ?? 0, konfiguriert: true, verwaist: false })
    }
    for (const name of verwaiste) {
      result.push({ name, anzahl: counts.get(name) ?? 0, konfiguriert: false, verwaist: true })
    }
    return result
  })

  /** All selectable names (configured first, then orphaned) — for the dropdown. */
  const optionen = computed<string[]>(() => verwendungen.value.map((v) => v.name))

  /** True when the name is already part of the list. */
  function istVorhanden(name: string): boolean {
    return settings.settings.kommissionen.includes(name)
  }

  /**
   * Adds a commission to the global list. Non-admins may only add — the
   * server merges the contribution with the stored list.
   *
   * Returns the reason why the name was rejected, or `null` on success.
   */
  async function hinzufuegen(name: string): Promise<KommissionFehler | null> {
    const wert = name.trim()
    if (wert === '') return 'leer'
    if (wert.length > MAX_KOMMISSION_LAENGE) return 'zuLang'
    if (istVorhanden(wert)) return 'duplikat'
    await settings.setKommissionen([...settings.settings.kommissionen, wert])
    return null
  }

  return {
    verwendungen,
    optionen,
    istVorhanden,
    hinzufuegen,
  }
}
