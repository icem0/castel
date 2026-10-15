// Session-Storage für den Auth-Store.
// JWT kommt vom Server und ist in localStorage abgelegt (12 h Lebensdauer).
//
// Wir cachen außerdem die letzten erfolgreichen Login-Credentials (Email +
// PBKDF2-Hash + Salt), damit ein Offline-Login nach Token-Ablauf möglich ist.
// Der PBKDF2-Hash ist nicht trivial rückrechenbar, aber ein Angreifer mit
// Zugriff auf die localStorage kann Brute-Force probieren — das ist die
// bekannte Schwäche von Offline-Auth. Mitigation: kurze PW-Zyklen, Geräte-PIN.

import { verifiziereText } from './crypto.js'

const LS_JWT = 'castel.auth.jwt'
const LS_SESSION = 'castel.auth.session'
const LS_CRED_PREFIX = 'castel.auth.cred.'

export interface SessionInfo {
  userId: string
  email: string
  rolle: 'admin' | 'user'
  /** Anzeigename des Users; wird in Buchungen als `erstelltVon` geschrieben. */
  anzeigename?: string
  loginAm: string // ISO
  mustChangePassword: boolean
  /** Ablauf des JWT (ISO). */
  jwtExpiresAt: string
}

export interface CachedCredential {
  email: string
  passwordHash: string
  salt: string
  iterations: number
  cachedAt: string // ISO
}

export function sessionLesen(): SessionInfo | null {
  const raw = localStorage.getItem(LS_SESSION)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionInfo
  } catch {
    return null
  }
}

export function sessionSchreiben(s: SessionInfo | null): void {
  if (s === null) {
    localStorage.removeItem(LS_SESSION)
    return
  }
  localStorage.setItem(LS_SESSION, JSON.stringify(s))
}

export function jwtLesen(): string | null {
  return localStorage.getItem(LS_JWT)
}

export function jwtSchreiben(token: string | null): void {
  if (token === null) {
    localStorage.removeItem(LS_JWT)
    return
  }
  localStorage.setItem(LS_JWT, token)
}

/** Schlüssel pro normalisierter E-Mail. */
function credKey(email: string): string {
  return LS_CRED_PREFIX + email.toLowerCase().trim()
}

/** Liest gecachte Credentials für Offline-Login. */
export function credLesen(email: string): CachedCredential | null {
  const raw = localStorage.getItem(credKey(email))
  if (!raw) return null
  try {
    return JSON.parse(raw) as CachedCredential
  } catch {
    return null
  }
}

/** Schreibt/aktualisiert gecachte Credentials. */
export function credSchreiben(c: CachedCredential): void {
  localStorage.setItem(credKey(c.email), JSON.stringify(c))
}

/** Löscht gecachte Credentials (z. B. nach Passwort-Änderung). */
export function credLoeschen(email: string): void {
  localStorage.removeItem(credKey(email))
}

/**
 * Versucht einen Offline-Login mit gecachten Credentials.
 * Gibt zurück, ob die Credentials passen (gleicher PBKDF2-Hash).
 */
export async function offlineLoginMoeglich(email: string, password: string): Promise<boolean> {
  const cached = credLesen(email)
  if (!cached) return false
  return verifiziereText(password, cached.passwordHash, cached.salt, cached.iterations)
}

export function allesLoeschen(): void {
  sessionSchreiben(null)
  jwtSchreiben(null)
  // Credentials werden bewusst nicht gelöscht — die überleben einen Logout.
}
