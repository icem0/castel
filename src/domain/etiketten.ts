// Domain-Helfer fuer den Etiketten-Druck (DIN-A4-Bogen).
//
// `etikettenIstNeu` kapselt die Semantik des Markers `artikel.etikettenNeu`:
// TRUE = der Artikel ist als "neu" markiert und soll ein Etikett bekommen.
//
// Der Server legt die Spalte mit `NOT NULL DEFAULT TRUE` an, der
// Dexie-Upgrade (v12) fuellt bestehende lokale Zeilen mit `true`. In
// Ausnahmefaellen (alte lokale Zeile ohne Sync, Import aus einer fremden
// Quelle) kann das Feld trotzdem `undefined` sein — dann gilt der Artikel
// als "neu", passend zum Server-Default.

import type { Artikel } from '../db/types'

export function etikettenIstNeu(a: Pick<Artikel, 'etikettenNeu'>): boolean {
  return a.etikettenNeu !== false
}
