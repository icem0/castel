// Merkt sich die zuletzt verwendete Kommission (1 Stunde, pro User).
//
// Wer mehrere Buchungen fuer dieselbe Kommission erfasst, soll das
// Kommission-Feld nicht staendig neu auswaehlen muessen. Nach jeder Buchung
// mit Kommission wird der Zeitstempel erneut gesetzt (Sliding Window); erst
// wenn seit 60 Minuten keine Buchung mehr kam, bleibt das Feld wieder leer.
//
// Wie bei den Etiketten-Startfeldern (services/etiketten/startfeld.ts) ist
// das reine Browser-Bequemlichkeit: localStorage, nicht gesynct, mit
// try/catch fuer gesperrtes localStorage (privater Modus).

/** localStorage-Key fuer die gemerkte Kommission. */
export const LS_KOMMISSION_ZULETZT = 'castel.kommission.zuletzt'

/** Wie lange die Kommission gemerkt bleibt (Sliding Window ab letzter Buchung). */
export const MERKDAUER_MS = 60 * 60 * 1000

/** Obergrenze — alles darueber ist datenqualitaetsmaessig verdaechtig. */
const MAX_LAENGE = 500

interface KommissionsMerkung {
  userId: string
  name: string
  gemerktAm: number
}

function lies(): KommissionsMerkung | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const roh = localStorage.getItem(LS_KOMMISSION_ZULETZT)
    if (!roh) return null
    const parsed: unknown = JSON.parse(roh)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const m = parsed as Partial<KommissionsMerkung>
    if (
      typeof m.userId !== 'string' ||
      typeof m.name !== 'string' ||
      typeof m.gemerktAm !== 'number'
    )
      return null
    return { userId: m.userId, name: m.name, gemerktAm: m.gemerktAm }
  } catch {
    return null
  }
}

/** Setzt die gemerkte Kommission (Timestempel = jetzt, Sliding Window). */
export function kommissionMerken(userId: string, name: string, now: number = Date.now()): void {
  if (typeof localStorage === 'undefined') return
  const wert = name.trim()
  if (wert === '' || wert.length > MAX_LAENGE) return
  try {
    const merk: KommissionsMerkung = { userId, name: wert, gemerktAm: now }
    localStorage.setItem(LS_KOMMISSION_ZULETZT, JSON.stringify(merk))
  } catch {
    // localStorage kann gesperrt sein (privater Modus) — dann nichts merken.
  }
}

/**
 * Die gemerkte Kommission des Users, solange sie juenger als MERKDAUER_MS
 * ist — sonst null (Feld bleibt leer). Ein anderer User auf demselben
 * Geraet sieht die Merkung nicht.
 */
export function letzteKommission(userId: string, now: number = Date.now()): string | null {
  const merk = lies()
  if (!merk) return null
  if (merk.userId !== userId) return null
  if (now - merk.gemerktAm > MERKDAUER_MS) return null
  return merk.name
}

/** Entfernt die Merkung (z. B. Tests / Reset-Szenarien). */
export function kommissionVergessen(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(LS_KOMMISSION_ZULETZT)
  } catch {
    // nicht entfernbares localStorage ignorieren.
  }
}
