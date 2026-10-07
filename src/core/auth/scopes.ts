import { AuthRequiredError } from '../provider/errors.js'

/**
 * Scopes granted by a token response. `scope` is space-separated; when it is
 * absent the requested scopes were granted (RFC 6749 §5.1).
 */
export function grantedScopes(scope: string | undefined, requested: readonly string[]): string[] {
  return scope !== undefined ? scope.split(/\s+/).filter((s) => s.length > 0) : [...requested]
}

/** Requested scopes the user did not grant, e.g. an unticked consent checkbox. */
export function missingScopes(requested: readonly string[], granted: readonly string[]): string[] {
  return requested.filter((s) => !granted.includes(s))
}

/** Throw `AuthRequiredError('missing-scope')` naming the first required scope not granted (FR-AUTH-5). */
export function assertScopes(granted: readonly string[], required: readonly string[]): void {
  const missing = required.find((s) => !granted.includes(s))
  if (missing !== undefined) {
    throw new AuthRequiredError(`Run "sple auth login" to grant ${missing}`, 'missing-scope', missing)
  }
}

/**
 * Throw `AuthRequiredError('missing-scope')` unless at least one of
 * `alternatives` was granted. The error names the first alternative.
 */
export function assertAnyScope(granted: readonly string[], alternatives: readonly string[]): void {
  if (alternatives.length > 0 && !alternatives.some((s) => granted.includes(s))) {
    const scope = alternatives[0]
    throw new AuthRequiredError(`Run "sple auth login" to grant ${scope}`, 'missing-scope', scope)
  }
}
