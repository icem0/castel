// Policy / Konstanten für Auth.
//
// Sicherheitsfragen aus dem alten Modul wurden entfernt. Passwort-Reset
// läuft jetzt serverseitig (Admin setzt neues Passwort).

/** Mindestlänge für Passwörter (muss mit Server-Schema übereinstimmen). */
export const MIN_PASSWORT_LAENGE = 8

/** JWT-Lebensdauer (in Sekunden) — muss zur Server-Konfig passen. */
export const JWT_LIFETIME_SECONDS = 12 * 60 * 60
