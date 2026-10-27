// Server-seitige Fehlerhierarchie.
// Spiegel: src/domain/__errors.ts (PWA), aber ohne UI-spezifische Fehler.

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

/** Negativer Bestand nach einer Entnahme. */
export class NegativerBestandError extends DomainError {
  constructor(
    public readonly artikelId: string,
    public readonly standortId: string,
    public readonly aktuellerBestand: number,
    public readonly angeforderteMenge: number,
  ) {
    super(
      'NEGATIVE_BESTAND',
      `Entnahme würde Bestand negativ machen: aktuell ${aktuellerBestand}, angefordert ${angeforderteMenge}`,
    )
  }
}

/** Pflichtfeld fehlt oder ungültig. */
export class ValidationError extends DomainError {
  constructor(
    public readonly feld: string,
    public readonly grund: string,
  ) {
    super('VALIDATION', `${feld}: ${grund}`)
  }
}

/** Buchung verweist auf unbekannte Artikel-/Standort-ID. */
export class UnbekannteReferenzError extends DomainError {
  constructor(
    public readonly entity: 'artikel' | 'standort',
    public readonly id: string,
  ) {
    super(
      'UNKNOWN_REFERENCE',
      `Unbekannte ${entity === 'artikel' ? 'Artikel' : 'Standort'}-ID: ${id}`,
    )
  }
}

/** Umlagerung: Quell- und Ziel-Standort identisch. */
export class GleicherStandortError extends DomainError {
  constructor() {
    super('GLEICHER_STANDORT', 'Quell- und Ziel-Standort sind identisch')
  }
}

/** Storno einer bereits stornierten Buchung. */
export class BereitsStorniertError extends DomainError {
  constructor(public readonly buchungId: string) {
    super('BEREITS_STORNIED', `Buchung ${buchungId} ist bereits storniert`)
  }
}

/** Inventur darf nicht durchgeführt werden (z. B. Rolle fehlt). */
export class InventurNichtErlaubtError extends DomainError {
  constructor(public readonly grund: string) {
    super('INVENTUR_FORBIDDEN', grund)
  }
}

/** Generischer "nicht gefunden". */
export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} ${id} nicht gefunden`)
  }
}

/** Das Hauptlager (Standard-Standort) ist geschützt: es darf weder
 *  gelöscht noch archiviert werden. */
export class ProtectedStandortError extends DomainError {
  constructor(public readonly id: string) {
    super(
      'PROTECTED_STANDORT',
      `Standort ${id} ist das Hauptlager und kann nicht gelöscht oder archiviert werden`,
    )
  }
}

/** Löschen nicht möglich, weil andere Zeilen noch referenzieren.
 *  Wird vom Resolver geworfen, wenn z. B. ein Artikel noch Buchungen
 *  hat und deshalb nicht entfernt werden darf. Spiegel der
 *  `HARD_QUARANTINE_CODES` im PWA-Worker — der Client legt das Item
 *  sofort still und zeigt dem User den Grund. */
export class HatAbhaengigkeitenError extends DomainError {
  constructor(
    public readonly resource: string,
    public readonly id: string,
    public readonly abhaengigkeiten: Array<{ entity: string; anzahl: number }>,
  ) {
    const detail = abhaengigkeiten
      .map((a) => `${a.anzahl} ${a.entity}`)
      .join(', ')
    super(
      'HAS_DEPENDENCIES',
      `${resource} ${id} kann nicht gelöscht werden, da noch referenziert: ${detail}`,
    )
  }
}