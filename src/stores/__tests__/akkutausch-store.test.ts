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

/**
 * Inventur-Buchung des Akku-Artikels: datiert den Bestand und macht das
 * Markieren "bestellt" erst moeglich (Inventur innerhalb von 4 Wochen).
 */
async function inventurBuchen(artikelId: string, standortId: string, menge: number): Promise<void> {
  await getDb().buchungen.put({
    id: `b-inv-${artikelId}`,
    artikelId,
    standortId,
    standortZielId: null,
    typ: 'inventur',
    menge,
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
}

/** Akku-Groesse t1 mit Artikel a-1 als globale Einstellung. */
async function akkuTypAnlegen(): Promise<void> {
  const settings = useSettingsStore()
  settings.start()
  await settings.setAkkuTypen([
    { id: 't1', kapazitaetAh: 12.5, von: 12.0, bis: 12.9, artikelId: 'a-1' },
  ])
  await new Promise((r) => setTimeout(r, 50))
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

    // Mit Puffer 2: 10 Bedarf - 3 Bestand + 2 Puffer = 9 zu bestellen.
    expect(store.planung.zeilen[0]?.puffer).toBe(2)
    expect(store.planung.zeilen[0]?.bestellmenge).toBe(9)

    // Der Puffer liegt als Mindestbestand des Artikels am Hauptlager.
    const konfigStore = useArtikelStandortMindestbestandStore()
    expect(konfigStore.wertFuer('a-1', 's-1')).toBe(2)
  })

  it('setzt den Mindestbestand beim Markieren "bestellt" auf den Bedarf', async () => {
    await hauptlagerAnlegen()
    const standortStore = useStandortStore()
    standortStore.start()
    await new Promise((r) => setTimeout(r, 50))
    await akkuTypAnlegen()
    await inventurBuchen('a-1', 's-1', 3)

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
    store.quartal = 1
    store.jahr = new Date().getFullYear()
    await new Promise((r) => setTimeout(r, 50))

    // Ohne Puffer: 10 Bedarf - 3 Bestand = 7 zu bestellen.
    expect(store.planung.zeilen[0]?.bestellmenge).toBe(7)

    const ergebnis = await store.bestellungMarkieren()
    expect(ergebnis.bestellung).not.toBeNull()
    expect(ergebnis.aktualisierteMindestbestaende).toBe(1)
    await new Promise((r) => setTimeout(r, 50))

    // Mindestbestand am Hauptlager = Bedarf.
    const konfigStore = useArtikelStandortMindestbestandStore()
    expect(konfigStore.wertFuer('a-1', 's-1')).toBe(10)
    const eintrag = await getDb().artikelStandortMindestbestaende.get(['a-1', 's-1'])
    expect(eintrag?.mindestbestand).toBe(10)

    // Das Archiv haelt den bisherigen Puffer (0) — er wird nicht nachgetragen.
    expect(ergebnis.bestellung?.zeilen[0]?.reserve).toBe(0)
    expect(ergebnis.bestellung?.zeilen[0]?.soll).toBe(10)
    expect(ergebnis.bestellung?.zeilen[0]?.bedarf).toBe(7)

    // Das Quartal ist gedeckt: es wird nichts mehr bestellt.
    expect(store.planung.zeilen[0]?.bedarf).toBe(10)
    expect(store.planung.zeilen[0]?.bestellmenge).toBe(0)
    expect(store.planung.bestellzeilen).toHaveLength(0)

    const outbox = await getDb().outbox.toArray()
    expect(outbox.map((o) => o.entity)).toContain('akku_bestellung')
    const konfigOps = outbox.filter((o) => o.entity === 'artikel_standort_mindestbestand')
    expect(konfigOps).toHaveLength(1)
    expect(konfigOps[0]?.op).toBe('create')
  })

  it('laesst den Puffer ohne Bedarf unangetastet', async () => {
    await hauptlagerAnlegen()
    const standortStore = useStandortStore()
    standortStore.start()
    await new Promise((r) => setTimeout(r, 50))
    await akkuTypAnlegen()
    await inventurBuchen('a-1', 's-1', 3)

    const konfigStore = useArtikelStandortMindestbestandStore()
    konfigStore.start()
    await konfigStore.setzen('a-1', 's-1', 5)

    const store = useAkkutauschStore()
    store.start()
    await warteAufSpiegel(store)
    store.quartal = 1
    store.jahr = new Date().getFullYear()
    await new Promise((r) => setTimeout(r, 50))

    // Kein Bedarf, aber Bestand 3 unter Puffer 5 -> es wird auf 5 aufgefuellt.
    expect(store.planung.zeilen[0]?.bedarf).toBe(0)
    expect(store.planung.zeilen[0]?.bestellmenge).toBe(2)

    const outbox = await getDb().outbox.toArray()
    const opsVorher = outbox.filter((o) => o.entity === 'artikel_standort_mindestbestand').length

    const ergebnis = await store.bestellungMarkieren()
    expect(ergebnis.bestellung).not.toBeNull()
    expect(ergebnis.aktualisierteMindestbestaende).toBe(0)
    await new Promise((r) => setTimeout(r, 50))

    // Der Admin-Puffer bleibt, weil das Quartal keinen Bedarf hat.
    expect(konfigStore.wertFuer('a-1', 's-1')).toBe(5)
    expect(await getDb().artikelStandortMindestbestaende.get(['a-1', 's-1'])).toBeDefined()
    const opsNachher = (await getDb().outbox.toArray()).filter(
      (o) => o.entity === 'artikel_standort_mindestbestand',
    )
    expect(opsNachher).toHaveLength(opsVorher)
  })

  it('nimmt die letzte Bestellung zurueck und stellt den Puffer wieder her', async () => {
    await hauptlagerAnlegen()
    const standortStore = useStandortStore()
    standortStore.start()
    await new Promise((r) => setTimeout(r, 50))
    await akkuTypAnlegen()
    await inventurBuchen('a-1', 's-1', 3)

    const konfigStore = useArtikelStandortMindestbestandStore()
    konfigStore.start()
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
    store.quartal = 1
    store.jahr = new Date().getFullYear()
    await new Promise((r) => setTimeout(r, 50))

    const markiert = await store.bestellungMarkieren()
    expect(markiert.bestellung).not.toBeNull()
    await new Promise((r) => setTimeout(r, 50))

    // Bestellt: Mindestbestand = Bedarf = 10.
    expect(konfigStore.wertFuer('a-1', 's-1')).toBe(10)
    expect(store.bestellungFuerQuartal).not.toBeNull()

    const undo = await store.bestellungRueckgaengig()
    expect(undo.bestellung?.storno).toBe(true)
    expect(undo.wiederhergestellteMindestbestaende).toBe(1)
    await new Promise((r) => setTimeout(r, 50))

    // Der Puffer (2) ist wiederhergestellt, der Snapshot bleibt im Archiv.
    expect(konfigStore.wertFuer('a-1', 's-1')).toBe(2)
    const archiv = await getDb().akkuBestellungen.toArray()
    expect(archiv).toHaveLength(1)
    expect(archiv[0]?.storno).toBe(true)
    expect(archiv[0]?.stornoAm).not.toBeNull()

    // Das Quartal ist wieder frei — es kann erneut bestellt werden.
    expect(store.bestellungFuerQuartal).toBeNull()
    expect(store.planung.zeilen[0]?.bestellmenge).toBe(9)

    const outbox = await getDb().outbox.toArray()
    const bestellOps = outbox.filter((o) => o.entity === 'akku_bestellung')
    expect(bestellOps.map((o) => o.op).sort()).toEqual(['create', 'update'])
  })

  it('nimmt nur die letzte Bestellung zurueck', async () => {
    await hauptlagerAnlegen()
    const standortStore = useStandortStore()
    standortStore.start()
    await new Promise((r) => setTimeout(r, 50))
    await akkuTypAnlegen()
    await inventurBuchen('a-1', 's-1', 3)

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
    store.quartal = 1
    store.jahr = new Date().getFullYear()
    await new Promise((r) => setTimeout(r, 50))
    await store.bestellungMarkieren()
    await new Promise((r) => setTimeout(r, 50))

    // Ein aelteres Quartal bestellen.
    store.quartal = 2
    await new Promise((r) => setTimeout(r, 50))
    await store.bestellungMarkieren()
    await new Promise((r) => setTimeout(r, 50))

    const archiv = await getDb().akkuBestellungen.toArray()
    expect(archiv).toHaveLength(2)

    const undo = await store.bestellungRueckgaengig()
    expect(undo.bestellung).not.toBeNull()
    await new Promise((r) => setTimeout(r, 50))

    const nachher = await getDb().akkuBestellungen.toArray()
    const storniert = nachher.filter((b) => b.storno)
    expect(storniert).toHaveLength(1)
    // Nur die letzte Bestellung ist storniert.
    expect(storniert[0]?.id).toBe(undo.bestellung?.id)

    // Ein zweites Ruecknehmen ist nicht moeglich.
    const zweites = await store.bestellungRueckgaengig()
    expect(zweites.bestellung).toBeNull()
  })
})
