import { describe, expect, it, vi } from 'vitest'
import { checkLatestVersion, compareSemver, parseSemver } from '../update-check.js'

describe('parseSemver', () => {
  it('parst Tags mit und ohne v-Praefix', () => {
    expect(parseSemver('v1.2.3')).toEqual([1, 2, 3])
    expect(parseSemver('10.0.42')).toEqual([10, 0, 42])
    expect(parseSemver(' v2.3.4 ')).toEqual([2, 3, 4])
  })

  it('ignoriert Nicht-Semver-Tags', () => {
    expect(parseSemver('latest')).toBeNull()
    expect(parseSemver('pre-release')).toBeNull()
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('1.2.3-rc.1')).toBeNull()
    expect(parseSemver('abc1234')).toBeNull()
  })
})

describe('compareSemver', () => {
  it('vergleicht numerisch, nicht lexikalisch', () => {
    expect(compareSemver([1, 2, 3], [1, 2, 3])).toBe(0)
    expect(compareSemver([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0)
    expect(compareSemver([1, 0, 0], [2, 0, 0])).toBeLessThan(0)
  })
})

function ghcrFetch(tags: string[]): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/token')) {
      return new Response(JSON.stringify({ token: 'test-token' }), { status: 200 })
    }
    if (url.includes('/tags/list')) {
      return new Response(JSON.stringify({ tags }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

describe('checkLatestVersion pagination', () => {
  it('findet Versions-Tags hinter der ersten Seite', async () => {
    const shaTags = Array.from({ length: 100 }, (_, i) => `sha-${i.toString().padStart(4, '0')}`)
    const next = 'https://ghcr.io/v2/icem0/castel-api/tags/list?n=1000&last=sha-0099'
    const mock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ token: 't' }), { status: 200 })
      }
      if (url.includes('last=')) {
        return new Response(JSON.stringify({ tags: ['v1.0.7', 'v1.0.8'] }), { status: 200 })
      }
      return new Response(JSON.stringify({ tags: shaTags }), {
        status: 200,
        headers: { link: `<${next}>; rel="next"` },
      })
    })
    const fetchImpl = mock as unknown as typeof fetch

    const result = await checkLatestVersion({
      current: '1.0.6',
      canSelfUpdate: true,
      fetchImpl,
    })
    expect(result.latest).toBe('v1.0.8')
    expect(result.updateAvailable).toBe(true)

    const firstTagsCall = mock.mock.calls.find((c) => String(c[0]).includes('/tags/list'))
    expect(String(firstTagsCall?.[0])).toContain('n=1000')
  })

  it('meldet einen Fehler, wenn gar keine Versions-Tags existieren', async () => {
    const result = await checkLatestVersion({
      current: '1.0.6',
      canSelfUpdate: true,
      fetchImpl: ghcrFetch(['latest', 'sha-abc']),
    })
    expect(result.latest).toBeNull()
    expect(result.updateAvailable).toBeNull()
    expect(result.error).toContain('keine Versions-Tags')
  })
})

describe('checkLatestVersion', () => {
  it('erkennt eine neuere Version', async () => {
    const result = await checkLatestVersion({
      current: '1.0.5',
      canSelfUpdate: true,
      fetchImpl: ghcrFetch(['latest', 'sha-abc', 'v1.0.5', 'v1.0.7', 'v1.0.6']),
    })
    expect(result.current).toBe('1.0.5')
    expect(result.latest).toBe('v1.0.7')
    expect(result.updateAvailable).toBe(true)
    expect(result.canSelfUpdate).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('meldet, wenn die laufende Version aktuell ist', async () => {
    const result = await checkLatestVersion({
      current: '1.0.7',
      canSelfUpdate: true,
      fetchImpl: ghcrFetch(['v1.0.7', 'v1.0.6']),
    })
    expect(result.latest).toBe('v1.0.7')
    expect(result.updateAvailable).toBe(false)
  })

  it('faellt bei Registry-Fehlern sauber zurueck', async () => {
    const failing = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const result = await checkLatestVersion({
      current: '1.0.5',
      canSelfUpdate: false,
      fetchImpl: failing,
    })
    expect(result.current).toBe('1.0.5')
    expect(result.latest).toBeNull()
    expect(result.updateAvailable).toBeNull()
    expect(result.canSelfUpdate).toBe(false)
    expect(result.error).toBeTruthy()
  })
})
