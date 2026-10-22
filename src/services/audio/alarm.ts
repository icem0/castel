// Alarm-Klang via WebAudio-Synthese (kein Asset, offline sofort verfügbar).
//
// Hintergrund: Wir wollen einen "Glockenklang", ohne eine MP3-Datei
// mitzuschleppen. Ein echter Glockenklang = Grundton + mehrere
// Harmonische + langer Decay. Ein reiner Sinus klingt wie ein Piepton,
// deshalb stapeln wir hier vier Stimmen (Grundton, zwei Oberöne, ein
// Nachschlag) mit unterschiedlichen Ausklingzeiten.
//
// Autoplay-Policy: Browser erlauben Audio erst nach einer User-
// Interaktion. Wir erzeugen den AudioContext daher LAZY (nie beim
// Modul-Import) und rufen `resume()` bei jedem Signal auf — das ist
// robust gegen Tab-Wechsel (Safari/Firefox setzen den Context sonst
// wieder auf "suspended").
//
// Sicherheit: Alle Funktionen sind no-throw. Wenn `AudioContext` nicht
// existiert (alte Browser, Node-Tests) oder `resume()` fehlschlägt,
// passiert einfach nichts. Ein Alarm darf niemals eine Ausnahme in den
// Sync-Worker oder die UI propagieren.

/** 0..1. Wird auf den Master-GainNode gelegt, nicht pro Stimme. */
export interface AlarmOptionen {
  lautstaerke: number
}

/** Eine einzelne Stimme des Glockenklangs. */
interface Stimme {
  /** Frequenz in Hz. */
  freq: number
  /** Verzögerung vor dem Start in Sekunden (0 = sofort). */
  start: number
  /** Ausklingzeit in Sekunden. */
  dauer: number
  /** Gain-Peak dieser Stimme (vor der Master-Skalierung). */
  peak: number
}

/**
 * Der Glockenklang. Frequenzen sind bewusst Intervalle eines
 * Dur-Dreiklangs (E5-Grundton), damit das Ohr es als "Metall"
 * erkennt und nicht als Piepton.
 *
 * - 659,25 Hz  = e5  (Grundton)
 * - 1318,5 Hz  = e6  (2. Oberton → Metalligkeit)
 * - 1977,75 Hz = g6  (3. Oberton → Schärfe, kurzer Decay)
 * - 987,77 Hz  = b5  (Nachschlag 280 ms später)
 */
export const ALARM_STIMMEN: readonly Stimme[] = [
  { freq: 659.25, start: 0, dauer: 1.2, peak: 0.55 },
  { freq: 1318.5, start: 0, dauer: 0.7, peak: 0.22 },
  { freq: 1977.75, start: 0, dauer: 0.4, peak: 0.11 },
  { freq: 987.77, start: 0.28, dauer: 1.0, peak: 0.4 },
]

/**
 * Kurz-Metadaten für Tests/Doku — die tatsächliche Zeitachse pro
 * Stimme ergibt sich aus `start` + `dauer`.
 */
export const ALARM_GESAMTDAUER_S: number = ALARM_STIMMEN.reduce(
  (max, s) => Math.max(max, s.start + s.dauer),
  0,
)

/** Kleinster hörbarer Gain-Wert — darunter ist der Klang stumm. */
const SILENCE = 0.0001

let _ctx: AudioContext | null = null
let _ctxFehlgeschlagen = false

/**
 * Liefert den (lazily erzeugten) AudioContext, oder `null` wenn die
 * Umgebung keinen unterstützt. Nutzt einen Singleton, weil Safari
 * die Anzahl gleichzeitiger Audio-Contexts begrenzt (~4) — jeder
 * neue Kontext wäre sonst eine Leiche.
 */
export function audioContextBereit(): AudioContext | null {
  if (_ctxFehlgeschlagen) return null
  if (_ctx) {
    void _ctx.resume?.().catch(() => {})
    return _ctx
  }
  const Ctor =
    typeof window !== 'undefined'
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined
  if (typeof Ctor !== 'function') {
    _ctxFehlgeschlagen = true
    return null
  }
  try {
    _ctx = new Ctor()
    // Wichtig: Ein frisch erzeugter AudioContext startet unter der
    // Autoplay-Policy in den meisten Browsern als "suspended" — ohne
    // dieses resume() klingelt der ERSTE Alarm nach einem Kaltstart
    // (also genau dann, wenn er am wichtigsten ist) nicht.
    void _ctx.resume?.().catch(() => {})
    return _ctx
  } catch {
    _ctxFehlgeschlagen = true
    return null
  }
}

/**
 * Spielt den Glockenklang. No-throw: Fehler werden verschluckt, damit
 * ein defekter Audio-Kanal nie den Sync oder die UI blockiert.
 *
 * @param ctx   AudioContext oder `null` (dann passiert nichts).
 * @param opt   `lautstaerke` 0..1 — wird auf den Master-Gain gelegt.
 */
export function alarmKlingeln(ctx: AudioContext | null, opt: AlarmOptionen): void {
  if (!ctx) return
  const laut = clamp01(opt.lautstaerke)
  if (laut <= 0) return
  try {
    const jetzt = ctx.currentTime
    const master = ctx.createGain()
    master.gain.value = laut
    master.connect(ctx.destination)

    for (const stimme of ALARM_STIMMEN) {
      const t0 = jetzt + stimme.start
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = stimme.freq
      const g = ctx.createGain()
      // Schneller Attack (5 ms) → Peak → exponentieller Decay bis Stille.
      g.gain.setValueAtTime(SILENCE, t0)
      g.gain.exponentialRampToValueAtTime(stimme.peak, t0 + 0.005)
      g.gain.exponentialRampToValueAtTime(SILENCE, t0 + stimme.dauer)
      osc.connect(g)
      g.connect(master)
      osc.start(t0)
      osc.stop(t0 + stimme.dauer + 0.02)
    }
  } catch {
    // Audio ist optional — ein Fehler hier darf nie eskalieren.
  }
}

/**
 * Haptisches Signal über die Vibration-API. Funktioniert auf Android
 * (Chrome), ist auf iOS Safari ein no-op (kein `navigator.vibrate`).
 * Pattern: kurz-pause-kurz, damit es als "doppelt" wahrgenommen wird.
 */
export function vibrateMuster(): void {
  if (typeof navigator === 'undefined') return
  if (typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate([80, 60, 80])
  } catch {
    // Manche Browser werfen bei blockierter Vibration (z. B. ohne
    // vorherige Interaktion). Kein Grund für einen Fehler.
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/**
 * Setzt den Audio-Singleton zurück. Nur für Tests (der Mock tauscht
 * den globalen `AudioContext` aus, der Singleton würde sonst den
 * alten Kontext behalten).
 */
export function _resetAlarmForTests(): void {
  _ctx = null
  _ctxFehlgeschlagen = false
}
