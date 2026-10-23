// Client fuer die API-Key-Verwaltung (JWT-only, siehe server/src/auth/api-key-routes.ts).

import { apiFetch } from './api'

export type ApiKeyScope = 'read' | 'write' | 'admin'

export interface ApiKeyInfo {
  id: string
  name: string
  prefix: string
  scopes: ApiKeyScope[]
  erstelltAm: string
  letzteNutzungAm: string | null
  ablaufAm: string | null
  revokedAt: string | null
}

export interface AdminApiKeyInfo extends ApiKeyInfo {
  userId: string
  userEmail: string
  userAnzeigename: string
}

export interface CreatedApiKey extends ApiKeyInfo {
  key: string
}

export interface CreateApiKeyInput {
  name: string
  scopes: ApiKeyScope[]
  ablaufAm?: string | null
}

export async function listeEigeneApiKeys(): Promise<ApiKeyInfo[]> {
  const res = await apiFetch<{ keys: ApiKeyInfo[] }>('/api/keys')
  return res.keys
}

export async function erstelleApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  return apiFetch<CreatedApiKey>('/api/keys', { method: 'POST', body: input })
}

export async function widerrufeApiKey(id: string): Promise<void> {
  await apiFetch<void>(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function listeAlleApiKeys(): Promise<AdminApiKeyInfo[]> {
  const res = await apiFetch<{ keys: AdminApiKeyInfo[] }>('/api/admin/keys')
  return res.keys
}

export async function widerrufeApiKeyAlsAdmin(id: string): Promise<void> {
  await apiFetch<void>(`/api/admin/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
