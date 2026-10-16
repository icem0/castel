// Policy / Konstanten für Auth.
//
// Sicherheitsfragen aus dem alten Modul wurden entfernt. Passwort-Reset
// läuft jetzt serverseitig (Admin setzt neues Passwort).

/** Mindestlänge für Passwörter (muss mit Server-Schema übereinstimmen). */
export const MIN_PASSWORT_LAENGE = 8

/** JWT-Lebensdauer (in Sekunden) — muss zur Server-Konfig passen. */
export const JWT_LIFETIME_SECONDS = 12 * 60 * 60

const KLEINBUCHSTABEN = 'abcdefghijklmnopqrstuvwxyz'
const GROSSBUCHSTABEN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ZIFFERN = '0123456789'
const SONDERZEICHEN = '!@#$%^&*()-_=+[]{}|;:,.<>?/~`'

const ALLE_ZEICHEN = KLEINBUCHSTABEN + GROSSBUCHSTABEN + ZIFFERN + SONDERZEICHEN
const ZIFFERN_ODER_SONDER = ZIFFERN + SONDERZEICHEN

function zufallsIndex(obergrenzeExklusiv: number): number {
  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  return Math.floor((buffer[0]! / 0xffffffff) * obergrenzeExklusiv)
}

function zufallsZeichen(pool: string): string {
  return pool[zufallsIndex(pool.length)]!
}

/**
 * Generiert ein Einmalpasswort gemäß Passwortvorgaben:
 * mindestens MIN_PASSWORT_LAENGE Zeichen, davon mindestens eine Ziffer
 * oder ein Sonderzeichen.
 */
export function generiereEinmalpasswort(laenge = MIN_PASSWORT_LAENGE): string {
  if (laenge < MIN_PASSWORT_LAENGE) {
    laenge = MIN_PASSWORT_LAENGE
  }

  const zeichen: string[] = []
  // mindestens eine Ziffer oder ein Sonderzeichen garantieren
  zeichen.push(zufallsZeichen(ZIFFERN_ODER_SONDER))

  while (zeichen.length < laenge) {
    zeichen.push(zufallsZeichen(ALLE_ZEICHEN))
  }

  // Fisher-Yates mischen, damit das garantierte Zeichen nicht an Position 0 bleibt
  for (let i = zeichen.length - 1; i > 0; i--) {
    const j = zufallsIndex(i + 1)
    const tmp = zeichen[i]!
    zeichen[i] = zeichen[j]!
    zeichen[j] = tmp
  }

  return zeichen.join('')
}
