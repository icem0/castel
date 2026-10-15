// Structured auth errors.
//
// The auth store throws AuthError with a stable, machine-readable `code`
// instead of hard-coded user-facing strings. Callers (typically views)
// translate the code into a localised message via vue-i18n. The `message`
// field stays as a German fallback so that:
//   - server logs / tests still produce readable output,
//   - the view can fall back to `e.message` if a translation key is missing,
//   - non-Vue callers (CLI scripts, tests) still see something meaningful.
//
// This is the same pattern as `BuchungsError` in src/domain/errors.ts:
// a `code` property plus a human-readable `message`.

export type AuthErrorCode =
  | 'auth.email.required'
  | 'auth.password.required'
  | 'auth.server.unreachable'
  | 'auth.offline.no_cache'
  | 'auth.cache.lost'
  | 'auth.jwt.missing'
  | 'auth.jwt.expired'
  | 'auth.network'
  | 'auth.unknown'

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError
}
