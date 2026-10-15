// User-Verwaltungs-Operationen gegen das Backend.
//
// Local-only-Funktionen (authentifiziere, legeUserAn, resetPasswort etc.)
// aus dem alten Modul wurden ersatzlos entfernt — die ganze User-Verwaltung
// läuft jetzt server-side.

import { apiFetch } from './api.js'

export interface UserDto {
  id: string
  email: string
  anzeigename?: string
  rolle: 'admin' | 'user'
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
    mustChangePassword: boolean
  }
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
  rolle: 'admin' | 'user'
}): Promise<UserDto> {
  return apiFetch<UserDto>('/api/users', {
    method: 'POST',
    body: input,
  })
}

export async function aendereRolleServer(id: string, rolle: 'admin' | 'user'): Promise<void> {
  await apiFetch(`/api/users/${id}`, {
    method: 'PATCH',
    body: { rolle },
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

export async function deaktiviereUserServer(id: string): Promise<void> {
  await apiFetch(`/api/users/${id}`, {
    method: 'DELETE',
  })
}
