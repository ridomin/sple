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

export interface HttpClientOptions {
  providerId: ProviderId
  getToken?: () => Promise<StoredToken | null>
  refresh?: (token: StoredToken) => Promise<StoredToken>
  mapError?: (res: HttpResponse) => ProviderError | undefined
  configDir?: string
  maxRetries?: number
  maxWaitMs?: number
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

export class HttpClient {
  private providerId: ProviderId
  private getToken?: () => Promise<StoredToken | null>
  private refresh?: (token: StoredToken) => Promise<StoredToken>
  private mapError?: (res: HttpResponse) => ProviderError | undefined
  private configDir?: string
  private maxRetries: number
  private maxWaitMs: number
  private baseDelay = 100 // ms
  private maxDelay = 10000 // ms
  private refreshPromise: Promise<StoredToken> | null = null

  constructor(options: HttpClientOptions) {
    this.providerId = options.providerId
    this.getToken = options.getToken
    this.refresh = options.refresh
    this.mapError = options.mapError
    this.configDir = options.configDir
    this.maxRetries = options.maxRetries ?? 3
    this.maxWaitMs = options.maxWaitMs ?? 120000
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    // Proactively refresh if token exists and is expiring soon
    const token = await this.getToken?.()
    if (token && this.refresh && this.isExpiringSoon(token)) {
      await this.performRefresh(token)
    }

    // Inject token if available
    let requestHeaders = req.headers ?? {}
    if (token && !requestHeaders.Authorization) {
      requestHeaders = {
        ...requestHeaders,
        Authorization: `Bearer ${token.accessToken}`,
      }
    }

    return this.requestWithRetry({ ...req, headers: requestHeaders }, 0, false)
  }

  async requestJson<T>(
    req: HttpRequest,
    validate: (x: unknown) => T
  ): Promise<T> {
    const response = await this.request(req)
    const parsed = JSON.parse(response.body)
    return validate(parsed)
  }

  private isExpiringSoon(token: StoredToken): boolean {
    if (!token.expiresAt) return false
    const expiresAt = new Date(token.expiresAt).getTime()
    const now = Date.now()
    const secondsUntilExpiry = (expiresAt - now) / 1000
    return secondsUntilExpiry < 60
  }

  private async performRefresh(token: StoredToken): Promise<StoredToken> {
    if (!this.refresh) {
      throw new AuthRequiredError('Token refresh not available', 'no-token')
    }

    // Single-flight: reuse in-flight refresh
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.refresh(token)
    try {
      const newToken = await this.refreshPromise
      if (this.configDir) {
        await saveTokens(this.providerId, newToken, this.configDir)
      }
      return newToken
    } finally {
      this.refreshPromise = null
    }
  }

  private async requestWithRetry(
    req: HttpRequest,
    attempt: number,
    hasRefreshed: boolean
  ): Promise<HttpResponse> {
    try {
      const startTime = Date.now()
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body instanceof FormData ? req.body : req.body,
      })

      const duration = Date.now() - startTime
      const headers = this.headersToMap(response.headers)
      const body = await response.text()

      // Log without secrets
      const path = this.truncateQueryValues(req.url)
      log(`${req.method} ${path} → ${response.status} (${duration}ms)`)

      const httpResponse: HttpResponse = {
        status: response.status,
        headers,
        body,
      }

      // Try provider-specific error mapping first
      if (!response.ok && this.mapError) {
        const mappedError = this.mapError(httpResponse)
        if (mappedError) {
          logError(`Mapped error ${response.status} to ${mappedError.name}`)
          throw mappedError
        }
      }

      if (response.status === 401) {
        if (!hasRefreshed && this.refresh && this.getToken) {
          const token = await this.getToken()
          if (token) {
            const newToken = await this.performRefresh(token)
            const updatedHeaders = {
              ...req.headers,
              Authorization: `Bearer ${newToken.accessToken}`,
            }
            return this.requestWithRetry(
              { ...req, headers: updatedHeaders },
              attempt,
              true
            )
          }
        }
        logError('Received 401 and cannot refresh token')
        throw new AuthRequiredError('Authentication required', 'no-token')
      }

      if (response.status === 429) {
        const retryAfterMs = this.parseRetryAfter(headers)
        logRetry(
          `Rate limited (429), retry after ${retryAfterMs}ms, max wait ${this.maxWaitMs}ms`
        )

        // If retry wait exceeds maxWaitMs or after maxRetries, throw immediately
        if (retryAfterMs > this.maxWaitMs) {
          logError(`Rate limited: retry-after ${retryAfterMs}ms exceeds maxWaitMs`)
          throw new RateLimitError(
            `Rate limited: retry-after exceeds max wait`,
            retryAfterMs
          )
        }

        if (attempt < this.maxRetries) {
          await this.delay(retryAfterMs)
          return this.requestWithRetry(req, attempt + 1, hasRefreshed)
        }

        logError(`Rate limited after ${attempt} retries`)
        throw new RateLimitError(`Rate limited after ${attempt} retries`, retryAfterMs)
      }

      if (response.status === 503) {
        const retryAfterMs = this.parseRetryAfter(headers)
        logRetry(`Service unavailable (503), retry after ${retryAfterMs}ms`)

        if (attempt < this.maxRetries) {
          await this.delay(retryAfterMs)
          return this.requestWithRetry(req, attempt + 1, hasRefreshed)
        }

        logError(`Service unavailable after ${attempt} retries`)
        throw new Error(`Service unavailable after ${attempt} retries`)
      }

      if (!response.ok) {
        // Default error mappings
        if (response.status === 404) {
          logError(`Not found (404)`)
          throw new NotFoundError('Resource not found', 'other')
        }
        if (response.status === 403) {
          logError(`Access restricted (403)`)
          throw new AccessRestrictedError('Access restricted', 'other')
        }
        if (response.status === 400) {
          logError(`Invalid request (400)`)
          throw new ProviderError(`Invalid request: ${response.status}`)
        }

        logError(`HTTP ${response.status}`)
        const error = new Error(`HTTP ${response.status}`)
        const errorWithStatus = error as Error & { status: number }
        errorWithStatus.status = response.status
        throw errorWithStatus
      }

      return httpResponse
    } catch (error) {
      // Network errors and 5xx errors trigger retry
      const isNetworkError = error instanceof TypeError
      const errorWithStatus = error as Error & { status?: number }
      const isServerError =
        errorWithStatus.status !== undefined &&
        errorWithStatus.status >= 500 &&
        errorWithStatus.status < 600

      if (
        (isNetworkError || isServerError) &&
        attempt < this.maxRetries &&
        !this.isProviderError(error)
      ) {
        const delay = this.calculateBackoff(attempt)
        logRetry(`Attempt ${attempt + 1}/${this.maxRetries} after ${delay}ms`)
        await this.delay(delay)
        return this.requestWithRetry(req, attempt + 1, hasRefreshed)
      }

      logError(`Failed after ${attempt} retries: ${(error as Error).message}`)
      throw error
    }
  }

  private isProviderError(error: unknown): boolean {
    return (
      error instanceof AuthRequiredError ||
      error instanceof NotFoundError ||
      error instanceof AccessRestrictedError ||
      error instanceof ProviderError ||
      error instanceof RateLimitError
    )
  }

  private calculateBackoff(attempt: number): number {
    const exponential = this.baseDelay * Math.pow(2, attempt)
    const jitter = exponential * (0.8 + Math.random() * 0.4) // ±20%
    return Math.min(jitter, this.maxDelay)
  }

  private parseRetryAfter(headers: Map<string, string>): number {
    const retryAfter = headers.get('retry-after')
    if (!retryAfter) return this.calculateBackoff(0)

    // Try parsing as seconds
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) return seconds * 1000

    // Try parsing as HTTP-date
    try {
      const date = new Date(retryAfter)
      const delay = date.getTime() - Date.now()
      return Math.max(delay, 0)
    } catch {
      return this.calculateBackoff(0)
    }
  }

  private truncateQueryValues(url: string): string {
    // Truncate query parameter values for sensitive parameters
    try {
      const parsed = new URL(url)
      const params = ['uris', 'q']
      for (const param of params) {
        if (parsed.searchParams.has(param)) {
          const value = parsed.searchParams.get(param) || ''
          if (value.length > 20) {
            parsed.searchParams.set(param, value.substring(0, 20) + '...')
          }
        }
      }
      return parsed.toString()
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
