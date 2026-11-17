// Tests for the derived UPDATE_WEBHOOK_URL.
//
// The operator must not have to hand-copy a port that already stands in the
// .env: leaving UPDATE_WEBHOOK_URL empty has to resolve to the inbound
// webhook endpoint on the PWA's host port. An explicit value always wins, and
// a URL that points back at the API container is detected so the config layer
// can warn instead of letting the first button click fail cryptically.

import { describe, expect, it } from 'vitest'
import { isSelfCallWebhookUrl, resolveUpdateWebhookUrl } from '../webhook-url.js'

describe('resolveUpdateWebhookUrl', () => {
  it('derives the endpoint from the published PWA port when unset', () => {
    expect(resolveUpdateWebhookUrl('', 4280)).toBe(
      'http://host.docker.internal:4280/api/admin/update/webhook',
    )
    expect(resolveUpdateWebhookUrl('   ', 9080)).toBe(
      'http://host.docker.internal:9080/api/admin/update/webhook',
    )
  })

  it('keeps an explicit value untouched (trims only)', () => {
    expect(resolveUpdateWebhookUrl(' http://host.docker.internal:9000/hooks/castel-update ', 4280)).toBe(
      'http://host.docker.internal:9000/hooks/castel-update',
    )
    expect(resolveUpdateWebhookUrl('http://10.0.0.5:4242/api/admin/update/webhook', 4280)).toBe(
      'http://10.0.0.5:4242/api/admin/update/webhook',
    )
  })

  it('falls back to the compose default for an unusable port', () => {
    expect(resolveUpdateWebhookUrl('', undefined)).toBe(
      'http://host.docker.internal:4280/api/admin/update/webhook',
    )
    expect(resolveUpdateWebhookUrl('', 'not-a-port')).toBe(
      'http://host.docker.internal:4280/api/admin/update/webhook',
    )
    expect(resolveUpdateWebhookUrl('', 0)).toBe(
      'http://host.docker.internal:4280/api/admin/update/webhook',
    )
    expect(resolveUpdateWebhookUrl('', '70000')).toBe(
      'http://host.docker.internal:4280/api/admin/update/webhook',
    )
    expect(resolveUpdateWebhookUrl('', '8080')).toBe(
      'http://host.docker.internal:8080/api/admin/update/webhook',
    )
  })
})

describe('isSelfCallWebhookUrl', () => {
  it('flags loopback on the own port as a self-call', () => {
    expect(isSelfCallWebhookUrl('http://127.0.0.1:3000/api/admin/update/webhook', 3000)).toBe(true)
    expect(isSelfCallWebhookUrl('http://localhost:3000/api/admin/update/webhook', 3000)).toBe(true)
    expect(isSelfCallWebhookUrl('http://127.0.0.1/api/admin/update/webhook', 80)).toBe(true)
  })

  it('does not flag other targets', () => {
    expect(isSelfCallWebhookUrl('http://host.docker.internal:4280/api/admin/update/webhook', 3000)).toBe(false)
    expect(isSelfCallWebhookUrl('http://127.0.0.1:4280/api/admin/update/webhook', 3000)).toBe(false)
    expect(isSelfCallWebhookUrl('http://10.0.0.5:9000/hooks/castel-update', 3000)).toBe(false)
  })

  it('tolerates an empty or malformed URL', () => {
    expect(isSelfCallWebhookUrl('', 3000)).toBe(false)
    expect(isSelfCallWebhookUrl('host.docker.internal', 3000)).toBe(false)
    expect(isSelfCallWebhookUrl('ftp://localhost:3000', 3000)).toBe(false)
  })
})
