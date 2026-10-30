// Tests für den Mindestbestand-Alarm.
//
// `cooldownAktiv` ist eine reine Funktion und wird direkt getestet.
// Das Trigger-Verhalten des Composables testen wir mit gemockten
// Stores, damit wir keine echte Audio-Notification brauchen.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick, reactive, createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { cooldownAktiv, COOLDOWN_MS, BLITZ_DAUER_MS } from '../useMindestbestandAlarm'
import type { MindestbestandZeile } from '../../stores/mindestbestand'
import type { MindestbestandEreignis } from '../../db/types'

describe('cooldownAktiv — reine Logik', () => {
  const jetzt = 1_700_000_000_000

  it('kein Marker → Cooldown aktiv (kein Alarm bei frischer Installation)', () => {
    expect(cooldownAktiv(null, jetzt)).toBe(true)
  })

  it('kaputter Marker → Cooldown aktiv (defensiv)', () => {
    expect(cooldownAktiv('kein-datum', jetzt)).toBe(true)
  })

  it('Marker exakt jetzt → aktiv', () => {
    expect(cooldownAktiv(new Date(jetzt).toISOString(), jetzt)).toBe(true)
  })

  it('Marker 59,999 s alt → noch aktiv', () => {
    const marker = new Date(jetzt - 59_999).toISOString()
    expect(cooldownAktiv(marker, jetzt)).toBe(true)
  })

  it('Marker exakt 60 s alt → NICHT mehr aktiv (Grenze)', () => {
    const marker = new Date(jetzt - COOLDOWN_MS).toISOString()
    expect(cooldownAktiv(marker, jetzt)).toBe(false)
  })

  it('Marker 5 min alt → nicht aktiv', () => {
    const marker = new Date(jetzt - 300_000).toISOString()
    expect(cooldownAktiv(marker, jetzt)).toBe(false)
  })

  it('Marker in der Zukunft (Clock-Skew) → aktiv', () => {
    const marker = new Date(jetzt + 10_000).toISOString()
    expect(cooldownAktiv(marker, jetzt)).toBe(true)
  })

  it('eigener cooldown-Wert wird respektiert', () => {
    const marker = new Date(jetzt - 5_000).toISOString()
    expect(cooldownAktiv(marker, jetzt, 1_000)).toBe(false)
    expect(cooldownAktiv(marker, jetzt, 10_000)).toBe(true)
  })
})

// ---------- Trigger-Verhalten mit gemockten Stores ----------

const alarmMock = vi.hoisted(() => ({
  alarmKlingeln: vi.fn(),
  audioContextBereit: vi.fn(() => null),
  vibrateMuster: vi.fn(),
}))

vi.mock('../../services/audio/alarm', () => ({
  alarmKlingeln: alarmMock.alarmKlingeln,
  audioContextBereit: alarmMock.audioContextBereit,
  vibrateMuster: alarmMock.vibrateMuster,
}))

/** Mutable Knöpfe, damit ein Test den Store-Zustand verändern kann.
 *  MUSS `reactive()` sein — sonst erkennt der `watch` im Composable
 *  die Mutation von `letzte50` nicht (Vue tracked nur reaktive Reads). */
const storeMock = vi.hoisted(() => ({
  reactiveState: null as null | {
    letzte50: MindestbestandEreignis[]
    /** Test control: which event ids count as still-open alarms. */
    offenIds: string[]
    letztesSignalAm: string | null
    istAdmin: boolean
    soundAn: boolean
    lautstaerke: number
    wiederholen: boolean
  },
  markiereSignalGesendet: vi.fn(),
}))

/** Maps a raw event to a live-evaluated row, mirroring the real store. */
function zeileAus(ev: MindestbestandEreignis, offen: boolean): MindestbestandZeile {
  return {
    ereignis: ev,
    aktuellerBestand: ev.bestandDanach,
    schwelle: ev.mindestbestand,
    defizit: ev.defizit,
    offen,
  }
}

vi.mock('../../stores/mindestbestand', () => ({
  useMindestbestandStore: () => {
    const s = storeMock.reactiveState!
    const zeilen = (): MindestbestandZeile[] =>
      s.letzte50.map((ev) => zeileAus(ev, s.offenIds.includes(ev.id)))
    const offene = (): MindestbestandZeile[] => zeilen().filter((z) => z.offen)
    return {
      get letzte50() {
        return s.letzte50
      },
      get letzte50Zeilen() {
        return zeilen()
      },
      get offeneZeilen() {
        return offene()
      },
      get letztesSignalAm() {
        return s.letztesSignalAm
      },
      get ungesehenCount() {
        return offene().length
      },
      markiereSignalGesendet: storeMock.markiereSignalGesendet,
    }
  },
}))

// `reactive` wird in `vi.hoisted` nicht verfügbar sein (kein Vue-Import),
// deshalb bauen wir das reaktive Objekt im beforeEach.
let reactiveState!: {
  letzte50: MindestbestandEreignis[]
  offenIds: string[]
  letztesSignalAm: string | null
  istAdmin: boolean
  soundAn: boolean
  lautstaerke: number
  wiederholen: boolean
}

/** Test-Steuerung — schreibt in das reaktive Objekt. */
const steuerung = {
  get letzte50(): MindestbestandEreignis[] {
    return reactiveState.letzte50
  },
  set letzte50(v: MindestbestandEreignis[]) {
    reactiveState.letzte50 = v
    // A newly written event counts as unresolved by default — that is the
    // normal case. Tests covering the resolved path use `markiereErledigt`.
    reactiveState.offenIds = v.map((e) => e.id)
  },
  get letztesSignalAm(): string | null {
    return reactiveState.letztesSignalAm
  },
  set letztesSignalAm(v: string | null) {
    reactiveState.letztesSignalAm = v
  },
  /** Mark the given event ids as resolved (stock back above the minimum). */
  markiereErledigt(ids: string[]): void {
    reactiveState.offenIds = reactiveState.offenIds.filter((id) => !ids.includes(id))
  },
}

vi.mock('../../stores/settings', () => ({
  useSettingsStore: () => ({
    settings: {
      get mindestbestandSoundAn() {
        return storeMock.reactiveState!.soundAn
      },
      get mindestbestandLautstaerke() {
        return storeMock.reactiveState!.lautstaerke
      },
      get mindestbestandWiederholen() {
        return storeMock.reactiveState!.wiederholen
      },
    },
  }),
}))

// Der Alarm ist rollenoffen: das Composable fragt die Rolle nicht mehr ab
// (`istAdmin` bleibt als Test-Störung gesetzt, darf aber nichts ändern).
// `mindestbestandSoundAn` ist der Master-Switch des gesamten Signals.

vi.mock('../../stores/artikel', () => ({
  useArtikelStore: () => ({
    artikel: [{ id: 'a-1', titel: 'Kabelkanal' }],
    byId: (id: string) => (id === 'a-1' ? { id: 'a-1', titel: 'Kabelkanal' } : undefined),
  }),
}))

function evt(id: string, erstelltAm = new Date().toISOString()): MindestbestandEreignis {
  return {
    id,
    artikelId: 'a-1',
    standortId: 's-1',
    ausloeserBuchungId: `b-${id}`,
    bestandDanach: 2,
    mindestbestand: 5,
    defizit: 3,
    erstelltAm,
  }
}

/** Mountet das Composable in einer Wegwerf-App und gibt die API zurück. */
async function mountAlarm(optionen: { wiederholung?: boolean } = {}) {
  const { useMindestbestandAlarm } = await import('../useMindestbestandAlarm')
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)

  let api: ReturnType<typeof useMindestbestandAlarm> | null = null
  const probe = defineComponent({
    setup() {
      api = useMindestbestandAlarm(optionen)
      return () => h('div')
    },
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(probe)
  app.use(pinia)
  app.use(router)
  app.mount(el)
  await nextTick()

  return {
    api: api!,
    async destroy() {
      app.unmount()
      el.remove()
    },
  }
}

describe('useMindestbestandAlarm — Trigger', () => {
  beforeEach(() => {
    reactiveState = reactive({
      letzte50: [] as MindestbestandEreignis[],
      offenIds: [] as string[],
      letztesSignalAm: null as string | null,
      istAdmin: true,
      soundAn: true,
      lautstaerke: 70,
      wiederholen: false,
    })
    storeMock.reactiveState = reactiveState
    storeMock.markiereSignalGesendet.mockClear()
    alarmMock.alarmKlingeln.mockClear()
    alarmMock.vibrateMuster.mockClear()
    alarmMock.audioContextBereit.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('klingelt NICHT beim Mount (kein Alarm über historische Events)', async () => {
    // Store ist VOR dem Mount bereits gefüllt — genau das ist der
    // Login-Fall: IndexedDB hat 5 Events, alle alt.
    steuerung.letzte50 = [evt('e5'), evt('e4')]
    const { api, destroy } = await mountAlarm()
    await nextTick()
    expect(api.anzahl.value).toBe(2)
    expect(alarmMock.alarmKlingeln).not.toHaveBeenCalled()
    await destroy()
  })

  it('klingelt NICHT, wenn kein Anker existiert (historische Events unklar)', async () => {
    // Anker null → cooldownAktiv true → kein Alarm. Das ist Absicht:
    // ohne Anker können wir historische von neuen Events nicht trennen.
    const { destroy } = await mountAlarm()
    steuerung.letzte50 = [evt('e1')]
    await nextTick()
    await nextTick()
    expect(alarmMock.alarmKlingeln).not.toHaveBeenCalled()
    await destroy()
  })

  it('klingelt bei neuem Event, wenn der Anker abgelaufen ist', async () => {
    steuerung.letztesSignalAm = new Date(Date.now() - 120_000).toISOString()
    const { destroy } = await mountAlarm()
    steuerung.letzte50 = [evt('e1')]
    await nextTick()
    await nextTick()
    await nextTick()
    expect(storeMock.markiereSignalGesendet).toHaveBeenCalled()
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)
    await destroy()
  })

  it('respektiert den 60-s-Cooldown', async () => {
    steuerung.letztesSignalAm = new Date(Date.now() - 5_000).toISOString()
    const { destroy } = await mountAlarm()
    steuerung.letzte50 = [evt('e1')]
    await nextTick()
    await nextTick()
    await nextTick()
    expect(alarmMock.alarmKlingeln).not.toHaveBeenCalled()
    await destroy()
  })

  it('klingelt auch für Nicht-Admins (Alarm ist rollenoffen)', async () => {
    reactiveState.istAdmin = false
    steuerung.letztesSignalAm = new Date(Date.now() - 120_000).toISOString()
    const { destroy } = await mountAlarm()
    steuerung.letzte50 = [evt('e1')]
    await nextTick()
    await nextTick()
    await nextTick()
    expect(storeMock.markiereSignalGesendet).toHaveBeenCalled()
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)
    await destroy()
  })

  it('klingelt NICHT, wenn der Master-Switch aus ist (auch keine Haptik)', async () => {
    reactiveState.soundAn = false
    steuerung.letztesSignalAm = new Date(Date.now() - 120_000).toISOString()
    const { api, destroy } = await mountAlarm()
    steuerung.letzte50 = [evt('e1')]
    await nextTick()
    await nextTick()
    await nextTick()
    expect(alarmMock.alarmKlingeln).not.toHaveBeenCalled()
    expect(alarmMock.vibrateMuster).not.toHaveBeenCalled()
    expect(api.blitzaktiv.value).toBe(false)
    // Kein Signal → kein Cooldown-Anker, damit der Alarm beim Einschalten
    // sofort nachholen kann.
    expect(storeMock.markiereSignalGesendet).not.toHaveBeenCalled()
    await destroy()
  })

  it('signalTesten bleibt stumm, wenn der Master-Switch aus ist', async () => {
    reactiveState.soundAn = false
    const { api, destroy } = await mountAlarm()
    await api.signalTesten()
    expect(alarmMock.alarmKlingeln).not.toHaveBeenCalled()
    expect(alarmMock.vibrateMuster).not.toHaveBeenCalled()
    expect(api.blitzaktiv.value).toBe(false)
    await destroy()
  })

  it('reicht die Lautstärke als 0..1-Gain durch (70 % → 0.7)', async () => {
    reactiveState.lautstaerke = 70
    steuerung.letztesSignalAm = new Date(Date.now() - 120_000).toISOString()
    const { api, destroy } = await mountAlarm()
    steuerung.letzte50 = [evt('e1')]
    await nextTick()
    await nextTick()
    await nextTick()
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledWith(null, { lautstaerke: 0.7 })
    expect(api.blitzaktiv.value).toBe(true)
    await destroy()
  })

  it('signalTesten umgeht den Cooldown und benutzt die Lautstärke', async () => {
    steuerung.letztesSignalAm = new Date().toISOString() // gerade eben
    reactiveState.lautstaerke = 35
    const { api, destroy } = await mountAlarm()
    await api.signalTesten()
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledWith(null, { lautstaerke: 0.35 })
    await destroy()
  })

  it('signalTesten setzt den Blitz und haptisch, auch ohne Events', async () => {
    reactiveState.soundAn = true
    const { api, destroy } = await mountAlarm()
    await api.signalTesten()
    expect(api.blitzaktiv.value).toBe(true)
    expect(alarmMock.vibrateMuster).toHaveBeenCalled()
    await destroy()
  })

  it('BLITZ_DAUER_MS ist ein sinnvoller Wert (>0, <5s)', () => {
    expect(BLITZ_DAUER_MS).toBeGreaterThan(0)
    expect(BLITZ_DAUER_MS).toBeLessThan(5000)
  })

  // Regression: Die Glocke klingelte für einen Event-Snapshot
  // "Bestand 3", obwohl der Bestand im Hauptlager wieder bei 15 lag.
  // Der Snapshot ist historisch — der Alarm darf nur klingeln, solange
  // die Unterschreitung LIVE noch gilt.
  it('klingelt NICHT, wenn der Bestand wieder über dem Mindestbestand liegt', async () => {
    steuerung.letztesSignalAm = new Date(Date.now() - 120_000).toISOString()
    const { api, destroy } = await mountAlarm()
    steuerung.letzte50 = [evt('e1')]
    await nextTick()
    await nextTick()
    await nextTick()
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)

    // Bestand wird aufgefüllt: das Event bleibt im Log, ist aber erledigt.
    steuerung.markiereErledigt(['e1'])
    await nextTick()
    await nextTick()
    await nextTick()

    expect(api.anzahl.value).toBe(0)
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)
    await destroy()
  })

  it('klingelt nicht, wenn ein NEUES Event bereits erledigt ist', async () => {
    steuerung.letztesSignalAm = new Date(Date.now() - 120_000).toISOString()
    const { destroy } = await mountAlarm()
    steuerung.letzte50 = [evt('e1')]
    await nextTick()
    await nextTick()
    await nextTick()
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)

    // Ausgleichende Buchung im selben Sync: Event trifft ein, gilt aber
    // schon nicht mehr (z. B. Entnahme sofort durch Einlagerung gedeckt).
    steuerung.letztesSignalAm = new Date(Date.now() - 120_000).toISOString()
    steuerung.letzte50 = [evt('e2'), evt('e1')]
    steuerung.markiereErledigt(['e2'])
    await nextTick()
    await nextTick()
    await nextTick()

    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)
    await destroy()
  })

  it('exponiert die Notification-Permission', async () => {
    const { api, destroy } = await mountAlarm()
    expect(['granted', 'denied', 'default', 'unsupported']).toContain(api.permission.value)
    await destroy()
  })
})

describe('useMindestbestandAlarm — Wiederholung bis die Glocke geöffnet wird', () => {
  beforeEach(() => {
    reactiveState = reactive({
      letzte50: [] as MindestbestandEreignis[],
      offenIds: [] as string[],
      letztesSignalAm: null as string | null,
      istAdmin: true,
      soundAn: true,
      lautstaerke: 70,
      wiederholen: true,
    })
    storeMock.reactiveState = reactiveState
    storeMock.markiereSignalGesendet.mockClear()
    alarmMock.alarmKlingeln.mockClear()
    alarmMock.vibrateMuster.mockClear()
    alarmMock.audioContextBereit.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('klingelt sofort nach Mount und danach alle 60 s', async () => {
    vi.useFakeTimers()
    steuerung.letzte50 = [evt('e1')]
    const { destroy } = await mountAlarm({ wiederholung: true })
    await nextTick()
    await nextTick()

    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(COOLDOWN_MS)
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(COOLDOWN_MS)
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(3)

    await destroy()
  })

  it('stoppt, sobald die Glocke geöffnet wird (keine ungesehenen Events mehr)', async () => {
    vi.useFakeTimers()
    steuerung.letzte50 = [evt('e1')]
    const { destroy } = await mountAlarm({ wiederholung: true })
    await nextTick()
    await nextTick()
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)

    // Opening the bell marks everything as seen.
    steuerung.letzte50 = []
    await nextTick()

    await vi.advanceTimersByTimeAsync(COOLDOWN_MS * 3)
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)

    await destroy()
  })

  it('stoppt die Wiederholung, wenn der Bestand wieder aufgefüllt wird', async () => {
    vi.useFakeTimers()
    steuerung.letzte50 = [evt('e1')]
    const { destroy } = await mountAlarm({ wiederholung: true })
    await nextTick()
    await nextTick()
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)

    // Bestand wieder aufgefüllt → nichts mehr zu melden → Timer steht still.
    steuerung.markiereErledigt(['e1'])
    await nextTick()
    await nextTick()

    await vi.advanceTimersByTimeAsync(COOLDOWN_MS * 3)
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)

    await destroy()
  })

  it('wiederholt nicht, wenn die Einstellung aus ist', async () => {
    vi.useFakeTimers()
    reactiveState.wiederholen = false
    steuerung.letzte50 = [evt('e1')]
    const { destroy } = await mountAlarm({ wiederholung: true })
    await nextTick()
    await nextTick()

    await vi.advanceTimersByTimeAsync(COOLDOWN_MS * 3)
    expect(alarmMock.alarmKlingeln).not.toHaveBeenCalled()

    await destroy()
  })

  it('wiederholt nicht, wenn der Klingelton aus ist', async () => {
    vi.useFakeTimers()
    reactiveState.soundAn = false
    steuerung.letzte50 = [evt('e1')]
    const { destroy } = await mountAlarm({ wiederholung: true })
    await nextTick()
    await nextTick()

    await vi.advanceTimersByTimeAsync(COOLDOWN_MS * 3)
    expect(alarmMock.alarmKlingeln).not.toHaveBeenCalled()

    await destroy()
  })

  it('wiederholt auch für Nicht-Admins, wenn der Alarm eingeschaltet ist', async () => {
    vi.useFakeTimers()
    reactiveState.istAdmin = false
    steuerung.letzte50 = [evt('e1')]
    const { destroy } = await mountAlarm({ wiederholung: true })
    await nextTick()
    await nextTick()

    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS)
    expect(alarmMock.alarmKlingeln).toHaveBeenCalledTimes(2)

    await destroy()
  })

  it('besitzt ohne die Option keinen Timer (Settings-Seite klingelt nicht doppelt)', async () => {
    vi.useFakeTimers()
    steuerung.letzte50 = [evt('e1')]
    const { destroy } = await mountAlarm()
    await nextTick()
    await nextTick()

    await vi.advanceTimersByTimeAsync(COOLDOWN_MS * 3)
    expect(alarmMock.alarmKlingeln).not.toHaveBeenCalled()

    await destroy()
  })
})
