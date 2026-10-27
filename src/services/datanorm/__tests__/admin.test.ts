// Tests für den DATANORM-Admin-Service.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as admin from '../admin'
import * as api from '../../../auth/api'

vi.mock('../../../auth/api', () => ({
  apiFetch: vi.fn(),
}))

const apiFetchMock = vi.mocked(api.apiFetch)

const LIEFERANTEN = [
  { id: 'l1', name: 'Mueller GmbH', matchcode: 'MUE', aktiv: true, ort: null, geaendertAm: '' },
]

const IMPORTE = [
  {
    id: 'i1',
    lieferantId: 'l1',
    originalDateiname: 'lieferant.dat',
    status: 'fertig',
    artikelAnzahl: 10,
    artikelNeu: 8,
    artikelAktualisiert: 2,
    artikelDeaktiviert: 0,
    fehlerAnzahl: 0,
    gestartetAm: '2026-01-01T00:00:00Z',
    beendetAm: '2026-01-01T00:01:00Z',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('services/datanorm/admin', () => {
  it('ladeLieferanten ruft GET /api/lieferanten', async () => {
    apiFetchMock.mockResolvedValue(LIEFERANTEN)
    const res = await admin.ladeLieferanten()
    expect(apiFetchMock).toHaveBeenCalledWith('/api/lieferanten?')
    expect(res).toEqual(LIEFERANTEN)
  })

  it('ladeLieferanten(alle=true) fügt Query-Param hinzu', async () => {
    apiFetchMock.mockResolvedValue(LIEFERANTEN)
    await admin.ladeLieferanten(true)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/lieferanten?alle=true')
  })

  it('anlageLieferant POST /api/lieferanten', async () => {
    apiFetchMock.mockResolvedValue({ id: 'l1', name: 'Neu GmbH' })
    const res = await admin.anlageLieferant({ name: 'Neu GmbH', matchcode: 'NEU', ort: 'Berlin' })
    expect(apiFetchMock).toHaveBeenCalledWith('/api/lieferanten', {
      method: 'POST',
      body: { name: 'Neu GmbH', matchcode: 'NEU', ort: 'Berlin' },
    })
    expect(res).toEqual({ id: 'l1', name: 'Neu GmbH' })
  })

  it('patchLieferant PATCH /api/lieferanten/:id', async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    const res = await admin.patchLieferant('l1', { aktiv: false })
    expect(apiFetchMock).toHaveBeenCalledWith('/api/lieferanten/l1', {
      method: 'PATCH',
      body: { aktiv: false },
    })
    expect(res).toEqual({ ok: true })
  })

  it('uploadDatanormDatei POST /api/datanorm/upload mit FormData', async () => {
    let gesendet: FormData | null = null
    apiFetchMock.mockImplementation((_pfad: string, opts?: { body?: unknown }) => {
      gesendet = opts?.body as FormData
      return Promise.resolve({
        importId: 'imp-1',
        status: 'erfolg',
        artikelAnzahl: 5,
        neu: 5,
        aktualisiert: 0,
        deaktiviert: 0,
        uebersprungen: 0,
        fehlerAnzahl: 0,
        fehlerDetails: [],
        encoding: 'cp850',
        version: 4,
        auffaelligkeiten: [],
      })
    })

    const file = new File(['x'], 'test.dat', { type: 'application/octet-stream' })
    const res = await admin.uploadDatanormDatei(file, 'l1', 'cp850')

    expect(apiFetchMock).toHaveBeenCalledWith('/api/datanorm/upload', {
      method: 'POST',
      body: expect.any(FormData),
    })
    expect(gesendet).toBeInstanceOf(FormData)
    expect(gesendet!.get('lieferantId')).toBe('l1')
    expect(gesendet!.get('encoding')).toBe('cp850')
    expect(gesendet!.get('datei')).toBe(file)
    expect(res).toMatchObject({ importId: 'imp-1', status: 'erfolg', artikelAnzahl: 5, neu: 5 })
  })

  it('ladeImporte ruft GET /api/datanorm/importe', async () => {
    apiFetchMock.mockResolvedValue({ treffer: IMPORTE })
    const res = await admin.ladeImporte('l1')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/datanorm/importe?lieferantId=l1')
    expect(res).toEqual(IMPORTE)
  })

  it('ladeImporte ohne lieferantId ruft ohne Query-Param', async () => {
    apiFetchMock.mockResolvedValue({ treffer: IMPORTE })
    await admin.ladeImporte()
    expect(apiFetchMock).toHaveBeenCalledWith('/api/datanorm/importe')
  })
})
