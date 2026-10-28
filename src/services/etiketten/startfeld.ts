// Startfeld fuer den Etiketten-Druck.
//
// Das Startfeld zaehlt die Felder des Bogens zeilenweise von links oben
// (Feld 1 = oben links). Es laesst die bereits benutzten Felder eines
// angebrochenen Bogens frei — der Versatz gilt nur fuer die ERSTE Seite,
// die Folgeseiten werden voll bedruckt.
//
// Die Werte werden lokal im Browser gespeichert (je Bogen-Layout), damit
// sie nicht bei jedem Druck neu eingetippt werden muessen.

/** localStorage-Key (Map: Bogen-Layout-ID -> Startfeld). */
export const LS_STARTFELD = 'castel.etiketten.startFeld'

/**
 * Normalisiert eine Eingabe zu einem gueltigen Startfeld:
 * ganze Zahl innerhalb [1, `max`]. Ungueltige Eingaben ergeben 1.
 */
export function normalisiereStartFeld(wert: unknown, max: number): number {
  const grenze = Math.max(1, Math.floor(Number.isFinite(max) ? max : 1))
  const zahl = typeof wert === 'number' ? wert : Number.parseInt(String(wert ?? '').trim(), 10)
  if (!Number.isFinite(zahl)) return 1
  return Math.min(Math.max(Math.floor(zahl), 1), grenze)
}

/** Liest die gespeicherten Startfelder (je Bogen-Layout). */
export function ladeStartFelder(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const roh = localStorage.getItem(LS_STARTFELD)
    if (!roh) return {}
    const parsed: unknown = JSON.parse(roh)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [id, wert] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof wert === 'number' && Number.isFinite(wert) && wert >= 1) {
        out[id] = Math.floor(wert)
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Startfeld fuer ein Bogen-Layout (1, wenn nichts gespeichert ist). */
export function ladeStartFeld(presetId: string): number {
  return ladeStartFelder()[presetId] ?? 1
}

/** Speichert das Startfeld fuer ein Bogen-Layout. */
export function speichereStartFeld(presetId: string, wert: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    const felder = ladeStartFelder()
    felder[presetId] = Math.max(1, Math.floor(Number.isFinite(wert) ? wert : 1))
    localStorage.setItem(LS_STARTFELD, JSON.stringify(felder))
  } catch {
    // localStorage kann gesperrt sein (privater Modus) — dann nichts merken.
  }
}
