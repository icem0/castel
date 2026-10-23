import { describe, expect, it } from 'vitest'
import { buildOpenApiSpec } from '../docs.js'

describe('buildOpenApiSpec', () => {
  const spec = buildOpenApiSpec() as {
    openapi: string
    paths: Record<string, unknown>
    components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> }
  }

  it('is an OpenAPI 3.1 document', () => {
    expect(spec.openapi).toBe('3.1.0')
  })

  it('documents every agent endpoint', () => {
    for (const path of [
      '/api/v1/meta',
      '/api/v1/status',
      '/api/v1/artikel',
      '/api/v1/artikel/{id}',
      '/api/v1/standorte',
      '/api/v1/standorte/{id}',
      '/api/v1/bestand',
      '/api/v1/buchungen',
      '/api/v1/buchungen/{id}/storno',
      '/api/v1/buchungen/{id}/kommission',
      '/api/v1/kommissionen',
      '/api/v1/mindestbestand',
      '/api/v1/audit',
    ]) {
      expect(spec.paths).toHaveProperty(path)
    }
  })

  it('exposes both auth headers and request schemas', () => {
    expect(spec.components.securitySchemes).toHaveProperty('bearerApiKey')
    expect(spec.components.securitySchemes).toHaveProperty('apiKeyHeader')
    expect(spec.components.schemas).toHaveProperty('BuchungCreate')
    expect(spec.components.schemas).toHaveProperty('Artikel')
  })
})
