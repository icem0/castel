// Rollen und Berechtigungen im Client.
//
// Der Server ist die einzige Quelle der Wahrheit für die *Daten* (die
// Matrix mit Beschreibungen kommt von GET /api/rollen und wird in
// `src/stores/rollen.ts` gecacht). Die TypeScript-Typen und Hilfsfunktionen
// leben hier im Client, damit der PWA-Build unabhängig vom Server-Paket
// funktioniert.
//
// Die Berechtigungs-IDs müssen mit `server/src/domain/rollen.ts` identisch
// sein — das sichert der Drift-Test
// `src/domain/__tests__/rollen-drift.test.ts` (liest die Server-Datei als
// Text und vergleicht die ID-Listen).

export const ROLLEN = ['user', 'lagerist', 'admin'] as const
export type Rolle = (typeof ROLLEN)[number]

export const PERMISSIONS = [
  // ---------- Lesen ----------
  'artikel.lesen',
  'standort.lesen',
  'mindestbestand.lesen',
  'katalog.lesen',
  // ---------- Schreiben (Lager) ----------
  'artikel.schreiben',
  'artikel.loeschen',
  'standort.schreiben',
  'standort.loeschen',
  'mindestbestand.schreiben',
  'buchung.erstellen',
  'buchung.storno',
  'kommission.beitragen',
  'etikett.drucken',
  'geraet.lokal',
  // ---------- Administration ----------
  'einkaufspreis',
  'stammdaten.verwalten',
  'akkutausch.verwalten',
  'globalEinstellung',
  'benutzer.verwalten',
  'backup.verwalten',
  'import.fuehren',
  'apiKey.verwalten',
  'entwicklung',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const USER_BEREECHTIGUNGEN: readonly Permission[] = [
  'artikel.lesen',
  'standort.lesen',
  'mindestbestand.lesen',
  'katalog.lesen',
  'buchung.erstellen',
  'buchung.storno',
  'kommission.beitragen',
  'etikett.drucken',
  'geraet.lokal',
]

const LAGERIST_BEREECHTIGUNGEN: readonly Permission[] = [
  'artikel.schreiben',
  'artikel.loeschen',
  'standort.schreiben',
  'mindestbestand.schreiben',
]

const ADMIN_BEREECHTIGUNGEN: readonly Permission[] = PERMISSIONS

export const ROLLEN_BEREECHTIGUNGEN: Record<Rolle, readonly Permission[]> = {
  user: USER_BEREECHTIGUNGEN,
  lagerist: LAGERIST_BEREECHTIGUNGEN,
  admin: ADMIN_BEREECHTIGUNGEN,
}

export interface RollenInfo {
  titel: string
  beschreibung: string
  rechte: readonly string[]
}

export const ROLLEN_INFO: Record<Rolle, RollenInfo> = {
  user: {
    titel: 'User',
    beschreibung:
      'Basiszugriff: Artikel und Standorte lesen, Bestaende buchen, eigene Buchungen stornieren, Kommissionen beitragen.',
    rechte: [
      'Artikel, Standorte und Mindestbestand lesen',
      'Buchungen anlegen und stornieren',
      'Kommissionen beitragen',
      'Etiketten drucken',
    ],
  },
  lagerist: {
    titel: 'Lagerist',
    beschreibung:
      'Zusaetzlich zu User: Artikelstammdaten und Standorte pflegen, Mindestbestand je Artikel und Standort konfigurieren.',
    rechte: [
      'Artikel anlegen und bearbeiten (ohne Einkaufspreis)',
      'Artikel loeschen',
      'Standorte anlegen, umbenennen und archivieren',
      'Mindestbestand je Artikel und Standort setzen',
    ],
  },
  admin: {
    titel: 'Admin',
    beschreibung:
      'Voller Zugriff: alle Rechte der uebrigen Rollen plus Stammdaten, Preise, Akkutausch, Benutzerverwaltung, Backup und Import.',
    rechte: [
      'Alles, was User und Lagerist duerfen',
      'Einkaufspreise und Lieferantenrabatte sehen und pflegen',
      'Stammdaten, Akkutausch und globale Einstellungen verwalten',
      'Benutzer verwalten, Backup/Restore, CSV-Import, API-Keys',
    ],
  },
}

export interface BerechtigungInfo {
  titel: string
  beschreibung: string
}

export const BERECHTIGUNG_INFO: Record<Permission, BerechtigungInfo> = {
  'artikel.lesen': { titel: 'Artikel lesen', beschreibung: 'Artikelstammdaten ansehen.' },
  'artikel.schreiben': {
    titel: 'Artikel schreiben',
    beschreibung: 'Artikel anlegen und bearbeiten — ohne Einkaufspreis.',
  },
  'artikel.loeschen': {
    titel: 'Artikel loeschen',
    beschreibung: 'Artikel endgueltig loeschen (mit Buchungen nur per Storno moeglich).',
  },
  'standort.lesen': { titel: 'Standorte lesen', beschreibung: 'Lager und Standorte ansehen.' },
  'standort.schreiben': {
    titel: 'Standorte schreiben',
    beschreibung: 'Standorte anlegen, umbenennen und archivieren.',
  },
  'standort.loeschen': {
    titel: 'Standorte loeschen',
    beschreibung: 'Standorte endgueltig loeschen.',
  },
  'mindestbestand.lesen': {
    titel: 'Mindestbestand lesen',
    beschreibung: 'Mindestbestand-Panel und Alarm beobachten.',
  },
  'mindestbestand.schreiben': {
    titel: 'Mindestbestand schreiben',
    beschreibung: 'Mindestbestand je Artikel und Standort setzen.',
  },
  'buchung.erstellen': {
    titel: 'Buchen',
    beschreibung: 'Bestaende buchen (Ein-/Auslagerung, Umlagerung, Inventur).',
  },
  'buchung.storno': { titel: 'Stornieren', beschreibung: 'Buchungen stornieren.' },
  'kommission.beitragen': {
    titel: 'Kommissionen beitragen',
    beschreibung: 'Neue Kommissionen zur globalen Liste beitragen.',
  },
  'etikett.drucken': {
    titel: 'Etiketten drucken',
    beschreibung: 'Etiketten und Barcodes erzeugen.',
  },
  'katalog.lesen': {
    titel: 'Kataloge lesen',
    beschreibung: 'Artikel-Kataloge und Lieferantenlisten ansehen.',
  },
  'geraet.lokal': {
    titel: 'Lokaler Speicher',
    beschreibung: 'Einstellungen und den lokalen Gerätespeicher verwalten.',
  },
  einkaufspreis: {
    titel: 'Einkaufspreis',
    beschreibung: 'Vertrauliche Einkaufspreise und Lieferantenrabatte sehen und pflegen.',
  },
  'stammdaten.verwalten': {
    titel: 'Stammdaten verwalten',
    beschreibung: 'Hersteller, Artikel-/Akku-Typen und die Kommissionen-Liste pflegen.',
  },
  'akkutausch.verwalten': {
    titel: 'Akkutausch verwalten',
    beschreibung: 'Netzteile, Projektakkus, Puffer und Bestellungen des Akkutausches pflegen.',
  },
  globalEinstellung: {
    titel: 'Globale Einstellungen',
    beschreibung: 'Standard-Standort, Firmenname, Barcode-Format und Typenlisten pflegen.',
  },
  'benutzer.verwalten': {
    titel: 'Benutzer verwalten',
    beschreibung: 'Benutzer anlegen, Rollen und Passwoerter pflegen.',
  },
  'backup.verwalten': { titel: 'Backup', beschreibung: 'Backups erstellen und wiederherstellen.' },
  'import.fuehren': { titel: 'CSV-Import', beschreibung: 'CSV-Import ausfuehren.' },
  'apiKey.verwalten': {
    titel: 'API-Keys',
    beschreibung: 'API-Keys fuer die Agenten-API verwalten.',
  },
  entwicklung: {
    titel: 'Entwicklung',
    beschreibung: 'Entwicklermenue, Geraete-Reset und Buchungs-Bulk-Delete.',
  },
}

export function istRolle(value: unknown): value is Rolle {
  return typeof value === 'string' && (ROLLEN as readonly string[]).includes(value)
}

export function istBerechtigung(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

export function normalisiereRollen(input: unknown): Rolle[] {
  const rohen: string[] = Array.isArray(input)
    ? input.filter((r): r is string => typeof r === 'string')
    : typeof input === 'string'
      ? [input]
      : []

  const bekannt = rohen.filter(istRolle)
  if (bekannt.includes('admin')) return ['admin']

  const set = new Set<Rolle>(bekannt)
  set.add('user')
  return ROLLEN.filter((r) => set.has(r))
}

export function istAdmin(rollen: readonly Rolle[] | undefined | null): boolean {
  return !!rollen && rollen.includes('admin')
}

export function berechtigungenFuer(rollen: readonly Rolle[] | undefined | null): Permission[] {
  if (!rollen || rollen.length === 0) return []
  if (istAdmin(rollen)) return [...PERMISSIONS]
  const set = new Set<Permission>()
  for (const rolle of rollen) {
    for (const p of ROLLEN_BEREECHTIGUNGEN[rolle] ?? []) set.add(p)
  }
  return PERMISSIONS.filter((p) => set.has(p))
}

export function hatBerechtigung(
  rollen: readonly Rolle[] | undefined | null,
  berechtigung: Permission,
): boolean {
  if (istAdmin(rollen)) return true
  if (!rollen) return false
  return rollen.some((rolle) => ROLLEN_BEREECHTIGUNGEN[rolle]?.includes(berechtigung) ?? false)
}

export function legacyRolle(rollen: readonly Rolle[]): 'admin' | 'user' {
  return istAdmin(rollen) ? 'admin' : 'user'
}
