import { describe, expect, it } from 'vitest'
import { absoluterFotoPfad, endungFuerMime } from '../service.js'

describe('endungFuerMime', () => {
  it('leitet die Endung aus dem MIME-Typ ab', () => {
    expect(endungFuerMime('image/jpeg')).toBe('.jpg')
    expect(endungFuerMime('image/png')).toBe('.png')
    expect(endungFuerMime('image/webp')).toBe('.webp')
  })

  it('lehnt unbekannte Formate ab', () => {
    expect(endungFuerMime('image/gif')).toBeNull()
    expect(endungFuerMime('application/pdf')).toBeNull()
    expect(endungFuerMime('')).toBeNull()
  })
})

describe('absoluterFotoPfad', () => {
  it('loest normale Pfade innerhalb von FOTOS_DIR auf', () => {
    const pfad = absoluterFotoPfad('artikel-1/abc.jpg')
    expect(pfad).not.toBeNull()
    expect(pfad?.endsWith('/artikel-1/abc.jpg')).toBe(true)
  })

  it('blockt Path-Traversal', () => {
    expect(absoluterFotoPfad('../../etc/passwd')).toBeNull()
    expect(absoluterFotoPfad('/etc/passwd')).toBeNull()
  })
})
