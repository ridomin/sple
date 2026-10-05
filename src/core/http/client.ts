import createDebug from 'debug'
import type { ProviderId } from '../provider/capabilities.js'
import type { StoredToken } from '../config/token-store.js'
import { saveTokens } from '../config/token-store.js'
import {
  AuthRequiredError,
  NotFoundError,
  AccessRestrictedError,
  ProviderError,
  RateLimitError,
} from '../provider/errors.js'

const log = createDebug('sple:http')
const logRetry = createDebug('sple:http:retry')
const logError = createDebug('sple:http:error')

/** One completed HTTP attempt, for `--debug` request lines (ADR 0007 §6). */
export interface HttpLogEntry {
  method: string
  /** Path and query string, with `q`/`uris` values truncated. Never contains headers or bodies. */
  path: string
  /** HTTP status, or `ERR <code>` for a network error. */
  status: number | string
  durationMs: number
  /** Number of earlier attempts for this request (0 on the first). */
  retries: number
}

export interface HttpClientOptions {
  providerId: ProviderId
  getToken?: () => Promise<StoredToken | null>
  refresh?: (token: StoredToken) => Promise<StoredToken>
  /**
   * Adapter-specific error mapping. Consulted for every non-2xx response the
   * client does not handle itself, and for the final response once refresh
   * (401) or retries (429, 5xx) are exhausted.
   */
  mapError?: (res: HttpResponse) => ProviderError | undefined
  /** When set, refreshed tokens are saved here. Leave unset if `refresh` saves them itself. */
  configDir?: string
  maxRetries?: number
  maxWaitMs?: number
  /** Called after every attempt (including retries). */
  onResponse?: (entry: HttpLogEntry) => void
}

export interface HttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string | FormData
}

export interface HttpResponse {
  status: number
  headers: Map<string, string>
  body: string
}

/** Thrown internally for retryable 5xx responses so the retry loop can see the status. */
class ServerError extends Error {
  constructor(public readonly response: HttpResponse) {
    super(`HTTP ${response.status}`)
  }
}

export class HttpClient {
  private providerId: ProviderId
  private getToken?: () => Promise<StoredToken | null>
  private refresh?: (token: StoredToken) => Promise<StoredToken>
  private mapError?: (res: HttpResponse) => ProviderError | undefined
  private configDir?: string
  private maxRetries: number
  private maxWaitMs: number
  private onResponse?: (entry: HttpLogEntry) => void
  private baseDelay = 100 // ms
  private maxDelay = 10000 // ms
  private refreshPromise: Promise<StoredToken> | null = null
  /** The last completed refresh, so late callers holding the old token reuse its result. */
  private lastRefresh: { from: string; to: StoredToken } | null = null

  constructor(options: HttpClientOptions) {
    this.providerId = options.providerId
    this.getToken = options.getToken
    this.refresh = options.refresh
    this.mapError = options.mapError
    this.configDir = options.configDir
    this.maxRetries = options.maxRetries ?? 3
    this.maxWaitMs = options.maxWaitMs ?? 120000
    this.onResponse = options.onResponse
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    let token = (await this.getToken?.()) ?? null

    // Proactively refresh when the token expires within 60 s.
    if (token && this.refresh && this.isExpiringSoon(token)) {
      token = await this.performRefresh(token)
    }

    let requestHeaders = req.headers ?? {}
    if (token && !requestHeaders.Authorization) {
      requestHeaders = {
        ...requestHeaders,
        Authorization: `Bearer ${token.accessToken}`,
      }
    }

    return this.requestWithRetry({ ...req, headers: requestHeaders }, 0, false)
  }

  /**
   * Send a request and validate its JSON body at the boundary (NFR-3).
   * A body that is not JSON becomes a ProviderError, never a SyntaxError.
   */
  async requestJson<T>(req: HttpRequest, validate: (x: unknown) => T): Promise<T> {
    const response = await this.request(req)
    let parsed: unknown
    try {
      parsed = JSON.parse(response.body)
    } catch {
      throw new ProviderError(`Invalid JSON in response to ${req.method} ${this.displayPath(req.url)}`)
    }
    return validate(parsed)
  }

  private isExpiringSoon(token: StoredToken): boolean {
    if (!token.expiresAt) return false
    const expiresAt = new Date(token.expiresAt).getTime()
    if (Number.isNaN(expiresAt)) return false
    return (expiresAt - Date.now()) / 1000 < 60
  }

  /** Single-flight refresh: concurrent callers share one in-flight refresh. */
  private async performRefresh(token: StoredToken): Promise<StoredToken> {
    const refresh = this.refresh
    if (!refresh) {
      throw new AuthRequiredError('Token refresh not available', 'no-token')
    }

    // Another request already refreshed this exact token: reuse the result.
    if (this.lastRefresh && this.lastRefresh.from === token.accessToken) {
      return this.lastRefresh.to
    }

    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        try {
          const newToken = await refresh(token)
          if (this.configDir) {
            saveTokens(this.providerId, newToken, this.configDir)
          }
          this.lastRefresh = { from: token.accessToken, to: newToken }
          return newToken
        } finally {
          this.refreshPromise = null
        }
      })()
    }
    return this.refreshPromise
  }

  private async requestWithRetry(
    req: HttpRequest,
    attempt: number,
    hasRefreshed: boolean
  ): Promise<HttpResponse> {
    try {
      const startTime = Date.now()
      let response: Response
      try {
        response = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        })
      } catch (error) {
        const code = (error as { cause?: { code?: unknown } }).cause?.code
        this.report(req, `ERR ${typeof code === 'string' ? code : 'network'}`, Date.now() - startTime, attempt)
        throw error
      }

      const headers = this.headersToMap(response.headers)
      const body = await response.text()
      const duration = Date.now() - startTime
      this.report(req, response.status, duration, attempt)

      const httpResponse: HttpResponse = { status: response.status, headers, body }

      if (response.ok) return httpResponse

      if (response.status === 401) {
        if (!hasRefreshed && this.refresh && this.getToken) {
          const stored = await this.getToken()
          if (stored) {
            // If the stored token already differs from the one we sent, another
            // request (or process) refreshed it: retry with it instead of refreshing again.
            const sent = req.headers?.Authorization
            const fresh =
              sent !== undefined && sent !== `Bearer ${stored.accessToken}`
                ? stored
                : await this.performRefresh(stored)
            return this.requestWithRetry(
              { ...req, headers: { ...req.headers, Authorization: `Bearer ${fresh.accessToken}` } },
              attempt,
              true
            )
          }
        }
        logError('Received 401 and cannot refresh token')
        throw this.mapError?.(httpResponse) ?? new AuthRequiredError('Authentication required', 'no-token')
      }

      if (response.status === 429) {
        const retryAfterMs = this.parseRetryAfter(headers)
        logRetry(`Rate limited (429), retry after ${retryAfterMs}ms, max wait ${this.maxWaitMs}ms`)

        if (retryAfterMs > this.maxWaitMs) {
          logError(`Rate limited: retry-after ${retryAfterMs}ms exceeds maxWaitMs`)
          throw new RateLimitError('Rate limited: retry-after exceeds max wait', retryAfterMs)
        }
        if (attempt < this.maxRetries) {
          await this.delay(retryAfterMs)
          return this.requestWithRetry(req, attempt + 1, hasRefreshed)
        }
        logError(`Rate limited after ${attempt} retries`)
        throw new RateLimitError(`Rate limited after ${attempt} retries`, retryAfterMs)
      }

      if (response.status >= 500) {
        throw new ServerError(httpResponse)
      }

      const mapped = this.mapError?.(httpResponse)
      if (mapped) {
        logError(`Mapped error ${response.status} to ${mapped.name}`)
        throw mapped
      }
      if (response.status === 404) throw new NotFoundError('Resource not found', 'other')
      if (response.status === 403) throw new AccessRestrictedError('Access restricted', 'other')
      throw new ProviderError(`HTTP request failed (HTTP ${response.status})`)
    } catch (error) {
      // Network errors and 5xx responses are retried with backoff.
      const isNetworkError = error instanceof TypeError
      const serverError = error instanceof ServerError ? error : undefined

      if ((isNetworkError || serverError) && attempt < this.maxRetries) {
        const delay = serverError?.response.headers.has('retry-after')
          ? Math.min(this.parseRetryAfter(serverError.response.headers), this.maxWaitMs)
          : this.calculateBackoff(attempt)
        logRetry(`Attempt ${attempt + 1}/${this.maxRetries} after ${delay}ms`)
        await this.delay(delay)
        return this.requestWithRetry(req, attempt + 1, hasRefreshed)
      }

      if (serverError) {
        logError(`HTTP ${serverError.response.status} after ${attempt} retries`)
        throw (
          this.mapError?.(serverError.response) ??
          new ProviderError(`Service unavailable (HTTP ${serverError.response.status}) after ${attempt} retries`)
        )
      }

      logError(`Failed after ${attempt} retries: ${(error as Error).message}`)
      throw error
    }
  }

  private report(req: HttpRequest, status: number | string, durationMs: number, retries: number): void {
    const path = this.displayPath(req.url)
    log(`${req.method} ${path} → ${status} (${durationMs}ms)`)
    this.onResponse?.({ method: req.method, path, status, durationMs, retries })
  }

  private calculateBackoff(attempt: number): number {
    const exponential = this.baseDelay * Math.pow(2, attempt)
    const jitter = exponential * (0.8 + Math.random() * 0.4) // ±20%
    return Math.min(jitter, this.maxDelay)
  }

  private parseRetryAfter(headers: Map<string, string>): number {
    const retryAfter = headers.get('retry-after')
    if (!retryAfter) return this.calculateBackoff(0)

    if (/^\d+$/.test(retryAfter.trim())) return Number(retryAfter.trim()) * 1000

    const date = new Date(retryAfter).getTime()
    if (Number.isNaN(date)) return this.calculateBackoff(0)
    return Math.max(date - Date.now(), 0)
  }

  /** Path + query, with `q`/`uris` values truncated to 20 characters (M1-12). */
  private displayPath(url: string): string {
    try {
      const parsed = new URL(url)
      for (const param of ['uris', 'q']) {
        const value = parsed.searchParams.get(param)
        if (value !== null && value.length > 20) {
          parsed.searchParams.set(param, value.substring(0, 20) + '...')
        }
      }
      return `${parsed.pathname}${parsed.search}`
    } catch {
      return url
    }
  }

  private headersToMap(headers: Headers): Map<string, string> {
    const map = new Map<string, string>()
    headers.forEach((value, key) => {
      map.set(key.toLowerCase(), value)
    })
    return map
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
