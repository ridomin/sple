import {
  AccessRestrictedError,
  AuthRequiredError,
  ProviderError,
  RateLimitError,
} from '../../core/provider/errors.js'

/** Which token-endpoint grant failed; decides how `invalid_grant` is reported. */
export type TokenGrant = 'authorization_code' | 'refresh_token'

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

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number.parseInt(value, 10)
  return Number.isNaN(seconds) ? undefined : seconds * 1000
}

/**
 * Map a non-2xx response from `POST https://accounts.spotify.com/api/token`
 * to a closed error type. The response body is used only to read the OAuth
 * `error` code and is never included in the message.
 */
export function mapTokenEndpointError(
  status: number,
  body: string,
  grant: TokenGrant,
  retryAfter: string | null = null
): ProviderError {
  const code = parseOAuthErrorCode(body)

  if (code === 'invalid_grant') {
    if (grant === 'refresh_token') {
      return new AuthRequiredError(
        'Spotify refresh token was revoked or expired; run "sple auth login"',
        'revoked'
      )
    }
    return new ProviderError(
      'Spotify rejected the authorization code (invalid_grant). Run "sple auth login" again.'
    )
  }

  if (code === 'invalid_client' || code === 'unauthorized_client' || status === 401) {
    return new ProviderError(
      `Spotify rejected the client ID (${code ?? `HTTP ${status}`}). ` +
        'Check SPLE_SPOTIFY_CLIENT_ID and the app\'s redirect URIs in the Spotify developer dashboard.'
    )
  }

  if (status === 429) {
    return new RateLimitError('Spotify token endpoint rate limited', parseRetryAfterMs(retryAfter))
  }

  if (status >= 500) {
    return new ProviderError(`Spotify token endpoint unavailable (HTTP ${status}). Try again later.`)
  }

  return new ProviderError(
    `Spotify token request failed (HTTP ${status}${code ? `, ${code}` : ''})`
  )
}

/**
 * Map a non-2xx response from a Spotify Web API call (e.g. `GET /v1/me`).
 * Premium detection (S4) is added in M1-11.
 */
export function mapApiError(status: number, retryAfter: string | null = null): ProviderError {
  if (status === 401) {
    return new AuthRequiredError('Spotify access token rejected; run "sple auth login"', 'token-expired')
  }
  if (status === 403) {
    return new AccessRestrictedError('Spotify denied access to this resource', 'other')
  }
  if (status === 429) {
    return new RateLimitError('Spotify API rate limited', parseRetryAfterMs(retryAfter))
  }
  return new ProviderError(`Spotify API request failed (HTTP ${status})`)
}
