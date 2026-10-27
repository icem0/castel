// Composable: Bestellaktionen fuer eine Mindestbestand-Zeile.
//
// Kapselt den Hersteller-Lookup, den mailto:/Web-Link und das Setzen des
// "bestellt"-Markers, damit Glocke und Panel dieselbe Logik teilen.

import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import { useHerstellerStore } from '../stores/hersteller'
import { useAuthStore } from '../stores/auth'
import { kuerzelAusName } from '../domain/kuerzel'
import { bestellZiel, istBestelltFuerEreignis, type BestellZiel } from '../domain/bestellung'
import type { MindestbestandZeile } from '../stores/mindestbestand'

export function useBestellung() {
  const { t } = useI18n()
  const artikelStore = useArtikelStore()
  const herstellerStore = useHerstellerStore()
  const auth = useAuthStore()

  function artikelFuer(z: MindestbestandZeile) {
    return artikelStore.byId(z.ereignis.artikelId)
  }

  function istBestellt(z: MindestbestandZeile): boolean {
    return istBestelltFuerEreignis(artikelFuer(z), z.ereignis.erstelltAm)
  }

  /** Kuerzel des Users, der zuletzt bestellt hat ('' wenn unbekannt). */
  function kuerzel(z: MindestbestandZeile): string {
    return kuerzelAusName(artikelFuer(z)?.bestelltVon ?? '')
  }

  function bestelltAm(z: MindestbestandZeile): string | null {
    return artikelFuer(z)?.bestelltAm ?? null
  }

  /** Bestellziel des Artikels — `null`, wenn kein Kontakt hinterlegt ist. */
  function zielFuer(z: MindestbestandZeile, standortName: string): BestellZiel | null {
    const a = artikelFuer(z)
    if (!a?.herstellerId) return null
    const h = herstellerStore.byId(a.herstellerId)
    return bestellZiel(h, {
      betreff: t('view.mindestbestand.bestellMailBetreff', { titel: a.titel }),
      text: t('view.mindestbestand.bestellMailText', {
        titel: a.titel,
        bestellnummer: a.bestellnummer ?? '—',
        standort: standortName,
        defizit: z.defizit,
        mindest: z.schwelle ?? z.ereignis.mindestbestand,
      }),
    })
  }

  /** Markiert die Zeile als bestellt (wird beim Klick auf den Link gerufen). */
  async function bestellen(z: MindestbestandZeile): Promise<void> {
    await artikelStore.markiereBestellt(
      z.ereignis.artikelId,
      true,
      auth.erstelltVon,
      z.ereignis.erstelltAm,
    )
  }

  /** Haken umschalten (ohne Link zu oeffnen). */
  async function umschalten(z: MindestbestandZeile): Promise<void> {
    await artikelStore.markiereBestellt(
      z.ereignis.artikelId,
      !istBestellt(z),
      auth.erstelltVon,
      z.ereignis.erstelltAm,
    )
  }

  return { istBestellt, kuerzel, bestelltAm, zielFuer, bestellen, umschalten }
}
