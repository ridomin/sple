/**
 * Extract the OAuth `error` code from a token-endpoint error body.
 * Only a short `[a-z_]` code is returned; descriptions and any other body
 * content are discarded so nothing from the body reaches messages or logs.
 */
export function parseOAuthErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string' && /^[a-z_]{1,64}$/.test(parsed.error)) {
      return parsed.error
    }
  } catch {
    // Not JSON: no usable code
  }
  return undefined
}
