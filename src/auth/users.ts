// User-Verwaltungs-Operationen gegen das Backend.
//
// Local-only-Funktionen (authentifiziere, legeUserAn, resetPasswort etc.)
// aus dem alten Modul wurden ersatzlos entfernt — die ganze User-Verwaltung
// läuft jetzt server-side.

import { apiFetch } from './api.js'
import type { Permission, Rolle } from '../domain/rollen'

export interface UserDto {
  id: string
  email: string
  anzeigename?: string
  /** Legacy-Einzelrolle — bleibt fuer Alt-Builds erhalten. */
  rolle: 'admin' | 'user'
  /** Rollen-Stack des Users. */
  rollen: Rolle[]
  aktiv: boolean
  erstelltAm: string
  letzterLoginAm: string | null
}

export interface LoginAntwort {
  token: string
  user: {
    id: string
    email: string
    anzeigename?: string
    rolle: 'admin' | 'user'
    rollen: Rolle[]
    berechtigungen: Permission[]
    mustChangePassword: boolean
  }
}

/** Rolle eines Benutzers aus der Rollen-Matrix des Servers. */
export interface RolleDto {
  id: Rolle
  titel: string
  beschreibung: string
  rechte: string[]
  berechtigungen: Permission[]
}

export interface BerechtigungDto {
  id: Permission
  titel: string
  beschreibung: string
}

/** Antwort von GET /api/rollen — Matrix + Beschreibungen fuer die Legende. */
export interface RollenMatrixDto {
  version: number
  rollen: RolleDto[]
  berechtigungen: BerechtigungDto[]
}

export interface SetupStatus {
  setupRequired: boolean
  userCount: number
}

export interface SetupEingabe {
  anzeigename: string
  email: string
  passwort: string
}

export async function holeSetupStatus(): Promise<SetupStatus> {
  return apiFetch<SetupStatus>('/api/auth/setup-status')
}

export async function fuehreSetupDurch(eingabe: SetupEingabe): Promise<UserDto> {
  return apiFetch<UserDto>('/api/auth/setup', {
    method: 'POST',
    body: eingabe,
  })
}

export async function holeAktiveUserliste(): Promise<UserDto[]> {
  return apiFetch<UserDto[]>('/api/users')
}

export async function legeUserAnServer(input: {
  email: string
  password: string
  rollen: Rolle[]
  anzeigename?: string
}): Promise<UserDto> {
  return apiFetch<UserDto>('/api/users', {
    method: 'POST',
    body: input,
  })
}

export async function aendereAnzeigenameServer(id: string, anzeigename: string): Promise<void> {
  await apiFetch(`/api/users/${id}`, {
    method: 'PATCH',
    body: { anzeigename },
  })
}

export async function aendereRollenServer(id: string, rollen: Rolle[]): Promise<void> {
  await apiFetch(`/api/users/${id}`, {
    method: 'PATCH',
    body: { rollen },
  })
}

export async function setzeAktivServer(id: string, aktiv: boolean): Promise<void> {
  await apiFetch(`/api/users/${id}`, {
    method: 'PATCH',
    body: { aktiv },
  })
}

export async function setzePasswortServer(id: string, password: string): Promise<void> {
  await apiFetch(`/api/users/${id}`, {
    method: 'PATCH',
    body: { password },
  })
}

export async function aendereEigenesPasswortServer(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  await apiFetch('/api/auth/change-password', {
    method: 'POST',
    body: { oldPassword, newPassword },
  })
}

export async function loescheUserServer(id: string): Promise<void> {
  await apiFetch(`/api/users/${id}`, {
    method: 'DELETE',
  })
}

/** Lädt die Rollen-Matrix (inkl. Beschreibungen) vom Server. */
export async function holeRollenMatrix(): Promise<RollenMatrixDto> {
  return apiFetch<RollenMatrixDto>('/api/rollen')
}

/** Aktuelle User-Daten vom Server (Rollen, Anzeigename, …). */
export async function holeEigenesUser(): Promise<LoginAntwort['user']> {
  return apiFetch<LoginAntwort['user']>('/api/auth/me')
}
