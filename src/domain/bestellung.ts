// Bestell-Helfer fuer den Mindestbestandsalarm: "Jetzt bestellen"-Ziel und
// die Zuordnung des Bestellstatus zum jeweiligen Alarm.

import type { Artikel, Hersteller } from '../db/types'

export interface BestellZiel {
  href: string
  /** `true` bei einer mailto:-URL (kein neues Tab), sonst Web-Link. */
  mailto: boolean
}

/**
 * Baut das Bestellziel aus dem Hersteller-Kontakt.
 *
 * E-Mail hat Vorrang vor der Webseite. Fehlt beides (oder der Hersteller),
 * gibt es kein Ziel und die UI blendet den "Jetzt bestellen"-Button aus.
 * Eine Webseite ohne Schema wird als `https://…` behandelt.
 */
export function bestellZiel(
  h: Pick<Hersteller, 'bestellEmail' | 'bestellWebseite'> | null | undefined,
  mail: { betreff: string; text: string },
): BestellZiel | null {
  if (!h) return null
  const email = h.bestellEmail?.trim()
  if (email) {
    const query = `subject=${encodeURIComponent(mail.betreff)}&body=${encodeURIComponent(mail.text)}`
    return { href: `mailto:${email}?${query}`, mailto: true }
  }
  const web = h.bestellWebseite?.trim()
  if (web) {
    const href = /^https?:\/\//i.test(web) ? web : `https://${web}`
    return { href, mailto: false }
  }
  return null
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
