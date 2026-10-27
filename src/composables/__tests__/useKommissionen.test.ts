// Tests des Kommissionen-Composables.
//
// Das Composable liefert die Auswahl-Optionen für das Buchungsformular:
// konfigurierte Kommissionen (globale Einstellung) zuerst, danach die
// "verwaisten" Namen, die nur in Buchungen vorkommen. Jeder User darf eine
// Kommission ergänzen — der Server merged das mit dem gespeicherten Stand.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useKommissionen } from '../useKommissionen'
import { useSettingsStore } from '../../stores/settings'
import { useBuchungStore } from '../../stores/buchung'
import { getDb, resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { jetztIso, neueUuid } from '../../domain/ids'
import type { Buchung } from '../../db/types'

let pinia: Pinia

function buchung(projekt: string): Buchung {
  const jetzt = jetztIso()
  return {
    id: neueUuid(),
    artikelId: 'a1',
    standortId: 's1',
    standortZielId: null,
    typ: 'entnahme',
    menge: -1,
    paarId: null,
    projekt,
    erstelltAm: jetzt,
    clientEingabeAm: jetzt,
    erstelltVon: 'user-1',
    kommentar: null,
    mitteilungAn: null,
    stornoVon: null,
    storno: false,
    storniertDurch: null,
    serverId: null,
  }
}

async function warteAufStore(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 60))
}

describe('useKommissionen', () => {
  beforeEach(async () => {
    resetDbForTests()
    await clearLocalDbForTests()
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(async () => {
    await clearLocalDbForTests()
  })

  it('liefert die konfigurierten Kommissionen in der eingestellten Reihenfolge', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['Projekt Müller', 'Projekt Schmidt'])
    await warteAufStore()

    const { optionen } = useKommissionen()
    expect(optionen.value).toEqual(['Projekt Müller', 'Projekt Schmidt'])
    settings.stop()
  })

  it('haengt verwaiste Kommissionen aus Buchungen alphabetisch an', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['Projekt Müller'])
    const buchungStore = useBuchungStore(pinia)
    await getDb().buchungen.bulkAdd([buchung('Projekt Zebra'), buchung('Projekt Alpha')])
    buchungStore.start()
    await warteAufStore()

    const { optionen, verwendungen } = useKommissionen()
    expect(optionen.value).toEqual(['Projekt Müller', 'Projekt Alpha', 'Projekt Zebra'])
    const verwaist = verwendungen.value.find((v) => v.name === 'Projekt Alpha')
    expect(verwaist?.verwaist).toBe(true)
    expect(verwaist?.anzahl).toBe(1)
    settings.stop()
    buchungStore.stop()
  })

  it('lehnt leere, doppelte und zu lange Namen ab', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['Projekt Müller'])
    await warteAufStore()

    const { hinzufuegen } = useKommissionen()
    expect(await hinzufuegen('   ')).toBe('leer')
    expect(await hinzufuegen('Projekt Müller')).toBe('duplikat')
    expect(await hinzufuegen('x'.repeat(121))).toBe('zuLang')
    settings.stop()
  })

  it('ergänzt eine neue Kommission in der globalen Liste', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['Projekt Müller'])
    await warteAufStore()

    const { hinzufuegen, optionen } = useKommissionen()
    expect(await hinzufuegen('  Projekt Schmidt  ')).toBeNull()
    await warteAufStore()

    expect(settings.settings.kommissionen).toEqual(['Projekt Müller', 'Projekt Schmidt'])
    expect(optionen.value).toContain('Projekt Schmidt')
    settings.stop()
  })
})
