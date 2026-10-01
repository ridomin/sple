import {
  AuthRequiredError,
  NotFoundError,
  QuotaExhaustedError,
  RateLimitError,
  AccessRestrictedError,
  UsageError,
  ProviderError,
} from '../core/provider/errors.js'

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE_ERROR: 2,
  AUTH_REQUIRED: 3,
  NOT_FOUND: 4,
  QUOTA_EXHAUSTED: 5,
} as const

export function getExitCode(error: unknown): number {
  if (error instanceof AuthRequiredError) {
    return EXIT_CODES.AUTH_REQUIRED
  }

  if (error instanceof NotFoundError) {
    return EXIT_CODES.NOT_FOUND
  }

  if (error instanceof QuotaExhaustedError || error instanceof RateLimitError) {
    return EXIT_CODES.QUOTA_EXHAUSTED
  }

  if (error instanceof AccessRestrictedError) {
    return EXIT_CODES.ERROR
  }

  if (error instanceof UsageError) {
    return EXIT_CODES.USAGE_ERROR
  }

  if (error instanceof ProviderError) {
    return EXIT_CODES.ERROR
  }

  if (error instanceof Error) {
    return EXIT_CODES.ERROR
  }

  return EXIT_CODES.ERROR
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof AuthRequiredError) {
    if (error.scope) {
      return `Authentication required: missing scope '${error.scope}'`
    }
    return 'Authentication required. Run "sple auth login" to log in.'
  }

  if (error instanceof NotFoundError) {
    return `${error.resourceType} not found: ${error.message}`
  }

  if (error instanceof QuotaExhaustedError) {
    const msg = `Quota exhausted: ${error.bucket}`
    if (error.resetAt) {
      return `${msg} (resets at ${error.resetAt.toISOString()})`
    }
    return msg
  }

  if (error instanceof RateLimitError) {
    const msg = 'Rate limited. Please try again later.'
    if (error.retryAfterMs) {
      const seconds = Math.ceil(error.retryAfterMs / 1000)
      return `${msg} Retry after ${seconds}s.`
    }
    return msg
  }

  if (error instanceof AccessRestrictedError) {
    return `Access restricted: ${error.message}`
  }

  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
