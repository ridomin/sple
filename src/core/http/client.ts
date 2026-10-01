import createDebug from 'debug'
import type { ProviderId } from '../provider/capabilities.js'
import type { StoredToken } from '../config/token-store.js'
import { saveTokens } from '../config/token-store.js'
import { AuthRequiredError, RateLimitError } from '../provider/errors.js'

const log = createDebug('sple:http')
const logRetry = createDebug('sple:http:retry')
const logToken = createDebug('sple:http:token')
const logError = createDebug('sple:http:error')

export interface HttpClientOptions {
  providerId: ProviderId
  onRefreshToken?: (token: StoredToken) => Promise<StoredToken>
  configDir?: string
  maxRetries?: number
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
  private onRefreshToken?: (token: StoredToken) => Promise<StoredToken>
  private configDir?: string
  private maxRetries: number
  private baseDelay = 100 // ms
  private maxDelay = 10000 // ms

  constructor(options: HttpClientOptions) {
    this.providerId = options.providerId
    this.onRefreshToken = options.onRefreshToken
    this.configDir = options.configDir
    this.maxRetries = options.maxRetries ?? 3
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    return this.requestWithRetry(req, 0, false)
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

      log(`${req.method} ${req.url} → ${response.status} (${duration}ms)`)

      if (response.status === 401) {
        if (!hasRefreshed && this.onRefreshToken) {
          logToken('Token expired, attempting refresh')
          return this.refreshAndRetry(req, attempt)
        } else {
          logError('Received 401 and cannot refresh token')
          throw new AuthRequiredError('Authentication required', 'no-token')
        }
      }

      if (response.status === 429 || response.status === 503) {
        const retryAfter = this.parseRetryAfter(headers)
        logRetry(`Rate limited (${response.status}), retry after ${retryAfter}ms`)

        if (attempt < this.maxRetries) {
          await this.delay(retryAfter)
          return this.requestWithRetry(req, attempt + 1, hasRefreshed)
        }

        logError(`Rate limited after ${attempt} retries`)
        throw new RateLimitError(`Rate limited: ${response.status}`, retryAfter)
      }

      if (!response.ok) {
        logError(`HTTP ${response.status}: ${body}`)
        const error = new Error(`HTTP ${response.status}`)
        ;(error as any).status = response.status
        throw error
      }

      return {
        status: response.status,
        headers,
        body,
      }
    } catch (error) {
      // Network errors and 5xx errors trigger retry
      const isNetworkError = error instanceof TypeError
      const isServerError =
        (error as any).status >= 500 && (error as any).status < 600

      if ((isNetworkError || isServerError) && attempt < this.maxRetries) {
        const delay = this.calculateBackoff(attempt)
        logRetry(`Attempt ${attempt + 1}/${this.maxRetries} after ${delay}ms`)
        await this.delay(delay)
        return this.requestWithRetry(req, attempt + 1, hasRefreshed)
      }

      logError(`Failed after ${attempt} retries: ${(error as Error).message}`)
      throw error
    }
  }

  private async refreshAndRetry(
    req: HttpRequest,
    attempt: number
  ): Promise<HttpResponse> {
    if (!this.onRefreshToken) {
      throw new AuthRequiredError('Token refresh not available', 'no-token')
    }

    try {
      logToken(`Refreshing token for ${this.providerId}`)

      // Call the refresh handler - it may or may not load the old token
      // The handler is responsible for getting the refresh token and calling the provider's refresh endpoint
      const newToken = await this.onRefreshToken({} as any)

      if (this.configDir) {
        await saveTokens(this.providerId, newToken, this.configDir)
        logToken(`Token refreshed and saved`)
      } else {
        logToken(`Token refreshed`)
      }

      // Update auth header with new token
      const updatedHeaders = {
        ...req.headers,
        Authorization: `Bearer ${newToken.accessToken}`,
      }

      return this.requestWithRetry(
        { ...req, headers: updatedHeaders },
        attempt,
        true
      )
    } catch (error) {
      logError(`Token refresh failed: ${(error as Error).message}`)
      throw error
    }
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
