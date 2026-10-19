// Tests für den Notification-Gateway.
//
// Wir verifizieren die Schnittstelle: das `LogNotificationGateway`
// loggt Events, das `SmtpNotificationGateway` wirft aktuell (Skeleton).
// `buildNotificationGateway` wählt anhand der Mail-Config die richtige
// Implementierung.

import { describe, expect, it, vi } from 'vitest'
import {
  LogNotificationGateway,
  SmtpNotificationGateway,
  buildNotificationGateway,
  type MindestbestandEvent,
} from '../services/notification-gateway.js'

const sampleEvent: MindestbestandEvent = {
  id: 'evt-1',
  artikelId: 'a-1',
  standortId: 's-1',
  ausloeserBuchungId: 'b-1',
  bestandDanach: 2,
  mindestbestand: 5,
  defizit: 3,
  erstelltAm: '2025-04-14T11:00:00.000Z',
}

describe('LogNotificationGateway', () => {
  it('loggt Mindestbestand-Ereignis auf info-Level', async () => {
    const info = vi.fn()
    const warn = vi.fn()
    const error = vi.fn()
    const gw = new LogNotificationGateway({ info, warn, error })
    await gw.dispatchMindestbestandEvent(sampleEvent)
    expect(info).toHaveBeenCalledTimes(1)
    const [meta, message] = info.mock.calls[0]!
    expect(message).toContain('Mindestbestand unterschritten')
    expect(meta).toMatchObject({
      event: 'mindestbestand.unterschritten',
      id: 'evt-1',
      artikelId: 'a-1',
      standortId: 's-1',
      bestandDanach: 2,
      mindestbestand: 5,
      defizit: 3,
    })
  })

  it('name = "log"', () => {
    const gw = new LogNotificationGateway({ info: () => {}, warn: () => {}, error: () => {} })
    expect(gw.name).toBe('log')
  })
})

describe('SmtpNotificationGateway (Skeleton)', () => {
  it('wirft "nicht implementiert"', async () => {
    const gw = new SmtpNotificationGateway({
      host: 'smtp.example.com',
      port: 587,
      user: 'u',
      pass: 'p',
      from: 'castel@example.com',
      dailyDigestHour: 7,
    })
    await expect(gw.dispatchMindestbestandEvent(sampleEvent)).rejects.toThrow(
      /noch nicht implementiert/,
    )
  })

  it('name = "smtp"', () => {
    const gw = new SmtpNotificationGateway({
      host: '',
      port: 587,
      user: '',
      pass: '',
      from: '',
      dailyDigestHour: 7,
    })
    expect(gw.name).toBe('smtp')
  })
})

describe('buildNotificationGateway', () => {
  it('mailEnabled=false → LogNotificationGateway', () => {
    const gw = buildNotificationGateway({
      mailEnabled: false,
      smtp: {
        host: '',
        port: 587,
        user: '',
        pass: '',
        from: '',
        dailyDigestHour: 7,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    expect(gw.name).toBe('log')
  })

  it('mailEnabled=true → SmtpNotificationGateway', () => {
    const gw = buildNotificationGateway({
      mailEnabled: true,
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        user: 'u',
        pass: 'p',
        from: 'castel@example.com',
        dailyDigestHour: 7,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    expect(gw.name).toBe('smtp')
  })
})
