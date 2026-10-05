import {
  AccessRestrictedError,
  AuthRequiredError,
  NotFoundError,
  ProviderError,
  RateLimitError,
} from '../../core/provider/errors.js'
import type { HttpResponse } from '../../core/http/client.js'

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

export const SPOTIFY_SETUP_DOCS_URL =
  'https://github.com/ridomin/sple/blob/main/docs/user/spotify-setup.md'

export const PREMIUM_REQUIRED_MESSAGE =
  'Spotify Premium is required. Spotify only allows the owner of a Development Mode app ' +
  '(your own Client ID) to use the Web API with an active Premium subscription. ' +
  `See ${SPOTIFY_SETUP_DOCS_URL}`

/**
 * Read `error.message` from a Spotify Web API error body
 * (`{"error":{"status":403,"message":"…"}}`). Used only for matching; the
 * text is never copied into error messages or logs.
 */
function parseApiErrorMessage(body: string | undefined): string | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    return typeof message === 'string' ? message : undefined
  } catch {
    return undefined
  }
}

/**
 * Premium detection rule. Spike S4 is unverified, so this is the documented
 * fallback heuristic: a 403 whose `error.message` matches /premium/i.
 */
export function isPremiumRequired(status: number, body: string | undefined): boolean {
  return status === 403 && /premium/i.test(parseApiErrorMessage(body) ?? '')
}

/**
 * Map a non-2xx response from a Spotify Web API call (e.g. `GET /v1/me`).
 * `body` is only inspected for Premium detection (S4 fallback heuristic).
 */
export function mapApiError(
  status: number,
  retryAfter: string | null = null,
  body?: string
): ProviderError {
  if (status === 401) {
    return new AuthRequiredError('Spotify access token rejected; run "sple auth login"', 'token-expired')
  }
  if (isPremiumRequired(status, body)) {
    return new AccessRestrictedError(PREMIUM_REQUIRED_MESSAGE, 'premium-required')
  }
  if (status === 403) {
    return new AccessRestrictedError('Spotify denied access to this resource', 'other')
  }
  if (status === 404) {
    return new NotFoundError('Spotify resource not found (HTTP 404)', 'other')
  }
  if (status === 429) {
    return new RateLimitError('Spotify API rate limited', parseRetryAfterMs(retryAfter))
  }
  return new ProviderError(`Spotify API request failed (HTTP ${status})`)
}

/**
 * `mapError` hook for the shared HttpClient (M1-12). The client handles
 * refresh (401) and retries (429, 5xx) first and calls this for every other
 * non-2xx response and for the final response once those are exhausted.
 */
export function mapSpotifyHttpError(res: HttpResponse): ProviderError {
  return mapApiError(res.status, res.headers.get('retry-after') ?? null, res.body)
}
