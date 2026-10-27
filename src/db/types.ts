// Domänen-Typen für castel.
// Quelle der Wahrheit: PLAN.md §4.
// Alle Entitäten haben `id: string` (UUID via crypto.randomUUID()).
// Buchungen sind append-only (id + erstelltAm sind unveränderlich).

export type Iso = string // ISO-8601 UTC, z. B. "2025-04-14T11:17:49.000Z"

export type ArtikelStatus = 'verfuegbar' | 'reserviert' | 'gesperrt' | 'ausgesondert' | 'archiviert'
export type NachbestellHinweis = 'i.O' | 'bald' | 'dringend' | null
export type StandortTyp = 'lager' | 'auto' | 'baustelle' | 'extern'
export type BuchungsTyp =
  'einlagerung' | 'entnahme' | 'umlagerung' | 'inventur' | 'kommission' | 'storno'

export interface Artikel {
  id: string
  sharePointId: number | null
  titel: string
  status: ArtikelStatus
  typ: string
  lieferant: string | null
  verpackungseinheit: number
  mindestbestand: number | null
  nachbestellHinweis: NachbestellHinweis
  bestellnummer: string | null
  /** Strichcode (EAN/Code128/QR) des Artikels. Wird vom Scanner
   *  gelesen und ist semantisch getrennt von `bestellnummer` (das ist
   *  die Bestellnummer des Lieferanten). `null` = kein Barcode
   *  hinterlegt. */
  barcode: string | null
  /** Marker "neu" fuer den Etiketten-Druck (DIN-A4-Bogen). `true` = der
   *  Artikel ist als neu markiert und soll noch ein Etikett bekommen.
   *  Neue Artikel starten mit `true`; die Marker lassen sich per Button
   *  setzen bzw. loeschen (siehe `etikettenIstNeu` in src/domain/etiketten.ts). */
  etikettenNeu: boolean
  listenpreis: number | null
  /** Netto-Einkaufspreis je Verpackungseinheit, in Cent. Nur Admin-sichtbar
   *  und nur fuer Admins im lokalen Spiegel (siehe Sync-Rollenlogik). */
  einkaufspreis: number | null
  geaendertAm: Iso | null
  erstelltAm: Iso
}

export interface Standort {
  id: string
  name: string
  typ: StandortTyp
  projekt: string | null
  kennzeichen: string | null
  standard: boolean
  archiviert: boolean
  /** Server-Sync-Felder (PLAN §9b): für Last-Writer-Wins beim Pull */
  geaendertAm: Iso | null
  erstelltAm: Iso
}

export interface Buchung {
  id: string
  artikelId: string
  standortId: string
  standortZielId: string | null // nur bei umlagerung
  typ: BuchungsTyp
  /** Signed Menge. inventur = soll - bestand. */
  menge: number
  /** identische paarId auf entnahme + einlagerung bei umlagerung */
  paarId: string | null
  projekt: string | null
  /** Buchungsdatum (zeitliche Reihenfolge der Bewegung) */
  erstelltAm: Iso
  /** Erfassungszeitpunkt in der UI */
  clientEingabeAm: Iso
  erstelltVon: string
  kommentar: string | null
  mitteilungAn: string | null
  /** gesetzt auf storno-Buchungen: referenziert die stornierte Original-Buchung */
  stornoVon: string | null
  /** Schnellfilter: ist die Original-Buchung storniert? */
  storno: boolean
  /** Back-Ref: welche Storno-Buchung hat das Original storniert? */
  storniertDurch: string | null
  /** Vom Server vergebene kanonische ID (nach erfolgreichem Push gesetzt).
   *  Im Normalfall identisch mit `id` — nur abweichend, wenn Server-Replikation
   *  eine andere ID vergibt (zukünftiges Feature). */
  serverId: string | null
  /**
   * Local-only marker for a booking that exists in IndexedDB but not on the
   * server (reconcile found it missing). Such a booking is never deleted.
   */
  nichtGespeichert?: boolean
  skipReason?: string | null
  skipBemerkung?: string | null
  serverVerworfenAt?: string | null
}

export interface Projekt {
  id: string
  nummer: string
  name: string | null
  archiviert: boolean
  geaendertAm: Iso | null
  erstelltAm: Iso
}

export interface Einstellung {
  key: string
  /**
   * null = global (z. B. artikelTypen, vom Admin gepflegt).
   * Sonst: User-spezifisch (z. B. sprache, standardStandortId).
   * Identität in IndexedDB: Compound [key+userId].
   */
  userId: string | null
  value: string
  /** LWW-Conflict-Resolution auf dem Server. */
  geaendertAm: Iso
}

export interface AuditLogEintrag {
  id: string
  aktion: string
  entitaet: 'artikel' | 'standort' | 'buchung' | 'kommission' | 'einstellung'
  entitaetId: string
  daten: string // JSON-serialisiert
  zeit: Iso
}

/**
 * Mindestbestand-Ereignis (Server-seitig ausgelöst, vom PWA-Snapshot
 * gezogen). Wird im Glocken-Panel und im Admin-View angezeigt.
 *
 * Server-only Felder (`zustellung_admin_ids`, `konsumiert_von_mail`)
 * werden beim Snapshot-Endpoint NICHT mit ausgeliefert.
 */
export interface MindestbestandEreignis {
  id: string
  artikelId: string
  standortId: string
  ausloeserBuchungId: string
  bestandDanach: number
  mindestbestand: number
  defizit: number
  erstelltAm: Iso
}

/** Rolle des eingeloggten Users (Spiegel des Server-Users). */
export type UserRolle = 'admin' | 'user'

/** Eingabe-Parameter für createEinlagerung / createEntnahme */
export interface BuchungsEingabe {
  artikelId: string
  standortId: string
  menge: number
  projekt?: string | null
  erstelltVon: string
  kommentar?: string | null
  mitteilungAn?: string | null
  erstelltAm?: Iso
  clientEingabeAm?: Iso
}

// ---------- Sync (PLAN §4.7–4.9) ----------

export type OutboxEntity =
  'artikel' | 'buchung' | 'standort' | 'kommission' | 'foto' | 'einstellung'
export type OutboxOp = 'create' | 'update' | 'delete' | 'upload' | 'upsert'

export interface OutboxEintrag {
  id: string
  entity: OutboxEntity
  op: OutboxOp
  /** JSON-serialisiertes Payload, exakt wie es zum Server geht. */
  payload: string
  createdAt: Iso
  /** null → noch nicht gepusht; ISO → erfolgreich synchronisiert. */
  syncedAt: Iso | null
  attempts: number
  lastError: string | null
  quarantinedAt: Iso | null
  quarantineReason: string | null
}
