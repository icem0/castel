// Tests for the PWA runtime flags (read from /config.js).
//
// The ALLOW_INSECURE_HTTP flag is written into config.js at container start
// (scripts/pwa-entrypoint.sh) and read at runtime.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { insecureHttpErlaubt, istSecureContext } from '../runtime-config'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('insecureHttpErlaubt', () => {
  it('ist standardmäßig false (kein Flag gesetzt)', () => {
    expect(insecureHttpErlaubt()).toBe(false)
  })

  it('akzeptiert den String "true" aus config.js', () => {
    vi.stubGlobal('__CASTEL_ALLOW_INSECURE_HTTP__', 'true')
    expect(insecureHttpErlaubt()).toBe(true)
  })

  it('ignoriert "false", Leerstring und andere Werte', () => {
    vi.stubGlobal('__CASTEL_ALLOW_INSECURE_HTTP__', 'false')
    expect(insecureHttpErlaubt()).toBe(false)
    vi.stubGlobal('__CASTEL_ALLOW_INSECURE_HTTP__', '')
    expect(insecureHttpErlaubt()).toBe(false)
    vi.stubGlobal('__CASTEL_ALLOW_INSECURE_HTTP__', '1')
    expect(insecureHttpErlaubt()).toBe(false)
  })

  it('akzeptiert den Boolean-Wert true', () => {
    vi.stubGlobal('__CASTEL_ALLOW_INSECURE_HTTP__', true)
    expect(insecureHttpErlaubt()).toBe(true)
  })
})

describe('istSecureContext', () => {
  it('folgt window.isSecureContext', () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    expect(istSecureContext()).toBe(true)
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    expect(istSecureContext()).toBe(false)
  })
})
