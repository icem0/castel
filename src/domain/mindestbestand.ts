// Mindestbestand-Trigger-Logik (PWA-Spiegel der Server-Funktion).
//
// Diese Datei ist absichtlich byte-identisch zu
// `server/src/domain/mindestbestand.ts` (nur die SQL-/DB-Schicht
// unterscheidet sich). Ein Property-Test
// (`src/domain/__tests__/mindestbestand-paritaet.test.ts`) liest beide
// Quelldateien ein und verifiziert die Identität. Bei einer Änderung
// muss die Server-Variante angepasst werden (oder umgekehrt).
//
// Hintergrund: der Server-Resolver löst die Events aus (siehe
// `server/src/sync/resolver.ts`). Die PWA spiegelt nur, was der
// Snapshot-Endpoint liefert. Trotzdem halten wir die Bedingung
// gespiegelt, damit PWA-Clients, die offline arbeiten und die Daten
// aus dem Snapshot ziehen, exakt dieselbe Logik nachvollziehen
// können — wichtig für die Glocke-Status-Berechnung und für
// eventuelle lokale Vorab-UI-Hints (z. B. "Bestand ist gleich
// Mindestbestand" in der Artikel-Detail-View).

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
export function berechneDefizit(mindestbestand: number, bestandDanach: number): number {
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
