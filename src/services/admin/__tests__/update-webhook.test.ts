// Tests fuer den Update-Start aus der PWA.
//
// Der Button schreibt die Anforderung direkt in die DB (POST
// /api/admin/update/request) — kein Webhook, kein Token im Browser. Aeltere
// Server kennen die Route nicht und fallen auf /api/update/start zurueck.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { startUpdate } from '../update-webhook'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
  } as unknown as Response
}

describe('startUpdate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('schreibt die Anforderung direkt in die DB (kein Webhook)', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return jsonResponse(200, { requested: true, started: true })
      }),
    )
    const ergebnis = await startUpdate()
    expect(ergebnis.requested).toBe(true)
    expect(calls.some((u) => u.includes('/api/admin/update/request'))).toBe(true)
    expect(calls.some((u) => u.includes('/api/update/start'))).toBe(false)
  })

  it('faellt auf /api/update/start zurueck, wenn der Server die Route nicht kennt', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input))
        if (String(input).includes('/api/admin/update/request')) {
          return jsonResponse(404, { code: 'NOT_FOUND' })
        }
        return jsonResponse(200, { started: true, webhookStatus: 200 })
      }),
    )
    const ergebnis = await startUpdate()
    expect(ergebnis.started).toBe(true)
    expect(calls.some((u) => u.includes('/api/update/start'))).toBe(true)
  })

  it('reicht Fehler weiter (kein Fallback bei 500)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, { code: 'BOOM', message: 'kaputt' })),
    )
    await expect(startUpdate()).rejects.toThrow()
  })
})
