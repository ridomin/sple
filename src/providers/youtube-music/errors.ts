import {
  AccessRestrictedError,
  AuthRequiredError,
  NotFoundError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from '../../core/provider/errors.js'
import type { HttpResponse } from '../../core/http/client.js'

/**
 * HTTP 409 from the YouTube Data API. `playlistItems.insert` returns it
 * transiently right after a playlist is created, so the client retries it.
 */
export class YouTubeConflictError extends ProviderError {
  constructor(message: string) {
    super(message)
    Object.setPrototypeOf(this, YouTubeConflictError.prototype)
  }
}

/**
 * Read `error.errors[0].reason` from a YouTube Data API error body. Only a
 * short identifier is returned, so nothing else from the body reaches
 * messages or logs.
 */
export function parseYouTubeErrorReason(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: Array<{ reason?: unknown }> } }
    const reason = parsed.error?.errors?.[0]?.reason
    return typeof reason === 'string' && /^[A-Za-z_]{1,64}$/.test(reason) ? reason : undefined
  } catch {
    return undefined
  }
}

/** Map a non-2xx YouTube Data API response (ADR-0010 §3). */
export function mapYouTubeHttpError(res: HttpResponse): ProviderError {
  const reason = parseYouTubeErrorReason(res.body)
  const detail = `HTTP ${res.status}${reason ? `, ${reason}` : ''}`

  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return new QuotaExhaustedError(
      'YouTube Data API daily quota exhausted; it resets at midnight Pacific Time',
      'units'
    )
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return new RateLimitError(`YouTube rate limit exceeded (${reason})`)
  }
  if (res.status === 401) {
    return new AuthRequiredError('YouTube Music token expired; run "sple auth login"', 'token-expired')
  }
  if (res.status === 404 || reason?.endsWith('NotFound')) {
    const resourceType = reason === 'videoNotFound' ? 'track' : reason?.startsWith('playlist') ? 'playlist' : 'other'
    return new NotFoundError(`YouTube resource not found (${detail})`, resourceType)
  }
  if (reason === 'insufficientPermissions') {
    // The token lacks the YouTube scope (e.g. its checkbox was left unticked at consent).
    const scope = 'https://www.googleapis.com/auth/youtube'
    return new AuthRequiredError(`Run "sple auth login" to grant ${scope}`, 'missing-scope', scope)
  }
  if (res.status === 409) {
    return new YouTubeConflictError(`YouTube API request failed (${detail})`)
  }
  if (res.status === 403) {
    return new AccessRestrictedError(`YouTube denied the request (${detail})`, 'other')
  }
  return new ProviderError(`YouTube API request failed (${detail})`)
}
