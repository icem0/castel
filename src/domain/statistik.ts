// Dashboard-Aggregationen.
//
// Alle Funktionen sind rein (keine Vue-/Pinia-Abhaengigkeiten) und
// arbeiten auf den bereits lokal gespiegelten Daten. Damit funktioniert
// das Dashboard vollstaendig offline und ist ohne Server-Roundtrip
// testbar.
//
// Wichtige Regeln aus AGENTS.md:
//   * Bestand = Summe der nicht-stornierten Buchungen
//   * Umlagerung besteht aus zwei Halbbuchungen (Quelle negativ, Ziel
//     positiv) und ist global netto 0
//   * Einkaufspreise sind vertraulich und nur in Admin-Auswertungen
//     enthalten

import type { Artikel, Buchung, Iso, Standort } from '../db/types'

const TAG_MS = 24 * 60 * 60 * 1000

export type ZeitraumTage = 7 | 30 | 90

export interface KpiWerte {
  aktiveArtikel: number
  bestandGesamt: number
  aktiveStandorte: number
  buchungenImZeitraum: number
  handlungsbedarfAnzahl: number
  /** Summe der positiven Bestaende x Einkaufspreis (nur Admin-Anzeige). */
  lagerwertCent: number
  artikelOhneEinkaufspreis: number
}

export interface HandlungsbedarfEintrag {
  artikelId: string
  artikelTitel: string
  standortId: string
  standortName: string
  bestand: number
  mindestbestand: number | null
  defizit: number
}

export interface BewegungsBucket {
  key: string
  /** Beginn des Buckets (lokale Mitternacht) als ISO-String. */
  vonIso: Iso
  einlagerung: number
  entnahme: number
  umlagerung: number
}

export interface StandortBestand {
  standortId: string
  name: string
  menge: number
}

export interface StandortWert {
  standortId: string
  name: string
  menge: number
  wertCent: number
}

export interface ArtikelWert {
  artikelId: string
  titel: string
  menge: number
  wertCent: number
}

export interface LagerwertAuswertung {
  gesamtCent: number
  proStandort: StandortWert[]
  topArtikel: ArtikelWert[]
  artikelOhneEinkaufspreis: number
}

export interface TopArtikelBewegung {
  artikelId: string
  titel: string
  menge: number
}

function startOfLocalDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function istAktiveBuchung(b: Buchung): boolean {
  return !b.storno && b.typ !== 'storno'
}

function istImZeitraum(iso: Iso, vonMs: number, bisMs: number): boolean {
  const ts = Date.parse(iso)
  return Number.isFinite(ts) && ts >= vonMs && ts < bisMs
}

function paarKey(artikelId: string, standortId: string): string {
  return `${artikelId}\u0000${standortId}`
}

/** Summe aller aktiven Buchungen — der Gesamtbestand in Stueck. */
export function bestandGesamt(buchungen: Buchung[]): number {
  let summe = 0
  for (const b of buchungen) {
    if (!b.storno) summe += b.menge
  }
  return summe
}

interface BestandsPaar {
  artikelId: string
  standortId: string
  menge: number
}

/** Bestand je Artikel+Standort aus den aktiven Buchungen. */
export function bestandProPaar(buchungen: Buchung[]): BestandsPaar[] {
  const map = new Map<string, BestandsPaar>()
  for (const b of buchungen) {
    if (b.storno) continue
    const key = paarKey(b.artikelId, b.standortId)
    const vorhanden = map.get(key)
    if (vorhanden) {
      vorhanden.menge += b.menge
    } else {
      map.set(key, { artikelId: b.artikelId, standortId: b.standortId, menge: b.menge })
    }
  }
  return [...map.values()]
}

/**
 * Aktuelle Unterdeckungen: negativer Bestand oder Bestand unter
 * Mindestbestand. Wird live aus den Buchungen berechnet, nicht aus den
 * historischen Mindestbestand-Ereignissen.
 */
export function handlungsbedarf(
  artikel: Artikel[],
  buchungen: Buchung[],
  standorte: Standort[],
  limit = 5,
): { anzahl: number; eintraege: HandlungsbedarfEintrag[] } {
  const artikelById = new Map(artikel.map((a) => [a.id, a]))
  const standortById = new Map(standorte.map((s) => [s.id, s]))
  const eintraege: HandlungsbedarfEintrag[] = []

  for (const paar of bestandProPaar(buchungen)) {
    const a = artikelById.get(paar.artikelId)
    if (!a || a.status === 'archiviert') continue
    const negativ = paar.menge < 0
    const unterMinimum = a.mindestbestand !== null && paar.menge < a.mindestbestand
    if (!negativ && !unterMinimum) continue

    const minimum = a.mindestbestand
    eintraege.push({
      artikelId: a.id,
      artikelTitel: a.titel,
      standortId: paar.standortId,
      standortName: standortById.get(paar.standortId)?.name ?? '—',
      bestand: paar.menge,
      mindestbestand: minimum,
      defizit: minimum !== null ? minimum - paar.menge : -paar.menge,
    })
  }

  eintraege.sort((a, b) => b.defizit - a.defizit || a.artikelTitel.localeCompare(b.artikelTitel))
  return { anzahl: eintraege.length, eintraege: eintraege.slice(0, limit) }
}

/**
 * Bewegungen in Tages- (7/30) oder Wochen-Buckets (90 Tage).
 * Gezaehlt werden Stueck, keine Buchungsanzahl:
 *   * Einlagerung: positiver Zugang
 *   * Entnahme: Abgang (Betrag)
 *   * Umlagerung: bewegte Menge (nur die negative Quell-Haelfte)
 */
export function bewegungenProZeitraum(
  buchungen: Buchung[],
  tage: ZeitraumTage,
  jetzt: Date = new Date(),
): BewegungsBucket[] {
  const heuteMs = startOfLocalDayMs(jetzt)
  const bucketTage = tage <= 30 ? 1 : 7
  const bucketMs = bucketTage * TAG_MS
  const bucketCount = Math.ceil(tage / bucketTage)
  const ersterStart = heuteMs - (bucketCount - 1) * bucketMs
  const endeMs = heuteMs + TAG_MS

  const buckets: BewegungsBucket[] = []
  for (let i = 0; i < bucketCount; i += 1) {
    const startMs = ersterStart + i * bucketMs
    buckets.push({
      key: `b${i}`,
      vonIso: new Date(startMs).toISOString(),
      einlagerung: 0,
      entnahme: 0,
      umlagerung: 0,
    })
  }

  for (const b of buchungen) {
    if (!istAktiveBuchung(b)) continue
    const ts = Date.parse(b.erstelltAm)
    if (!Number.isFinite(ts) || ts < ersterStart || ts >= endeMs) continue
    const index = Math.floor((ts - ersterStart) / bucketMs)
    const bucket = buckets[index]
    if (!bucket) continue

    if (b.typ === 'einlagerung') bucket.einlagerung += Math.abs(b.menge)
    else if (b.typ === 'entnahme') bucket.entnahme += Math.abs(b.menge)
    else if (b.typ === 'umlagerung' && b.menge < 0) bucket.umlagerung += Math.abs(b.menge)
  }

  return buckets
}

/** Netto-Bestand je Standort (nur Standorte mit Bestand != 0). */
export function bestandProStandort(buchungen: Buchung[], standorte: Standort[]): StandortBestand[] {
  const map = new Map<string, number>()
  for (const b of buchungen) {
    if (b.storno) continue
    map.set(b.standortId, (map.get(b.standortId) ?? 0) + b.menge)
  }
  const standortById = new Map(standorte.map((s) => [s.id, s]))
  return [...map.entries()]
    .filter(([, menge]) => menge !== 0)
    .map(([standortId, menge]) => ({
      standortId,
      name: standortById.get(standortId)?.name ?? '—',
      menge,
    }))
    .sort((a, b) => b.menge - a.menge)
}

/**
 * Admin-Auswertung des Lagerwerts.
 *
 * Einkaufspreis gilt je Verpackungseinheit. Bewertet werden nur positive
 * Bestaende (negative Bestaende sind Datenfehler und stehen im
 * Handlungsbedarf). Artikel ohne Einkaufspreis werden uebersprungen und
 * separat gezaehlt.
 */
export function lagerwertAuswertung(
  artikel: Artikel[],
  buchungen: Buchung[],
  standorte: Standort[],
): LagerwertAuswertung {
  const artikelById = new Map(artikel.map((a) => [a.id, a]))
  const standortById = new Map(standorte.map((s) => [s.id, s]))

  const standortWerte = new Map<string, StandortWert>()
  const artikelWerte = new Map<string, ArtikelWert>()
  const ohnePreis = new Set<string>()
  let gesamtCent = 0

  for (const paar of bestandProPaar(buchungen)) {
    if (paar.menge <= 0) continue
    const a = artikelById.get(paar.artikelId)
    if (!a) continue

    const ve = a.verpackungseinheit
    if (a.einkaufspreis === null || ve === null || ve <= 0) {
      ohnePreis.add(a.id)
      continue
    }

    const wertCent = Math.round((paar.menge / ve) * a.einkaufspreis)
    gesamtCent += wertCent

    const s = standortWerte.get(paar.standortId) ?? {
      standortId: paar.standortId,
      name: standortById.get(paar.standortId)?.name ?? '—',
      menge: 0,
      wertCent: 0,
    }
    s.menge += paar.menge
    s.wertCent += wertCent
    standortWerte.set(paar.standortId, s)

    const aw = artikelWerte.get(a.id) ?? {
      artikelId: a.id,
      titel: a.titel,
      menge: 0,
      wertCent: 0,
    }
    aw.menge += paar.menge
    aw.wertCent += wertCent
    artikelWerte.set(a.id, aw)
  }

  return {
    gesamtCent,
    proStandort: [...standortWerte.values()].sort((a, b) => b.wertCent - a.wertCent),
    topArtikel: [...artikelWerte.values()].sort((a, b) => b.wertCent - a.wertCent).slice(0, 5),
    artikelOhneEinkaufspreis: ohnePreis.size,
  }
}

/** Top-Artikel nach bewegter Stueckzahl im Zeitraum. */
export function topArtikelNachBewegung(
  artikel: Artikel[],
  buchungen: Buchung[],
  tage: ZeitraumTage,
  jetzt: Date = new Date(),
  limit = 8,
): TopArtikelBewegung[] {
  const heuteMs = startOfLocalDayMs(jetzt)
  const vonMs = heuteMs - (tage - 1) * TAG_MS
  const bisMs = heuteMs + TAG_MS
  const artikelById = new Map(artikel.map((a) => [a.id, a]))
  const map = new Map<string, number>()

  for (const b of buchungen) {
    if (!istAktiveBuchung(b)) continue
    if (!istImZeitraum(b.erstelltAm, vonMs, bisMs)) continue
    let menge = 0
    if (b.typ === 'einlagerung' || b.typ === 'entnahme') menge = Math.abs(b.menge)
    else if (b.typ === 'umlagerung' && b.menge < 0) menge = Math.abs(b.menge)
    else continue
    map.set(b.artikelId, (map.get(b.artikelId) ?? 0) + menge)
  }

  return [...map.entries()]
    .map(([artikelId, menge]) => ({
      artikelId,
      titel: artikelById.get(artikelId)?.titel ?? '—',
      menge,
    }))
    .sort((a, b) => b.menge - a.menge || a.titel.localeCompare(b.titel))
    .slice(0, limit)
}

export interface KpiEingabe {
  artikel: Artikel[]
  buchungen: Buchung[]
  standorte: Standort[]
  tage: ZeitraumTage
  jetzt?: Date
}

export function berechneKpis({
  artikel,
  buchungen,
  standorte,
  tage,
  jetzt = new Date(),
}: KpiEingabe): KpiWerte {
  const heuteMs = startOfLocalDayMs(jetzt)
  const vonMs = heuteMs - (tage - 1) * TAG_MS
  const bisMs = heuteMs + TAG_MS

  const aktiveArtikel = artikel.filter((a) => a.status !== 'archiviert').length
  const aktiveStandorte = standorte.filter((s) => !s.archiviert).length
  const buchungenImZeitraum = buchungen.filter(
    (b) => istAktiveBuchung(b) && istImZeitraum(b.erstelltAm, vonMs, bisMs),
  ).length
  const bedarf = handlungsbedarf(artikel, buchungen, standorte)
  const wert = lagerwertAuswertung(artikel, buchungen, standorte)

  return {
    aktiveArtikel,
    bestandGesamt: bestandGesamt(buchungen),
    aktiveStandorte,
    buchungenImZeitraum,
    handlungsbedarfAnzahl: bedarf.anzahl,
    lagerwertCent: wert.gesamtCent,
    artikelOhneEinkaufspreis: wert.artikelOhneEinkaufspreis,
  }
}

/** Neueste Buchungen fuer die Aktivitaetsliste (inkl. Storno). */
export function letzteBuchungen(buchungen: Buchung[], limit = 8): Buchung[] {
  return buchungen
    .slice()
    .sort((a, b) => Date.parse(b.erstelltAm) - Date.parse(a.erstelltAm))
    .slice(0, limit)
}
