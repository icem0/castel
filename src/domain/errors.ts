// Fehlerhierarchie für Domänen-Operationen.
// Erben alle von BuchungsError, damit Aufrufer mit `catch (e) { if (e instanceof BuchungsError) ... }` arbeiten können.

export class BuchungsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class UngueltigeMengeError extends BuchungsError {
  constructor(menge: number) {
    super(`Menge muss > 0 sein, ist ${menge}`, 'UNGÜELTIGE_MENGE')
  }
}

export class BereitsStorniertError extends BuchungsError {
  constructor(public readonly buchungId: string) {
    super(`Buchung ${buchungId} ist bereits storniert`, 'BEREITS_STORNIERT')
  }
}

export class GleicherStandortError extends BuchungsError {
  constructor() {
    super('Quell- und Zielstandort sind identisch', 'GLEICHER_STANDORT')
  }
}

export class PflichtfeldFehltError extends BuchungsError {
  constructor(feld: string) {
    super(`Pflichtfeld fehlt: ${feld}`, 'PFLICHTFELD_FEHLT')
  }
}

export class NegativerBestandWarnung extends BuchungsError {
  constructor(
    public readonly artikelId: string,
    public readonly standortId: string,
    public readonly bestand: number,
    public readonly benoetigt: number,
  ) {
    super(
      `Bestand ${bestand} an Standort ${standortId} ist kleiner als benötigte Menge ${benoetigt}`,
      'NEGATIVER_BESTAND',
    )
  }
}

export class ZukunftsDatumError extends BuchungsError {
  constructor(
    public readonly feld: string,
    public readonly datum: string,
  ) {
    super(`Datum ${datum} im Feld ${feld} liegt in der Zukunft`, 'ZUKUNFTS_DATUM')
  }
}

export class UnbekannteReferenzError extends BuchungsError {
  constructor(
    public readonly entity: 'artikel' | 'standort',
    public readonly id: string,
  ) {
    super(`Unbekannte ${entity}-ID: ${id}`, 'UNBEKANNTE_REFERENZ')
  }
}

export class MindestbestandWarnung extends BuchungsError {
  constructor(
    public readonly artikelId: string,
    public readonly standortId: string,
    public readonly bestand: number,
    public readonly mindestbestand: number,
  ) {
    super(
      `Bestand ${bestand} an Standort ${standortId} unterschreitet Mindestbestand ${mindestbestand}`,
      'MINDESTBESTAND',
    )
  }
}
