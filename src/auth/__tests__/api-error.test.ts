// Tests for the error messages of the shared API client.
//
// Regression: over HTTP/2 the browser exposes no reason phrase, so
// `res.statusText` is an empty string. The old code used `??`, which does
// not fall through on '', so the error message ended up EMPTY. Every UI
// that renders it behind a `v-if` on the message then showed nothing at
// all — a rejected DATANORM upload (nginx 413) looked like a no-op.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, ApiError } from '../api'

interface FakeResponseInit {
  status: number
  statusText: string
  contentType?: string
  body?: string
}

function fakeResponse(init: FakeResponseInit): Response {
  const body = init.body ?? ''
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    statusText: init.statusText,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? (init.contentType ?? null) : null,
    },
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiFetch — Fehlermeldungen', () => {
  it('liefert eine nicht-leere Meldung, wenn statusText leer ist (HTTP/2)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ status: 413, statusText: '', contentType: 'text/html', body: '<html>' }),
      ),
    )

    const fehler = await apiFetch('/api/datanorm/upload').catch((e: unknown) => e)

    expect(fehler).toBeInstanceOf(ApiError)
    const e = fehler as ApiError
    expect(e.status).toBe(413)
    expect(e.message.trim()).not.toBe('')
    expect(e.message).toContain('413')
  })

  it('haengt die Server-Meldung an den Statuscode an', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          status: 422,
          statusText: 'Unprocessable Entity',
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'DATANORM_KEINE_ARTIKEL',
            message: 'Keine A-Sätze gefunden',
          }),
        }),
      ),
    )

    const fehler = await apiFetch('/api/datanorm/upload').catch((e: unknown) => e)

    const e = fehler as ApiError
    expect(e.code).toBe('DATANORM_KEINE_ARTIKEL')
    expect(e.message).toContain('422')
    expect(e.message).toContain('Keine A-Sätze gefunden')
  })

  it('nutzt statusText, wenn der Server kein JSON liefert', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          status: 502,
          statusText: 'Bad Gateway',
          contentType: 'text/html',
          body: '<html>nginx</html>',
        }),
      ),
    )

    const fehler = await apiFetch('/api/ding').catch((e: unknown) => e)

    const e = fehler as ApiError
    expect(e.message).toContain('502')
    expect(e.message).toContain('Bad Gateway')
  })
})
