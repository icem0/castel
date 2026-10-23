// Pure-Funktionen für Mindestbestand-Trigger.
//
// Diese Pure-Funktionen sind absichtlich byte-identisch zu
// `src/domain/mindestbestand.ts` auf der PWA-Seite (nur die
// SQL-/DB-Schicht drumherum unterscheidet sich). Ein Property-Test
// (`src/domain/__tests__/mindestbestand-paritaet.test.ts` auf PWA-Seite)
// liest beide Quelldateien ein und verifiziert die Identität der
// Bedingungs-Funktion. Bei einer Änderung muss die PWA-Variante
// angepasst werden (oder umgekehrt).
//
// Auslöser-Regel (User-Entscheidung): "Bei jeder Unterschreitung (auch
// wiederholte)". Das heißt: sobald der neue Bestand unter dem
// Mindestbestand liegt, wird ein Event geschrieben — egal, ob das für
// denselben Artikel+Standort schon mal passiert ist. Storno/Kommission/
// reine Storno-Buchungen werden separat gefiltert (siehe Resolver).

/**
 * Strukturelles Minimum an Feldern, das die Pure-Funktion braucht.
 * Sowohl `Artikel` aus `src/db/types.ts` (PWA) als auch die Drizzle-Row
 * aus `server/src/db/schema.ts` erfüllen diese Form (mindestbestand ist
 * `number | null`).
 */
export interface MindestbestandArtikel {
  mindestbestand: number | null
}

/**
 * Entscheidet, ob nach einer Buchung ein Mindestbestand-Event
 * geschrieben werden soll.
 *
 * Bedingungen (alle müssen erfüllt sein):
 *   1) Der Artikel hat einen Mindestbestand gesetzt (≠ null).
 *   2) Der neue Bestand am Standort ist kleiner als der Mindestbestand
 *      (`bestandDanach < mindestbestand`).
 *
 * Wichtig: bewusst KEIN "bestandDanach >= 0"-Check — der Server hat
 * bereits einen Negativ-Bestand-Check im Resolver, der separate
 * `NegativerBestandError` wirft. Wir wollen hier nur den Vergleich
 * gegen den Mindestbestand kapseln, damit PWA und Server exakt
 * dieselbe Logik haben.
 */
export function sollteWarnungAusloesen(
  mindestbestand: number | null,
  bestandDanach: number,
): boolean {
  if (mindestbestand === null) return false
  if (bestandDanach < mindestbestand) return true
  return false
}

/**
 * Berechnet das Defizit (`mindestbestand - bestandDanach`) für ein
 * ausgelöstes Event. Darf nur aufgerufen werden, wenn
 * `sollteWarnungAusloesen` true liefert. Reines TypeScript, keine
 * Side-Effects.
 */
export function berechneDefizit(
  mindestbestand: number,
  bestandDanach: number,
): number {
  return mindestbestand - bestandDanach
}

/**
 * Defizit gegen den *aktuellen* Bestand — im Gegensatz zu
 * `berechneDefizit` nie negativ.
 *
 * Grund: `mindestbestand_ereignisse` ist ein Append-only Log. Das Feld
 * `bestandDanach` ist ein eingefrorener Snapshot aus dem Moment der
 * auslösenden Buchung. Wird der Bestand danach wieder aufgefüllt, ist
 * der Alarm sachlich erledigt — der historische Wert behauptet aber
 * weiterhin ein Defizit. Für die Anzeige brauchen wir deshalb den
 * Vergleich gegen den LIVE-Bestand, und der darf nicht ins Negative
 * laufen (ein Bestand über dem Mindestbestand hat kein Defizit).
 */
export function berechneDefizitAktuell(
  mindestbestand: number,
  aktuellerBestand: number,
): number {
  const differenz = mindestbestand - aktuellerBestand
  if (differenz < 0) return 0
  return differenz
}
