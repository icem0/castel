// Tests fuer den Update-State (scripts/update.sh <-> API).
//
// Der Runner schreibt ein flaches JSON-Dokument in die DB. Die API liest es
// wieder - und darf dabei nie an einem kaputten Dokument scheitern.

import { describe, expect, it } from 'vitest'
import {
  buildRequestDocument,
  EMPTY_UPDATE_STATE,
  parseUpdateState,
} from '../update-routes.js'

describe('parseUpdateState', () => {
  it('liest ein vollstaendiges Dokument', () => {
    const json = JSON.stringify({
      phase: 'running',
      ok: null,
      exitCode: null,
      requestedAt: '2026-01-01T10:00:00Z',
      startedAt: '2026-01-01T10:00:05Z',
      finishedAt: null,
      step: 'compose-up',
      message: 'Update laeuft.',
      log: '==> git pull\n==> docker compose pull',
      gitBefore: 'aaa111',
      gitAfter: 'bbb222',
      versionBefore: '1.0.63',
      versionAfter: '1.0.64',
      imageTag: 'latest',
      host: 'srv01',
    })
    const state = parseUpdateState(json)
    expect(state.phase).toBe('running')
    expect(state.ok).toBeNull()
    expect(state.exitCode).toBeNull()
    expect(state.requestedAt).toBe('2026-01-01T10:00:00Z')
    expect(state.startedAt).toBe('2026-01-01T10:00:05Z')
    expect(state.finishedAt).toBeNull()
    expect(state.step).toBe('compose-up')
    expect(state.message).toBe('Update laeuft.')
    expect(state.log).toContain('docker compose pull')
    expect(state.gitBefore).toBe('aaa111')
    expect(state.gitAfter).toBe('bbb222')
    expect(state.versionBefore).toBe('1.0.63')
    expect(state.versionAfter).toBe('1.0.64')
    expect(state.imageTag).toBe('latest')
    expect(state.host).toBe('srv01')
  })

  it('liest das Ergebnis eines erfolgreichen Laufs', () => {
    const json = JSON.stringify({ phase: 'done', ok: true, exitCode: 0, message: 'Update abgeschlossen.' })
    const state = parseUpdateState(json)
    expect(state.phase).toBe('done')
    expect(state.ok).toBe(true)
    expect(state.exitCode).toBe(0)
  })

  it('liest das Ergebnis eines fehlgeschlagenen Laufs', () => {
    const json = JSON.stringify({ phase: 'failed', ok: false, exitCode: 12, message: 'lokale Aenderungen' })
    const state = parseUpdateState(json)
    expect(state.phase).toBe('failed')
    expect(state.ok).toBe(false)
    expect(state.exitCode).toBe(12)
  })

  it('faellt bei fehlendem Dokument auf den Leerzustand zurueck', () => {
    expect(parseUpdateState(null)).toEqual(EMPTY_UPDATE_STATE)
    expect(parseUpdateState(undefined)).toEqual(EMPTY_UPDATE_STATE)
    expect(parseUpdateState('')).toEqual(EMPTY_UPDATE_STATE)
  })

  it('faellt bei kaputtem JSON auf den Leerzustand zurueck', () => {
    const state = parseUpdateState('kein json {{{')
    expect(state.phase).toBe('requested')
    expect(state.ok).toBeNull()
    expect(state.log).toBeNull()
  })

  it('behandelt eine unbekannte Phase als "requested"', () => {
    const state = parseUpdateState('{"phase":"quatsch"}')
    expect(state.phase).toBe('requested')
  })

  it('ignoriert unvollstaendige Felder', () => {
    const state = parseUpdateState('{"phase":"done","versionBefore":"1.0.1"}')
    expect(state.phase).toBe('done')
    expect(state.versionBefore).toBe('1.0.1')
    expect(state.versionAfter).toBeNull()
  })

  it('behaelt Quotes im Log unbeschaedigt', () => {
    const state = parseUpdateState('{"phase":"failed","log":"Fehler: \\"api unhealthy\\"\\nZeile 2"}')
    expect(state.log).toBe('Fehler: "api unhealthy"\nZeile 2')
  })
})

describe('buildRequestDocument', () => {
  it('erzeugt eine Anforderung mit Zeitstempel', () => {
    const json = buildRequestDocument('2026-01-01T10:00:00Z')
    const state = parseUpdateState(json)
    expect(state.phase).toBe('requested')
    expect(state.requestedAt).toBe('2026-01-01T10:00:00Z')
    expect(state.startedAt).toBeNull()
    expect(state.finishedAt).toBeNull()
    expect(state.ok).toBeNull()
    expect(state.log).toBeNull()
  })
})
