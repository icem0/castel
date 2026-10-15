// Kryptographische Helfer für die lokale Auth-Schicht (Offline-Cache).
//
// PBKDF2 via Web Crypto API (SubtleCrypto), Standard im Browser verfügbar.
//
// Wichtig: dies ist KEIN Sicherheitsäquivalent zum Server-Login. Der Server
// benutzt argon2id. Hier geht es nur darum, nach Token-Ablauf offline noch
// kurz arbeiten zu können.

const DEFAULT_ITERATIONS = 100_000

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('ungültiger hex-String')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function randomSalt(byteLength = 64): Uint8Array {
  const out = new Uint8Array(byteLength)
  crypto.getRandomValues(out)
  return out
}

async function pbkdf2(text: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(text)
  const keyMaterial = await crypto.subtle.importKey('raw', enc as BufferSource, 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    keyMaterial,
    256,
  )
  return new Uint8Array(bits)
}

export interface HashErgebnis {
  hash: string
  salt: string
  iterations: number
}

export async function hasheText(
  text: string,
  iterationen = DEFAULT_ITERATIONS,
): Promise<HashErgebnis> {
  const salt = randomSalt()
  const bytes = await pbkdf2(text, salt, iterationen)
  return {
    hash: bytesToHex(bytes),
    salt: bytesToHex(salt),
    iterations: iterationen,
  }
}

export async function verifiziereText(
  text: string,
  hashHex: string,
  saltHex: string,
  iterationen: number,
): Promise<boolean> {
  const salt = hexToBytes(saltHex)
  const bytes = await pbkdf2(text, salt, iterationen)
  const computed = bytesToHex(bytes)
  if (computed.length !== hashHex.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ hashHex.charCodeAt(i)
  }
  return diff === 0
}
