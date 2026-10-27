// Akkutausch: validation of the global `akkuTypen` setting.
//
// The `pruefeTypen` function is intentionally byte-identical to the PWA
// counterpart in `src/domain/akkutausch/berechnung.ts` — the parity test
// `src/domain/__tests__/akkutausch-paritaet.test.ts` guards against drift
// between client and server (same pattern as `mindestbestand`).
//
// The server is the source of truth: a setting value that does not pass the
// validation is rejected instead of being stored, because every client would
// read it back and could not plan anything with it.

export interface AkkuTyp {
  id: string
  /** Nominal capacity in Ah (e.g. 12.5). */
  kapazitaetAh: number
  /** Lower bound of the capacity range in Ah (inclusive). */
  von: number
  /** Upper bound of the capacity range in Ah (inclusive). */
  bis: number
  /** Linked article; `null` when no article is assigned (yet). */
  artikelId: string | null
}

export type TypFehlerCode =
  | 'ungueltige_kapazitaet'
  | 'ungueltiger_bereich'
  | 'nominal_ausserhalb'
  | 'ueberlappung'
  | 'ungueltige_id'

export interface TypFehler {
  code: TypFehlerCode
  /** Id of the offending type. */
  typId: string
  /** Id of the second type — only set for `ueberlappung`. */
  otherTypId?: string
  /** Offending value, formatted for display. */
  wert?: string
}

export function pruefeTypen(typen: readonly AkkuTyp[]): TypFehler[] {
  const fehler: TypFehler[] = []

  for (const typ of typen) {
    if (typ.id.trim() === '') {
      fehler.push({ code: 'ungueltige_id', typId: typ.id })
      continue
    }
    if (
      !Number.isFinite(typ.von) ||
      !Number.isFinite(typ.bis) ||
      typ.von <= 0 ||
      typ.bis < typ.von
    ) {
      fehler.push({ code: 'ungueltiger_bereich', typId: typ.id })
      continue
    }
    if (!Number.isFinite(typ.kapazitaetAh) || typ.kapazitaetAh <= 0) {
      fehler.push({
        code: 'ungueltige_kapazitaet',
        typId: typ.id,
        wert: String(typ.kapazitaetAh),
      })
      continue
    }
    if (typ.kapazitaetAh < typ.von || typ.kapazitaetAh > typ.bis) {
      fehler.push({
        code: 'nominal_ausserhalb',
        typId: typ.id,
        wert: String(typ.kapazitaetAh),
      })
    }
  }

  for (let i = 0; i < typen.length; i++) {
    const a = typen[i]
    if (!a) continue
    for (let j = i + 1; j < typen.length; j++) {
      const b = typen[j]
      if (!b) continue
      if (a.von <= b.bis && b.von <= a.bis) {
        fehler.push({ code: 'ueberlappung', typId: a.id, otherTypId: b.id })
      }
    }
  }

  return fehler
}

/** Result of parsing the raw setting value. */
export interface AkkuTypenParseErgebnis {
  typen: AkkuTyp[]
  /** Human readable problems — a non-empty list means the value is rejected. */
  fehler: string[]
}

/**
 * Parses and validates the raw `akkuTypen` setting value. Unlike the
 * tolerant client-side parser, the server rejects the whole value when a
 * single entry is broken — otherwise a typo would silently disable the
 * planning for every client.
 */
export function parseAkkuTypenWert(value: string): AkkuTypenParseErgebnis {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { typen: [], fehler: ['akkuTypen ist kein gültiges JSON'] }
  }
  if (!Array.isArray(parsed)) {
    return { typen: [], fehler: ['akkuTypen muss eine Liste sein'] }
  }

  const typen: AkkuTyp[] = []
  const fehler: string[] = []
  for (let i = 0; i < parsed.length; i++) {
    const eintrag = parsed[i]
    if (!eintrag || typeof eintrag !== 'object') {
      fehler.push(`akkuTypen[${i}] ist kein Objekt`)
      continue
    }
    const roh = eintrag as Record<string, unknown>
    const id = typeof roh['id'] === 'string' ? roh['id'] : ''
    const kapazitaetAh = roh['kapazitaetAh']
    const von = roh['von']
    const bis = roh['bis']
    const artikelId = roh['artikelId']
    if (id === '') {
      fehler.push(`akkuTypen[${i}] hat keine ID`)
      continue
    }
    if (typeof kapazitaetAh !== 'number' || !Number.isFinite(kapazitaetAh)) {
      fehler.push(`akkuTypen[${i}] hat eine ungültige Kapazität`)
      continue
    }
    if (typeof von !== 'number' || !Number.isFinite(von)) {
      fehler.push(`akkuTypen[${i}] hat eine ungültige Bereichsuntergrenze`)
      continue
    }
    if (typeof bis !== 'number' || !Number.isFinite(bis)) {
      fehler.push(`akkuTypen[${i}] hat eine ungültige Bereichsobergrenze`)
      continue
    }
    if (artikelId !== null && typeof artikelId !== 'string') {
      fehler.push(`akkuTypen[${i}] hat eine ungültige Artikel-ID`)
      continue
    }
    typen.push({
      id,
      kapazitaetAh,
      von,
      bis,
      artikelId: typeof artikelId === 'string' && artikelId !== '' ? artikelId : null,
    })
  }

  for (const problem of pruefeTypen(typen)) {
    fehler.push(fehlerMeldung(problem, typen))
  }

  return { typen, fehler }
}

/** Builds a human readable message for a validation problem. */
function fehlerMeldung(fehler: TypFehler, typen: readonly AkkuTyp[]): string {
  const name = typen.find((t) => t.id === fehler.typId)?.id ?? fehler.typId
  switch (fehler.code) {
    case 'ungueltige_id':
      return 'Ein Akku-Typ hat keine ID'
    case 'ungueltiger_bereich':
      return `Akku-Typ ${name} hat einen ungültigen Kapazitätsbereich`
    case 'ungueltige_kapazitaet':
      return `Akku-Typ ${name} hat eine ungültige Kapazität`
    case 'nominal_ausserhalb':
      return `Akku-Typ ${name}: die Nennkapazität muss innerhalb des Bereichs liegen`
    case 'ueberlappung':
      return `Akku-Typ ${name} überschneidet sich mit einem anderen Bereich`
  }
}
