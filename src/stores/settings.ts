// Settings-Store: liest die `einstellungen`-Tabelle reaktiv via Dexie liveQuery.
// Speichert sprache, standardStandortId, artikelTypen, akkuTypen, akkutauschAktiv,
// kommissionen, companyName, barcodeTyp, onboardingSeen.
//
// Diese Einstellungen sind Cross-Device-synchronisiert:
//   - artikelTypen, kommissionen, companyName, barcodeTyp → userId = null (global)
//   - sprache, standardStandortId, onboardingSeen → userId = <current user>
// Beim Setzen wird ein Outbox-Eintrag erzeugt, den der Sync-Worker zum
// Server pusht. Der Server ist Source of Truth (LWW auf geaendertAm).
//
// The `sprache` is a client-side effect: `i18n.ts` mirrors the store value
// into the i18n locale. The server does not evaluate the value — it only
// stores it per user, so the setting is the same on every device.
//
// IndexedDB-Konvention: Dexie erlaubt kein `null` in Primary-Key-Komponenten.
// Wir speichern "global" als userId = '' (leerer String) und übersetzen
// in der Domain-Schicht zu/von null. Der TypeScript-Type bleibt null.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import { sessionLesen } from '../auth/session'
import { jetztIso, neueUuid } from '../domain/ids'
import { queueOp } from '../services/sync/worker'
import type { Einstellung } from '../db/types'
import type { AkkuTyp } from '../domain/akkutausch/types'
import { parseAkkuTypen, serialisiereAkkuTypen } from '../domain/akkutausch/serialisierung'

export type Sprache = 'de' | 'en'
export type BarcodeTyp = 'CODE128' | 'EAN13' | 'CODE39'
export type Theme = 'dark' | 'light' | 'auto'

export interface Settings {
  sprache: Sprache
  /**
   * Per-user color scheme. 'auto' follows the system preference by leaving
   * `data-theme` unset on the document root (see `src/theme.ts`).
   */
  theme: Theme
  standardStandortId: string | null
  /** Konfigurierbare Liste der Artikel-Typen (Reihenfolge wie angelegt). */
  artikelTypen: string[]
  /**
   * Konfigurierte Akku-Größen des Akkutausch-Tools (global, Admin-only).
   * Gespeichert als JSON-Array in der Einstellung `akkuTypen`.
   */
  akkuTypen: AkkuTyp[]
  /**
   * Globaler Schalter für die Sichtbarkeit des Akkutausch-Tools. Nur Admins
   * dürfen ihn ändern; ist er aus, werden Navigation, Route und Einstiege
   * ausgeblendet.
   */
  akkutauschAktiv: boolean
  /** Konfigurierbare Liste der Kommissionen/Projekte (Reihenfolge wie angelegt). */
  kommissionen: string[]
  /** Firmenzeichen, nur von Admins konfigurierbar. */
  companyName: string
  /** Barcode-Format für die Artikel-Detail-Ansicht (nur Admins). */
  barcodeTyp: BarcodeTyp
  /**
   * Pro User: hat der User das Onboarding-Tutorial ("Erste Schritte") bereits
   * gesehen / abgeschlossen? Steuert, ob der Tutorial-Modal beim Login
   * automatisch geöffnet wird.
   *
   * Cross-Device-synchronisiert (per-User-Key, PK [key+userId]). Einmal auf
   * einem Gerät abgewählt → auf allen Geräten dieses Users ausgeblendet.
   * Reset über /info → "Tutorial erneut zeigen" setzt die Zeile auf false
   * und wird per Sync (LWW) an alle Geräte verteilt.
   */
  onboardingSeen: boolean
  /**
   * Pro User: hat der User jemals einen erfolgreichen Login abgeschlossen?
   * Wird auf `true` gesetzt, sobald das Onboarding-Modal entweder gezeigt
   * oder bewusst ausgelassen wurde. Dient zusammen mit `onboardingSeen`
   * als Gate: das Modal wird nur noch für Erstnutzer gezeigt, deren
   * `firstLoginDone` noch nicht gesetzt ist. Damit verhindern wir, dass
   * das Modal "aufblitzt", wenn die lokale DB die `onboardingSeen=true`-
   * Zeile noch nicht vom Server gepullt hat (Race-Condition-Schutz).
   */
  firstLoginDone: boolean
  /**
   * Pro User: Master-Switch des Mindestbestand-Alarms.
   *
   * Der Schalter steuert das GESAMTE Signal — Klingelton (WebAudio-
   * Synthese, kein MP3-Asset, siehe `src/services/audio/alarm.ts`),
   * Vibration, Blinken der Glocke und OS-Notification. Aus = nichts
   * davon.
   *
   * Default ist rollenabhängig: Admins starten mit Alarm (sie pflegen
   * die Mindestbestände), normale User starten still und können ihn
   * selbst einschalten. Eine gespeicherte Zeile schlägt immer.
   *
   * Cross-Device-synchronisiert (per-User-Key): Admin stellt den Ton
   * auf Tablet A aus, dann ist er auch auf Tablet B aus.
   */
  mindestbestandSoundAn: boolean
  /**
   * Pro User: Lautstärke des Mindestbestand-Alarms, 0..100.
   * Wird auf den Master-Gain des WebAudio-Graphs gelegt.
   */
  mindestbestandLautstaerke: number
  /**
   * Pro User: Alarm wiederholen, bis die Glocke geöffnet wird?
   *
   * Bei aktivem Klingelton wird der Alarm sofort und danach alle
   * 60 s erneut ausgelöst (Ton + Vibration + Blitz), solange
   * ungesehene Ereignisse vorliegen. Das Öffnen der Glocke setzt
   * `mindestbestand.letzteGesehenAm` und stoppt die Wiederholung.
   * Siehe `useMindestbestandAlarm.ts`.
   */
  mindestbestandWiederholen: boolean
}

const DEFAULTS: Settings = {
  sprache: 'de',
  theme: 'dark',
  standardStandortId: null,
  artikelTypen: ['Zubehör', 'Verbrauchsmaterial'],
  akkuTypen: [],
  akkutauschAktiv: false,
  kommissionen: [],
  companyName: '',
  barcodeTyp: 'CODE128',
  onboardingSeen: false,
  firstLoginDone: false,
  // Safe fallback: the effective default for a user without a stored row is
  // role-dependent (see `alarmDefaultFuerRolle`), never this constant.
  mindestbestandSoundAn: false,
  mindestbestandLautstaerke: 70,
  mindestbestandWiederholen: false,
}

const GLOBAL_KEYS = new Set<string>([
  'artikelTypen',
  'akkuTypen',
  'akkutauschAktiv',
  'kommissionen',
  'companyName',
  'barcodeTyp',
])
const PER_USER_KEYS = new Set<string>([
  'sprache',
  'theme',
  'standardStandortId',
  'onboardingSeen',
  'firstLoginDone',
  'mindestbestandSoundAn',
  'mindestbestandLautstaerke',
  'mindestbestandWiederholen',
])
const GLOBAL_INDEX = ''

/**
 * Role-dependent default for the minimum-stock alarm master switch, used
 * only while no `mindestbestandSoundAn` row exists for the user. Admins
 * start with the alarm on (they own the thresholds); everyone else starts
 * silent and may enable it in the settings themselves.
 */
export function alarmDefaultFuerRolle(istAdmin: boolean): boolean {
  return istAdmin
}

function scopeForKey(key: string): 'global' | 'user' {
  return GLOBAL_KEYS.has(key) ? 'global' : 'user'
}

function fromRows(rows: Einstellung[], currentUserId: string | null, istAdmin: boolean): Settings {
  // Domain-normalisierte Sicht: userId = '' wird wie null behandelt.
  const norm = (uid: string | null): string | null => (uid === '' ? null : uid)
  const byKey = new Map<string, Einstellung>()
  for (const r of rows) {
    const isGlobal = norm(r.userId) === null
    if (isGlobal) {
      byKey.set(r.key, r)
    } else if (currentUserId !== null && norm(r.userId) === currentUserId) {
      byKey.set(r.key, r)
    }
  }

  // artikelTypen und kommissionen werden als JSON-Array serialisiert; Fehlertoleranz bei Altbestand.
  let typen: string[] = DEFAULTS.artikelTypen
  const typenRow = byKey.get('artikelTypen')
  if (typenRow) {
    try {
      const parsed: unknown = JSON.parse(typenRow.value)
      if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) {
        typen = parsed
      }
    } catch {
      // bewusst ignorieren → Defaults
    }
  }

  let kommissionen: string[] = DEFAULTS.kommissionen
  const kommissionenRow = byKey.get('kommissionen')
  if (kommissionenRow) {
    try {
      const parsed: unknown = JSON.parse(kommissionenRow.value)
      if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) {
        kommissionen = parsed
      }
    } catch {
      // bewusst ignorieren → Defaults
    }
  }

  // akkuTypen: JSON-Array mit den Akku-Größen des Akkutausch-Tools.
  // Fehlertolerant — kaputte Einträge werden verworfen, der Rest bleibt nutzbar.
  let akkuTypen: AkkuTyp[] = DEFAULTS.akkuTypen
  const akkuTypenRow = byKey.get('akkuTypen')
  if (akkuTypenRow) {
    akkuTypen = parseAkkuTypen(akkuTypenRow.value)
  }

  const akkutauschRow = byKey.get('akkutauschAktiv')
  const akkutauschAktiv =
    akkutauschRow !== undefined ? akkutauschRow.value === 'true' : DEFAULTS.akkutauschAktiv

  const spracheRow = byKey.get('sprache')
  // The client stores 'de' | 'en', but the server-side setup route writes
  // 'de-DE' | 'en-US' (see server/src/auth/setup-routes.ts). Both spellings
  // are normalized to the short form so a server-written row does not fall
  // back to the default (which would silently show German for 'en-US').
  const spracheRaw = spracheRow?.value
  const sprache: Sprache =
    spracheRaw === 'en' || spracheRaw === 'en-US'
      ? 'en'
      : spracheRaw === 'de' || spracheRaw === 'de-DE'
        ? 'de'
        : DEFAULTS.sprache

  const themeRow = byKey.get('theme')
  const themeRaw = themeRow?.value
  const theme: Theme =
    themeRaw === 'dark' || themeRaw === 'light' || themeRaw === 'auto' ? themeRaw : DEFAULTS.theme

  const standortRow = byKey.get('standardStandortId')
  const standardStandortId = standortRow?.value ? standortRow.value : DEFAULTS.standardStandortId

  const companyNameRow = byKey.get('companyName')
  const companyName = companyNameRow?.value ?? DEFAULTS.companyName

  const barcodeTypRow = byKey.get('barcodeTyp')
  const barcodeTypRaw = (barcodeTypRow?.value ?? DEFAULTS.barcodeTyp) as BarcodeTyp
  const barcodeTyp: BarcodeTyp =
    barcodeTypRaw === 'CODE128' || barcodeTypRaw === 'EAN13' || barcodeTypRaw === 'CODE39'
      ? barcodeTypRaw
      : DEFAULTS.barcodeTyp

  const onboardingSeenRow = byKey.get('onboardingSeen')
  const onboardingSeen = onboardingSeenRow?.value === 'true'

  const firstLoginDoneRow = byKey.get('firstLoginDone')
  const firstLoginDone = firstLoginDoneRow?.value === 'true'

  const soundAnRow = byKey.get('mindestbestandSoundAn')
  const mindestbestandSoundAn =
    soundAnRow !== undefined ? soundAnRow.value === 'true' : alarmDefaultFuerRolle(istAdmin)

  // Lautstärke ist ein Integer 0..100. Wir klemmen defensiv, weil der
  // Wert aus der DB kommt (manuell geändert, oder uralter Stand).
  const lautRow = byKey.get('mindestbestandLautstaerke')
  const lautGeparst = lautRow ? Number.parseInt(lautRow.value, 10) : Number.NaN
  const mindestbestandLautstaerke =
    Number.isFinite(lautGeparst) && lautGeparst >= 0 && lautGeparst <= 100
      ? lautGeparst
      : DEFAULTS.mindestbestandLautstaerke

  const wiederholenRow = byKey.get('mindestbestandWiederholen')
  const mindestbestandWiederholen =
    wiederholenRow !== undefined
      ? wiederholenRow.value === 'true'
      : DEFAULTS.mindestbestandWiederholen

  return {
    sprache,
    theme,
    standardStandortId,
    artikelTypen: typen,
    akkuTypen,
    akkutauschAktiv,
    kommissionen,
    companyName,
    barcodeTyp,
    onboardingSeen,
    firstLoginDone,
    mindestbestandSoundAn,
    mindestbestandLautstaerke,
    mindestbestandWiederholen,
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>({
    ...DEFAULTS,
    // The role-dependent alarm default must already apply before the first
    // liveQuery emission — otherwise an admin would briefly see the switch
    // off (and the bell would not arm) while the DB is still loading.
    mindestbestandSoundAn: alarmDefaultFuerRolle(sessionLesen()?.rolle === 'admin'),
    artikelTypen: [...DEFAULTS.artikelTypen],
    akkuTypen: [...DEFAULTS.akkuTypen],
  })
  const geladen = ref(false)
  let subscription: Subscription | null = null
  // Prevent repeating the one-time legacy migration while the liveQuery
  // catches up with the freshly written row.
  const migratedLegacyThemeFor = new Set<string>()

  function start() {
    if (subscription) return
    // currentUserId wird bei jedem Update frisch aus der Session gelesen,
    // nicht in der Closure eingefroren. Sonst zeigt der Settings-View
    // nach einem Login (Subscription lief schon vor dem Login mit
    // userId=null) die frisch gespeicherte per-User-Einstellung nicht an.
    const observable = liveQuery(() => getDb().einstellungen.toArray())
    subscription = observable.subscribe({
      next: (rows) => {
        const session = sessionLesen()
        const currentUserId = session?.userId ?? null
        settings.value = fromRows(rows, currentUserId, session?.rolle === 'admin')
        geladen.value = true
        if (currentUserId !== null && !migratedLegacyThemeFor.has(currentUserId)) {
          migratedLegacyThemeFor.add(currentUserId)
          void migriereLegacyTheme(rows, currentUserId)
        }
      },
      error: (e) => {
        console.error('settings liveQuery error:', e)
      },
    })
  }

  /**
   * One-time migration of the pre-per-user theme choice, which used to live
   * in `localStorage`. Runs only when the logged-in user has no `theme` row
   * yet. The legacy key is removed afterwards so it cannot leak into another
   * user on the same device.
   */
  async function migriereLegacyTheme(rows: Einstellung[], currentUserId: string): Promise<void> {
    const hasTheme = rows.some((row) => row.key === 'theme' && row.userId === currentUserId)
    if (hasTheme) return
    const legacy = localStorage.getItem('theme')
    if (legacy !== 'dark' && legacy !== 'light' && legacy !== 'auto') return
    localStorage.removeItem('theme')
    await setKey('theme', legacy)
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  /**
   * Setzt eine Einstellung. userId wird automatisch aus dem aktuellen
   * Auth-State abgeleitet: global für artikelTypen/kommissionen/companyName,
   * sonst current user. Erzeugt zusätzlich einen Outbox-Eintrag für den
   * Server-Sync.
   */
  async function setKey(key: string, value: string): Promise<void> {
    if (!PER_USER_KEYS.has(key) && !GLOBAL_KEYS.has(key)) {
      throw new Error(`Unbekannter Einstellungs-Key: ${key}`)
    }
    const scope = scopeForKey(key)
    const session = sessionLesen()
    const userId: string | null = scope === 'user' ? (session?.userId ?? null) : null
    if (scope === 'user' && userId === null) {
      // Vor Login sollte der User-Key gar nicht geschrieben werden. Wir
      // loggen und brechen ab, damit keine ungewollten globalen Zeilen
      // entstehen, die ein später angemeldeter User erbt.
      console.warn(`[settings] Per-User-Key "${key}" ohne aktiven User übersprungen`)
      return
    }
    const geaendertAm = jetztIso()
    // Domain-Sicht: userId = null für global. IndexedDB-Sicht: '' als
    // Primary-Key-Marker. Wir schreiben den normalisierten Datensatz in
    // die Outbox (an den Server geht null).
    const indexedRow: Einstellung = {
      key,
      userId: userId === null ? GLOBAL_INDEX : userId,
      value,
      geaendertAm,
    }
    await getDb().einstellungen.put(indexedRow)
    const outboxRow: Einstellung = { key, userId, value, geaendertAm }
    await queueOp('einstellung', 'upsert', outboxRow)
  }

  async function setSprache(sprache: Sprache): Promise<void> {
    await setKey('sprache', sprache)
  }

  async function setTheme(theme: Theme): Promise<void> {
    await setKey('theme', theme)
  }

  async function setStandardStandort(id: string | null): Promise<void> {
    await setKey('standardStandortId', id ?? '')
  }

  async function setArtikelTypen(typen: string[]): Promise<void> {
    await setKey('artikelTypen', JSON.stringify(typen))
  }

  /**
   * Setzt die Akku-Größen des Akkutausch-Tools. Global und damit
   * Admin-only — der Server lehnt Schreibversuche von normalen Usern ab.
   */
  async function setAkkuTypen(typen: readonly AkkuTyp[]): Promise<void> {
    await setKey('akkuTypen', serialisiereAkkuTypen(typen))
  }

  /**
   * Aktiviert/deaktiviert das Akkutausch-Tool. Global und damit Admin-only —
   * der Server lehnt Schreibversuche von normalen Usern ab.
   */
  async function setAkkutauschAktiv(aktiv: boolean): Promise<void> {
    await setKey('akkutauschAktiv', aktiv ? 'true' : 'false')
  }

  async function setKommissionen(typen: string[]): Promise<void> {
    await setKey('kommissionen', JSON.stringify(typen))
  }

  async function setBarcodeTyp(typ: BarcodeTyp): Promise<void> {
    await setKey('barcodeTyp', typ)
  }

  async function setOnboardingSeen(seen: boolean): Promise<void> {
    await setKey('onboardingSeen', seen ? 'true' : 'false')
  }

  async function setFirstLoginDone(done: boolean): Promise<void> {
    await setKey('firstLoginDone', done ? 'true' : 'false')
  }

  async function setMindestbestandSoundAn(an: boolean): Promise<void> {
    await setKey('mindestbestandSoundAn', an ? 'true' : 'false')
  }

  async function setMindestbestandLautstaerke(prozent: number): Promise<void> {
    const geklemmt = Math.max(0, Math.min(100, Math.round(prozent)))
    await setKey('mindestbestandLautstaerke', String(geklemmt))
  }

  async function setMindestbestandWiederholen(an: boolean): Promise<void> {
    await setKey('mindestbestandWiederholen', an ? 'true' : 'false')
  }

  // Hilfsfunktion: legt eine UUID-basierte ID an (für Outbox-Einträge).
  void neueUuid

  return {
    settings,
    geladen,
    start,
    stop,
    setKey,
    setSprache,
    setTheme,
    setStandardStandort,
    setArtikelTypen,
    setAkkuTypen,
    setAkkutauschAktiv,
    setKommissionen,
    setBarcodeTyp,
    setOnboardingSeen,
    setFirstLoginDone,
    setMindestbestandSoundAn,
    setMindestbestandLautstaerke,
    setMindestbestandWiederholen,
  }
})
