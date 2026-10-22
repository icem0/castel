// Tests für den WebAudio-Alarm-Klang.
//
// Wir mocken `AudioContext` mit einem minimalen Stub und zeichnen die
// Call-Args auf, um die Frequenz-/Decay-Werte pro Stimme zu prüfen.
// jsdom hat keinen echten Audio-Context, ein echter wäre also weder
// verfügbar noch sinnvoll.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ALARM_STIMMEN,
  ALARM_GESAMTDAUER_S,
  alarmKlingeln,
  audioContextBereit,
  vibrateMuster,
  _resetAlarmForTests,
} from '../alarm'

/** Aufgezeichnete Oszillator-Aufrufe. */
interface Osz {
  freq: number
  typ: string
  start: number
  stop: number
}

/** Aufgezeichnete Gain-Ramps einer Stimme. */
interface Gain {
  /** Wert vor dem Setzen (Master-Gain-Initialwert). */
  initial: number
  /** Alle `exponentialRampToValueAtTime(value, time)`-Aufrufe. */
  ramps: Array<{ v: number; t: number }>
}

let oszis: Osz[]
let stimmeGains: Gain[]
let ctx: AudioContext
let resumeSpy: ReturnType<typeof vi.fn>
let ctorSpy: ReturnType<typeof vi.fn>

function makeGainStub(rec: Gain): GainNode {
  const node = {
    gain: {
      value: 0,
      setValueAtTime: vi.fn((v: number) => {
        rec.initial = v
      }),
      exponentialRampToValueAtTime: vi.fn((v: number, t: number) => {
        rec.ramps.push({ v, t })
      }),
    },
    connect: vi.fn(),
  }
  // `gain.value` wird im Code direkt zugewiesen — der Stub braucht
  // dafür einen beschreibbaren Accessor, der in `rec` spiegelt.
  const gain = node.gain as unknown as { value: number }
  Object.defineProperty(gain, 'value', {
    configurable: true,
    get: () => rec.initial,
    set: (v: number) => {
      rec.initial = v
    },
  })
  return node as unknown as GainNode
}

beforeEach(() => {
  oszis = []
  stimmeGains = []
  resumeSpy = vi.fn().mockResolvedValue(undefined)

  ctx = {
    currentTime: 10,
    state: 'running',
    destination: {} as AudioDestinationNode,
    resume: resumeSpy,
    createGain: vi.fn(() => {
      const rec: Gain = { initial: 0, ramps: [] }
      stimmeGains.push(rec)
      return makeGainStub(rec)
    }),
    createOscillator: vi.fn(() => {
      const rec: Osz = { freq: 0, typ: '', start: -1, stop: -1 }
      oszis.push(rec)
      const node = {
        type: '',
        frequency: {
          get value() {
            return rec.freq
          },
          set value(v: number) {
            rec.freq = v
          },
        },
        connect: vi.fn(),
        start: vi.fn((t: number) => {
          rec.typ = node.type
          rec.start = t
        }),
        stop: vi.fn((t: number) => {
          rec.stop = t
        }),
      }
      return node as unknown as OscillatorNode
    }),
  } as unknown as AudioContext

  // `new AudioContext()` wird aufgerufen, deshalb muss der Mock eine
  // `function`-Implementierung sein (Arrow-Functions sind nicht
  // new-bar — Vitest würde das ablehnen).
  ctorSpy = vi.fn(function AudioContextStub() {
    return ctx
  })
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: ctorSpy })
})

afterEach(() => {
  _resetAlarmForTests()
  Reflect.deleteProperty(window, 'AudioContext')
  Reflect.deleteProperty(window, 'webkitAudioContext')
})

describe('alarmKlingeln — Stimmen-Mapping', () => {
  it('erzeugt exakt so viele Oszillatoren wie Stimmen definiert', () => {
    alarmKlingeln(ctx, { lautstaerke: 0.8 })
    expect(oszis).toHaveLength(ALARM_STIMMEN.length)
  })

  it('startet jede Stimme bei currentTime + ihr Offset', () => {
    alarmKlingeln(ctx, { lautstaerke: 0.8 })
    ALARM_STIMMEN.forEach((stimme, i) => {
      expect(oszis[i]!.start).toBeCloseTo(10 + stimme.start, 5)
    })
  })

  it('stoppt jede Stimme nach start + dauer + 20ms Ramp-Puffer', () => {
    alarmKlingeln(ctx, { lautstaerke: 0.8 })
    ALARM_STIMMEN.forEach((stimme, i) => {
      expect(oszis[i]!.stop).toBeCloseTo(10 + stimme.start + stimme.dauer + 0.02, 5)
    })
  })

  it('setzt die dokumentierten Frequenzen (Dur-Dreiklang E5/B5)', () => {
    alarmKlingeln(ctx, { lautstaerke: 0.8 })
    const freqs = oszis.map((o) => o.freq).sort((a, b) => a - b)
    expect(freqs).toEqual([659.25, 987.77, 1318.5, 1977.75])
  })

  it('setzt jede Stimme auf sine', () => {
    alarmKlingeln(ctx, { lautstaerke: 0.8 })
    expect(oszis.every((o) => o.typ === 'sine')).toBe(true)
  })

  it('Gesamtdauer entspricht der längsten Stimme (1.28 s)', () => {
    expect(ALARM_GESAMTDAUER_S).toBeCloseTo(1.28, 5)
  })

  it('rampt jede Stimme vom Peak auf Stille (Attack + Decay)', () => {
    alarmKlingeln(ctx, { lautstaerke: 0.8 })
    // createGain(): [0] = Master, [1..4] = Stimmen in Reihenfolge.
    ALARM_STIMMEN.forEach((stimme, idx) => {
      const rec = stimmeGains[idx + 1]!
      // Reihenfolge im Code: setValueAtTime(SILENCE) → rampUp(peak)
      // → rampDown(SILENCE). Mein `ramps`-Array enthält nur die
      // exponentialRamp-Calls, `initial` ist der setValueAtTime-Wert.
      expect(rec.initial).toBeCloseTo(0.0001, 6)
      expect(rec.ramps).toHaveLength(2)
      // Attack-Peak = stimme.peak bei t0 + 0.005
      expect(rec.ramps[0]!.v).toBeCloseTo(stimme.peak, 5)
      expect(rec.ramps[0]!.t).toBeCloseTo(10 + stimme.start + 0.005, 5)
      // Decay landet bei SILENCE (0.0001)
      expect(rec.ramps[1]!.v).toBeCloseTo(0.0001, 6)
      expect(rec.ramps[1]!.t).toBeCloseTo(10 + stimme.start + stimme.dauer, 5)
    })
  })
})

describe('alarmKlingeln — Lautstärke', () => {
  it('skaliert den Master-Gain mit lautstaerke', () => {
    alarmKlingeln(ctx, { lautstaerke: 0.7 })
    // createGain(): [0] = Master
    expect(stimmeGains[0]!.initial).toBeCloseTo(0.7, 5)
  })

  it('lautstaerke 0 → kein Klang (früher Return)', () => {
    alarmKlingeln(ctx, { lautstaerke: 0 })
    expect(oszis).toHaveLength(0)
  })

  it('klemmt lautstaerke > 1 auf 1', () => {
    alarmKlingeln(ctx, { lautstaerke: 5 })
    expect(stimmeGains[0]!.initial).toBeCloseTo(1, 5)
  })

  it('klemmt negative lautstaerke auf 0', () => {
    alarmKlingeln(ctx, { lautstaerke: -1 })
    expect(oszis).toHaveLength(0)
  })

  it('lautstaerke skaliert NICHT die einzelnen Stimmen (nur Master)', () => {
    alarmKlingeln(ctx, { lautstaerke: 0.5 })
    // Die Stimmen-Peaks bleiben die dokumentierten Werte, unabhängig
    // von der Master-Lautstärke.
    ALARM_STIMMEN.forEach((stimme, idx) => {
      const rec = stimmeGains[idx + 1]!
      const attack = rec.ramps.find((r) => r.v > 0.01)
      expect(attack?.v).toBeCloseTo(stimme.peak, 5)
    })
  })
})

describe('alarmKlingeln — Robustheit', () => {
  it('no-op bei null-Context', () => {
    expect(() => alarmKlingeln(null, { lautstaerke: 1 })).not.toThrow()
  })

  it('schluckt Fehler aus createOscillator', () => {
    vi.spyOn(ctx, 'createOscillator').mockImplementation(() => {
      throw new Error('Audio kaputt')
    })
    expect(() => alarmKlingeln(ctx, { lautstaerke: 1 })).not.toThrow()
  })

  it('schluckt NaN-lautstaerke', () => {
    expect(() => alarmKlingeln(ctx, { lautstaerke: Number.NaN })).not.toThrow()
    expect(oszis).toHaveLength(0)
  })
})

describe('audioContextBereit', () => {
  it('erzeugt einen Singleton', () => {
    const a = audioContextBereit()
    const b = audioContextBereit()
    expect(a).toBe(b)
    expect(a).not.toBeNull()
    expect(ctorSpy).toHaveBeenCalledTimes(1)
  })

  it('ruft resume() bei jedem Zugriff (Autoplay-Policy / suspended)', () => {
    audioContextBereit()
    audioContextBereit()
    audioContextBereit()
    // Beim Erzeugen (1. Zugriff) + bei jedem Folgezugriff.
    expect(resumeSpy).toHaveBeenCalledTimes(3)
  })
})

describe('audioContextBereit — kein Support', () => {
  it('liefert null, wenn window.AudioContext fehlt', () => {
    _resetAlarmForTests()
    Reflect.deleteProperty(window, 'AudioContext')
    Reflect.deleteProperty(window, 'webkitAudioContext')
    expect(audioContextBereit()).toBeNull()
  })

  it('cached das Scheitern (kein wiederholter Versuch)', () => {
    _resetAlarmForTests()
    const spy = vi.fn()
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      get: spy,
    })
    // Der 1. Zugriff prüft einmal, ob die API existiert (das ist der
    // einzig legitime Property-Zugriff). Danach ist das Ergebnis
    // gecacht — Folgeaufrufe lesen die Property NICHT mehr.
    audioContextBereit()
    expect(spy).toHaveBeenCalledTimes(1)
    audioContextBereit()
    audioContextBereit()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('vibrateMuster', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'vibrate')
  })

  it('ruft navigator.vibrate mit [80,60,80]', () => {
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate })
    vibrateMuster()
    expect(vibrate).toHaveBeenCalledWith([80, 60, 80])
  })

  it('no-op, wenn vibrate fehlt (iOS)', () => {
    expect(() => vibrateMuster()).not.toThrow()
  })

  it('schluckt Fehler aus vibrate', () => {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('blocked')
      }),
    })
    expect(() => vibrateMuster()).not.toThrow()
  })
})
