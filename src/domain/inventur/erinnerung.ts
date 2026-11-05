// Inventur-Stichtag-Erinnerung: rein client-seitig aus den gesyncten
// globalen Settings (`inventur.stichtag`, `inventur.vorlaufTage`) und dem
// lokalen Freeze-Status berechnet.
//
// Aktiv: Stichtag gesetzt, nicht abgeschlossen und tageBisStichtag <= vorlaufTage.
// Überfällig: Stichtag gesetzt, nicht abgeschlossen und der Stichtag in
// diesem Kalenderjahr ist bereits verstrichen.

/** Der nächste Stichtag als Date (Mitternacht UTC) für ein gegebenes MM-TT. */
function naechsterStichtag(monat: number, tag: number, jetzt: Date): Date {
  const jahr = jetzt.getUTCFullYear()
  const kandidat = new Date(Date.UTC(jahr, monat - 1, tag))
  // Wenn der Stichtag in diesem Jahr schon vorbei ist, nächstes Jahr.
  if (kandidat.getTime() < jetzt.getTime()) {
    return new Date(Date.UTC(jahr + 1, monat - 1, tag))
  }
  return kandidat
}

/** Tage bis zum nächsten Stichtag (gerundet auf ganze Tage, kann negativ sein). */
export function tageBisStichtag(stichtag: string, jetzt: Date): number | null {
  const m = stichtag.match(/^(\d{2})-(\d{2})$/)
  if (!m) return null
  const monat = Number.parseInt(m[1] ?? '', 10)
  const tag = Number.parseInt(m[2] ?? '', 10)
  const jetztUtc = new Date(
    Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate()),
  )
  const ziel = naechsterStichtag(monat, tag, jetztUtc)
  const diff = ziel.getTime() - jetztUtc.getTime()
  return Math.round(diff / (1000 * 60 * 60 * 24))
}

/** True, wenn der Stichtag in diesem Kalenderjahr bereits verstrichen ist. */
export function stichtagVerstrichen(stichtag: string, jetzt: Date): boolean | null {
  const m = stichtag.match(/^(\d{2})-(\d{2})$/)
  if (!m) return null
  const monat = Number.parseInt(m[1] ?? '', 10)
  const tag = Number.parseInt(m[2] ?? '', 10)
  const jetztUtc = new Date(
    Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate()),
  )
  const stichtagDiesesJahr = new Date(Date.UTC(jetzt.getUTCFullYear(), monat - 1, tag))
  return stichtagDiesesJahr.getTime() < jetztUtc.getTime()
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
 * @param stichtag - MM-TT, null wenn nicht gesetzt
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
  // Der Server speichert den Stichtag als volles Datum (YYYY-MM-DD), das
  // Setting (und `stichtag`) ist MM-TT. Deshalb auf die letzten 5 Zeichen
  // vergleichen — funktioniert auch für alte MM-TT-Zeilen.
  const gesucht = stichtag.slice(-5)
  return inventurStichtage.some(
    (s) => s.stichtag.slice(-5) === gesucht && s.status === 'abgeschlossen',
  )
}
