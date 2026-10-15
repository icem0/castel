// Composable: aktive Artikel-Typen + Mapping, welche Typen von welchen Artikeln benutzt werden.
//
// Quelle: `einstellungen.artikelTypen` (JSON-Array, konfigurierbar) +
//         distinct(typ) aus `artikel` (für historische Werte, die nicht mehr in der Liste stehen).

import { computed } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useArtikelStore } from '../stores/artikel'

export interface TypVerwendung {
  typ: string
  /** Wie viele (nicht-archivierte) Artikel nutzen diesen Typ aktuell. */
  anzahl: number
  /** True, wenn der Typ aus den Einstellungen kommt. */
  konfiguriert: boolean
  /** True, wenn der Typ aus Altartikeln stammt und nicht (mehr) in den Einstellungen steht. */
  verwaist: boolean
}

export function useArtikelTypen() {
  const settings = useSettingsStore()
  const artikelStore = useArtikelStore()

  /**
   * Union aus konfigurierten Typen und tatsächlich benutzten Typen.
   * Konfigurierte Typen stehen vorne in der eingestellten Reihenfolge.
   * Verwaiste Typen (nur in Artikeln, nicht in der Liste) folgen alphabetisch.
   */
  const typVerwendungen = computed<TypVerwendung[]>(() => {
    const konfiguriert = settings.settings.artikelTypen
    const aktive = artikelStore.artikel.filter((a) => a.status !== 'archiviert')
    const counts = new Map<string, number>()
    for (const a of aktive) counts.set(a.typ, (counts.get(a.typ) ?? 0) + 1)

    const verwaiste = [...counts.keys()].filter((t) => !konfiguriert.includes(t)).sort()

    const result: TypVerwendung[] = []
    for (const t of konfiguriert) {
      result.push({ typ: t, anzahl: counts.get(t) ?? 0, konfiguriert: true, verwaist: false })
    }
    for (const t of verwaiste) {
      result.push({ typ: t, anzahl: counts.get(t) ?? 0, konfiguriert: false, verwaist: true })
    }
    return result
  })

  /** Nur die konfigurierten Typen in UI-Reihenfolge (z. B. für Dropdown). */
  const nurKonfigurierte = computed<string[]>(() =>
    typVerwendungen.value.filter((t) => t.konfiguriert).map((t) => t.typ),
  )

  /** Konfigurierte + verwaiste Typen in stabiler Reihenfolge (für Dropdown
   *  im Artikel-Form, damit Artikel mit verwaistem Typ bearbeitbar bleiben). */
  const alleWaehlbaren = computed<string[]>(() => typVerwendungen.value.map((t) => t.typ))

  /** Alle je benutzten Typen (z. B. für Filter-Dropdown in der Artikel-Liste). */
  const alleBenutzten = computed<string[]>(() =>
    [...new Set(typVerwendungen.value.map((t) => t.typ))].sort(),
  )

  function anzahlFuerTyp(typ: string): number {
    return typVerwendungen.value.find((t) => t.typ === typ)?.anzahl ?? 0
  }

  function istInVerwendung(typ: string): boolean {
    return anzahlFuerTyp(typ) > 0
  }

  return {
    typVerwendungen,
    nurKonfigurierte,
    alleWaehlbaren,
    alleBenutzten,
    anzahlFuerTyp,
    istInVerwendung,
  }
}
