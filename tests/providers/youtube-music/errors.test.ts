import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapYouTubeHttpError, YouTubeConflictError } from '../../../src/providers/youtube-music/errors.js'
import {
  AccessRestrictedError,
  AuthRequiredError,
  NotFoundError,
  ProviderError,
  QuotaExhaustedError,
  RateLimitError,
} from '../../../src/core/provider/errors.js'
import { getExitCode, EXIT_CODES } from '../../../src/cli/exit-codes.js'

// YouTube Data API error bodies: {"error":{"code":403,"errors":[{"reason":"quotaExceeded",...}],...}}
const res = (status: number, reason?: string) => ({
  status,
  headers: new Map<string, string>(),
  body: reason === undefined ? '' : JSON.stringify({ error: { code: status, message: 'm', errors: [{ reason, domain: 'youtube' }] } }),
})

test('403 quotaExceeded and dailyLimitExceeded → QuotaExhaustedError (exit 5)', () => {
  for (const reason of ['quotaExceeded', 'dailyLimitExceeded']) {
    const e = mapYouTubeHttpError(res(403, reason))
    assert.ok(e instanceof QuotaExhaustedError, reason)
    assert.equal(getExitCode(e), EXIT_CODES.QUOTA_EXHAUSTED)
    assert.match(e.message, /quota/i)
  }
})

test('403 rateLimitExceeded / userRateLimitExceeded → RateLimitError', () => {
  for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) {
    assert.ok(mapYouTubeHttpError(res(403, reason)) instanceof RateLimitError, reason)
  }
})

test('401 → AuthRequiredError(token-expired)', () => {
  const e = mapYouTubeHttpError(res(401, 'authError'))
  assert.ok(e instanceof AuthRequiredError)
  assert.equal(e.reason, 'token-expired')
})

test('404 and *NotFound reasons → NotFoundError naming the reason', () => {
  const playlist = mapYouTubeHttpError(res(404, 'playlistNotFound'))
  assert.ok(playlist instanceof NotFoundError)
  assert.equal(playlist.resourceType, 'playlist')
  assert.match(playlist.message, /playlistNotFound/)
  const video = mapYouTubeHttpError(res(404, 'videoNotFound'))
  assert.ok(video instanceof NotFoundError)
  assert.equal(video.resourceType, 'track')
  assert.ok(mapYouTubeHttpError(res(404)) instanceof NotFoundError)
})

test('409 → YouTubeConflictError with the reason', () => {
  const e = mapYouTubeHttpError(res(409, 'SERVICE_UNAVAILABLE'))
  assert.ok(e instanceof YouTubeConflictError)
  assert.equal(e.message, 'YouTube API request failed (HTTP 409, SERVICE_UNAVAILABLE)')
})

test('other 403 → AccessRestrictedError naming the reason', () => {
  const e = mapYouTubeHttpError(res(403, 'playlistItemsNotAccessible'))
  assert.ok(e instanceof AccessRestrictedError)
  assert.match(e.message, /playlistItemsNotAccessible/)
})

test('anything else → ProviderError with status and reason', () => {
  assert.equal(mapYouTubeHttpError(res(400, 'invalidValue')).message, 'YouTube API request failed (HTTP 400, invalidValue)')
  const e = mapYouTubeHttpError(res(500))
  assert.equal(e.constructor, ProviderError)
  assert.equal(e.message, 'YouTube API request failed (HTTP 500)')
})

test('reasons that are not short identifiers are ignored', () => {
  assert.equal(mapYouTubeHttpError(res(400, 'Bearer ya29.secret token')).message, 'YouTube API request failed (HTTP 400)')
  assert.equal(mapYouTubeHttpError({ status: 400, headers: new Map(), body: 'not json' }).message, 'YouTube API request failed (HTTP 400)')
})
