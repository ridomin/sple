export class ProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
    Object.setPrototypeOf(this, ProviderError.prototype)
  }
}

export class AuthRequiredError extends ProviderError {
  constructor(
    message: string,
    public readonly reason: 'no-token' | 'token-expired' | 'missing-scope' | 'revoked',
    public readonly scope?: string
  ) {
    super(message)
    Object.setPrototypeOf(this, AuthRequiredError.prototype)
  }
}

export class NotFoundError extends ProviderError {
  constructor(
    message: string,
    public readonly resourceType: 'playlist' | 'track' | 'user' | 'other'
  ) {
    super(message)
    Object.setPrototypeOf(this, NotFoundError.prototype)
  }
}

export class AccessRestrictedError extends ProviderError {
  constructor(
    message: string,
    public readonly reason:
      | 'not-owned'
      | 'premium-required'
      | 'region-restricted'
      | 'other'
  ) {
    super(message)
    Object.setPrototypeOf(this, AccessRestrictedError.prototype)
  }
}

export class QuotaExhaustedError extends ProviderError {
  constructor(
    message: string,
    public readonly bucket: string,
    public readonly resetAt?: Date
  ) {
    super(message)
    Object.setPrototypeOf(this, QuotaExhaustedError.prototype)
  }
}

export class RateLimitError extends ProviderError {
  constructor(
    message: string,
    public readonly retryAfterMs?: number
  ) {
    super(message)
    Object.setPrototypeOf(this, RateLimitError.prototype)
  }
}

export class UsageError extends ProviderError {
  constructor(message: string) {
    super(message)
    Object.setPrototypeOf(this, UsageError.prototype)
  }
}
