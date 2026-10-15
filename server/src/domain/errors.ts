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