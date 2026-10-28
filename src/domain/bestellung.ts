// Bestell-Helfer fuer den Mindestbestandsalarm: "Jetzt bestellen"-Ziel und
// die Zuordnung des Bestellstatus zum jeweiligen Alarm.

import type { Artikel } from '../db/types'

export interface BestellZiel {
  href: string
  /** `true` bei einer mailto:-URL (kein neues Tab), sonst Web-Link. */
  mailto: boolean
}

/** Contact data of a manufacturer: order mail and/or order website. */
export interface BestellKontakt {
  bestellEmail: string | null
  bestellWebseite: string | null
}

/**
 * Builds the order mail link (mailto) of a manufacturer.
 *
 * Returns `null` when no order mail is stored. The subject and the body are
 * encoded, so the mail client shows the prefilled order.
 */
export function bestellMailZiel(
  kontakt: BestellKontakt,
  mail: { betreff: string; text: string },
): BestellZiel | null {
  const email = kontakt.bestellEmail?.trim()
  if (!email) return null
  const query = `subject=${encodeURIComponent(mail.betreff)}&body=${encodeURIComponent(mail.text)}`
  return { href: `mailto:${email}?${query}`, mailto: true }
}

/**
 * Builds the order website link of a manufacturer.
 *
 * Returns `null` when no website is stored. A website without a scheme is
 * treated as `https://…`.
 */
export function bestellWebZiel(kontakt: BestellKontakt): BestellZiel | null {
  const web = kontakt.bestellWebseite?.trim()
  if (!web) return null
  return { href: /^https?:\/\//i.test(web) ? web : `https://${web}`, mailto: false }
}

/**
 * Baut das Bestellziel aus dem Hersteller-Kontakt.
 *
 * E-Mail hat Vorrang vor der Webseite. Fehlt beides (oder der Hersteller),
 * gibt es kein Ziel und die UI blendet den "Jetzt bestellen"-Button aus.
 * Eine Webseite ohne Schema wird als `https://…` behandelt.
 */
export function bestellZiel(
  h: BestellKontakt | null | undefined,
  mail: { betreff: string; text: string },
): BestellZiel | null {
  if (!h) return null
  return bestellMailZiel(h, mail) ?? bestellWebZiel(h)
}

/**
 * Gilt der "bestellt"-Marker fuer dieses Alarm-Ereignis?
 *
 * Der Status liegt am Artikel (nicht am Ereignis), deshalb zaehlt er nur,
 * wenn er NACH dem Alarm gesetzt wurde. Eine Bestellung von vor dem Alarm
 * ist fuer den neuen Alarm wieder offen.
 */
export function istBestelltFuerEreignis(
  a: Pick<Artikel, 'bestellstatus' | 'bestelltAm'> | null | undefined,
  ereignisErstelltAm: string,
): boolean {
  if (!a || a.bestellstatus !== 'bestellt' || !a.bestelltAm) return false
  return a.bestelltAm >= ereignisErstelltAm
}
