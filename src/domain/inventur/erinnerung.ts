// Inventur-Stichtag-Erinnerung: rein client-seitig aus den gesyncten
// globalen Settings (`inventur.stichtag`, `inventur.vorlaufTage`) und dem
// lokalen Freeze-Status berechnet.
//
// Aktiv: Stichtag gesetzt, nicht abgeschlossen und tageBisStichtag <= vorlaufTage.
// Überfällig: Stichtag gesetzt, nicht abgeschlossen und der Stichtag ist
// bereits verstrichen.

/** Der Stichtag als Date (Mitternacht UTC) für ein gegebenes DD.MM.YYYY. */
function stichtagAlsDate(stichtag: string): Date | null {
  const m = stichtag.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (!m) return null
  const tag = Number.parseInt(m[1] ?? '', 10)
  const monat = Number.parseInt(m[2] ?? '', 10)
  const jahr = Number.parseInt(m[3] ?? '', 10)
  const d = new Date(Date.UTC(jahr, monat - 1, tag))
  if (d.getUTCFullYear() !== jahr || d.getUTCMonth() !== monat - 1 || d.getUTCDate() !== tag)
    return null
  return d
}

/** Tage bis zum Stichtag (gerundet auf ganze Tage, kann negativ sein). */
export function tageBisStichtag(stichtag: string, jetzt: Date): number | null {
  const ziel = stichtagAlsDate(stichtag)
  if (!ziel) return null
  const jetztUtc = new Date(
    Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate()),
  )
  const diff = ziel.getTime() - jetztUtc.getTime()
  return Math.round(diff / (1000 * 60 * 60 * 24))
}

/** True, wenn der Stichtag bereits verstrichen ist. */
export function stichtagVerstrichen(stichtag: string, jetzt: Date): boolean | null {
  const ziel = stichtagAlsDate(stichtag)
  if (!ziel) return null
  const jetztUtc = new Date(
    Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate()),
  )
  return ziel.getTime() < jetztUtc.getTime()
}

/**
 * Ergebnis der Erinnerungsberechnung.
 */
export interface InventurErinnerung {
  /** Ob die Erinnerung aktuell aktiv angezeigt werden soll. */
  aktiv: boolean
  /** Ob der Stichtag bereits verstrichen ist (überfällig). */
  ueberfaellig: boolean
  /** Tage bis zum nächsten Stichtag (null wenn kein Stichtag gesetzt). */
  tageBisStichtag: number | null
  /** Grund für Inaktivität, wenn nicht aktiv. */
  grund: 'nichtGesetzt' | 'bereitsAbgeschlossen' | 'nochNichtFaellig' | null
}

/**
 * Berechnet den Erinnerungsstatus für den Inventur-Stichtag.
 *
 * @param stichtag - DD.MM.YYYY, null wenn nicht gesetzt
 * @param vorlaufTage - Erinnerungs-Vorlauf in Tagen (0–365)
 * @param abgeschlossen - ob ein abgeschlossener Stichtag für dieses Datum existiert
 * @param jetzt - Referenzzeitpunkt (UTC)
 */
export function berechneInventurErinnerung(
  stichtag: string | null,
  vorlaufTage: number,
  abgeschlossen: boolean,
  jetzt: Date,
): InventurErinnerung {
  if (!stichtag) {
    return { aktiv: false, ueberfaellig: false, tageBisStichtag: null, grund: 'nichtGesetzt' }
  }
  if (abgeschlossen) {
    return {
      aktiv: false,
      ueberfaellig: false,
      tageBisStichtag: null,
      grund: 'bereitsAbgeschlossen',
    }
  }
  const tage = tageBisStichtag(stichtag, jetzt)
  if (tage === null) {
    return { aktiv: false, ueberfaellig: false, tageBisStichtag: null, grund: 'nichtGesetzt' }
  }
  const ueberfaellig = tage <= 0 && stichtagVerstrichen(stichtag, jetzt) === true
  const aktiv = tage <= vorlaufTage && !ueberfaellig
  return {
    aktiv,
    ueberfaellig,
    tageBisStichtag: tage,
    grund: aktiv ? null : 'nochNichtFaellig',
  }
}

/** Prüft, ob für einen Stichtag bereits ein abgeschlossener Snapshot existiert. */
export function istAbgeschlossen(
  stichtag: string,
  inventurStichtage: { id: string; stichtag: string; status: string }[],
): boolean {
  // Der Server liefert den Stichtag als DD.MM.YYYY zurück, das Setting
  // (und `stichtag`) ist ebenfalls DD.MM.YYYY. Direkter String-Vergleich.
  return inventurStichtage.some((s) => s.stichtag === stichtag && s.status === 'abgeschlossen')
}
