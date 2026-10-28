// Tests für den Akkutausch-Store:
//   * Netzteile/Projektakkus landen in Dexie und erzeugen Outbox-Ops.
//   * Bearbeiten erzeugt `update`, Löschen einen Soft-Delete (`geloescht`).
//   * Die Planung nutzt Bestand (Summe aller Standorte) und Reserve
//     (Mindestbestand am Hauptlager).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'
import { getDb, setDb } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { useAkkutauschStore } from '../akkutausch'
import { useArtikelStandortMindestbestandStore } from '../artikelStandortMindestbestand'
import { useSettingsStore } from '../settings'
import { useStandortStore } from '../standort'
import { jetztIso } from '../../domain/ids'

async function warteAufSpiegel(store: ReturnType<typeof useAkkutauschStore>): Promise<void> {
  for (let i = 0; i < 50 && !store.geladen; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Legt einen Standard-Standort (Hauptlager) an. */
async function hauptlagerAnlegen(id = 's-1'): Promise<void> {
  const db = getDb()
  await db.standorte.put({
    id,
    name: 'Hauptlager',
    typ: 'lager',
    projekt: null,
    kennzeichen: null,
    standard: true,
    archiviert: false,
    geaendertAm: jetztIso(),
    erstelltAm: jetztIso(),
  })
}

describe('useAkkutauschStore', () => {
  beforeEach(async () => {
    await clearLocalDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await clearLocalDbForTests()
  })

  it('legt ein Netzteil an und queued einen create-Op', async () => {
    const store = useAkkutauschStore()
    await store.netzteilSpeichern({
      anlage: 'Anlage 1',
      objekt: 'Objekt 1',
      name: 'Notlichtaggregat',
      einbaudatum: '2020-01-15',
      intervallJahre: 5,
      kapazitaetAh: 12.5,
      anzahl: 2,
      gruppe: null,
      plz: null,
      vdsAnerkennung: null,
      bemerkung: null,
    })

    const rows = await getDb().akkuNetzteile.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ anlage: 'Anlage 1', kapazitaetAh: 12.5, geloescht: false })

    const outbox = await getDb().outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.entity).toBe('akku_netzteil')
    expect(outbox[0]?.op).toBe('create')
  })

  it('queued beim Bearbeiten ein update', async () => {
    const store = useAkkutauschStore()
    await store.netzteilSpeichern({
      anlage: 'Anlage 1',
      objekt: 'Objekt 1',
      name: 'Notlichtaggregat',
      einbaudatum: '2020-01-15',
      intervallJahre: 5,
      kapazitaetAh: 12.5,
      anzahl: 2,
      gruppe: null,
      plz: null,
      vdsAnerkennung: null,
      bemerkung: null,
    })
    const [angelegt] = await getDb().akkuNetzteile.toArray()
    await store.netzteilSpeichern({
      id: angelegt?.id,
      anlage: 'Anlage 1',
      objekt: 'Objekt 2',
      name: 'Notlichtaggregat',
      einbaudatum: '2020-01-15',
      intervallJahre: 5,
      kapazitaetAh: 12.5,
      anzahl: 2,
      gruppe: null,
      plz: null,
      vdsAnerkennung: null,
      bemerkung: null,
    })
    const outbox = await getDb().outbox.toArray()
    expect(outbox.map((o) => o.op).sort()).toEqual(['create', 'update'])
    const rows = await getDb().akkuNetzteile.toArray()
    expect(rows[0]?.objekt).toBe('Objekt 2')
  })

  it('loescht ein Netzteil als Soft-Delete (Tombstone bleibt erhalten)', async () => {
    const store = useAkkutauschStore()
    await store.netzteilSpeichern({
      anlage: 'Anlage 1',
      objekt: 'Objekt 1',
      name: 'Notlichtaggregat',
      einbaudatum: '2020-01-15',
      intervallJahre: 5,
      kapazitaetAh: 12.5,
      anzahl: 2,
      gruppe: null,
      plz: null,
      vdsAnerkennung: null,
      bemerkung: null,
    })
    const [angelegt] = await getDb().akkuNetzteile.toArray()
    await store.netzteilLoeschen(angelegt?.id ?? '')

    const rows = await getDb().akkuNetzteile.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.geloescht).toBe(true)
    const outbox = await getDb().outbox.toArray()
    expect(outbox.map((o) => o.op)).toContain('update')
  })

  it('legt Projektakkus an und loescht sie als Soft-Delete', async () => {
    const store = useAkkutauschStore()
    await store.projektSpeichern({
      projekt: 'Bauvorhaben',
      menge: 4,
      artAh: 100,
      quartal: 1,
      jahr: 2027,
    })
    const rows = await getDb().akkuProjekte.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ projekt: 'Bauvorhaben', menge: 4, geloescht: false })

    await store.projektLoeschen(rows[0]?.id ?? '')
    const nachher = await getDb().akkuProjekte.toArray()
    expect(nachher[0]?.geloescht).toBe(true)
  })

  it('plant mit Bestand und Puffer (Mindestbestand am Hauptlager)', async () => {
    await hauptlagerAnlegen()
    const standortStore = useStandortStore()
    standortStore.start()
    await new Promise((r) => setTimeout(r, 50))

    const settings = useSettingsStore()
    settings.start()
    await settings.setAkkuTypen([
      { id: 't1', kapazitaetAh: 12.5, von: 12.0, bis: 12.9, artikelId: 'a-1' },
    ])
    await new Promise((r) => setTimeout(r, 50))

    // Bestand: 3 Stueck per Buchung; Puffer: 2 am Hauptlager.
    await getDb().buchungen.put({
      id: 'b-1',
      artikelId: 'a-1',
      standortId: 's-1',
      standortZielId: null,
      typ: 'einlagerung',
      menge: 3,
      paarId: null,
      projekt: null,
      erstelltAm: jetztIso(),
      clientEingabeAm: jetztIso(),
      erstelltVon: 'u-1',
      kommentar: null,
      mitteilungAn: null,
      stornoVon: null,
      storno: false,
      storniertDurch: null,
      serverId: null,
    })
    const konfigStore = useArtikelStandortMindestbestandStore()
    await konfigStore.setzen('a-1', 's-1', 2)

    const store = useAkkutauschStore()
    store.start()
    await warteAufSpiegel(store)
    await store.projektSpeichern({
      projekt: 'Bauvorhaben',
      menge: 10,
      artAh: 12.5,
      quartal: 1,
      jahr: new Date().getFullYear(),
    })
    await warteAufSpiegel(store)

    store.quartal = 1
    store.jahr = new Date().getFullYear()
    await new Promise((r) => setTimeout(r, 50))

    const zeile = store.planung.zeilen.find((z) => z.typ.id === 't1')
    expect(zeile?.bedarf).toBe(10)
    expect(zeile?.bestand).toBe(3)
    expect(zeile?.puffer).toBe(2)
    expect(zeile?.verfuegbar).toBe(1)
    expect(zeile?.bestellmenge).toBe(9)
    expect(store.planung.bestellzeilen[0]?.menge).toBe(9)
  })

  it('speichert den Puffer am Hauptlager und rechnet die Bestellmenge neu', async () => {
    await hauptlagerAnlegen()
    const standortStore = useStandortStore()
    standortStore.start()
    await new Promise((r) => setTimeout(r, 50))

    const settings = useSettingsStore()
    settings.start()
    await settings.setAkkuTypen([
      { id: 't1', kapazitaetAh: 12.5, von: 12.0, bis: 12.9, artikelId: 'a-1' },
    ])
    await new Promise((r) => setTimeout(r, 50))

    // Bestand: 3 Stueck.
    await getDb().buchungen.put({
      id: 'b-1',
      artikelId: 'a-1',
      standortId: 's-1',
      standortZielId: null,
      typ: 'einlagerung',
      menge: 3,
      paarId: null,
      projekt: null,
      erstelltAm: jetztIso(),
      clientEingabeAm: jetztIso(),
      erstelltVon: 'u-1',
      kommentar: null,
      mitteilungAn: null,
      stornoVon: null,
      storno: false,
      storniertDurch: null,
      serverId: null,
    })

    const store = useAkkutauschStore()
    store.start()
    await warteAufSpiegel(store)
    await store.projektSpeichern({
      projekt: 'Bauvorhaben',
      menge: 10,
      artAh: 12.5,
      quartal: 1,
      jahr: new Date().getFullYear(),
    })
    await warteAufSpiegel(store)

    store.quartal = 1
    store.jahr = new Date().getFullYear()
    await new Promise((r) => setTimeout(r, 50))

    // Ohne Puffer: 3 von 10 Stueck sind im Bestand -> 7 zu bestellen.
    expect(store.planung.zeilen[0]?.puffer).toBe(0)
    expect(store.planung.zeilen[0]?.bestellmenge).toBe(7)

    await store.pufferSpeichern('a-1', 2)
    await new Promise((r) => setTimeout(r, 50))

    // Mit Puffer 2 bleibt nur 1 Stueck frei verfuegbar -> 9 zu bestellen.
    expect(store.planung.zeilen[0]?.puffer).toBe(2)
    expect(store.planung.zeilen[0]?.verfuegbar).toBe(1)
    expect(store.planung.zeilen[0]?.bestellmenge).toBe(9)

    // Der Puffer liegt als Mindestbestand des Artikels am Hauptlager.
    const konfigStore = useArtikelStandortMindestbestandStore()
    expect(konfigStore.wertFuer('a-1', 's-1')).toBe(2)
  })
})
