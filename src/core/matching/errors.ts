export class MatchingError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'MatchingError'
    Object.setPrototypeOf(this, MatchingError.prototype)
  }
}

export class MatchStrategyError extends MatchingError {
  constructor(strategy: string, message: string) {
    super(`${strategy} strategy failed: ${message}`, 'STRATEGY_ERROR')
    this.name = 'MatchStrategyError'
    Object.setPrototypeOf(this, MatchStrategyError.prototype)
  }
}

export class NoApplicableStrategyError extends MatchingError {
  constructor(message: string) {
    super(message, 'NO_APPLICABLE_STRATEGY')
    this.name = 'NoApplicableStrategyError'
    Object.setPrototypeOf(this, NoApplicableStrategyError.prototype)
  }
}

export class ProviderQuotaError extends MatchingError {
  retryAfter?: number

  constructor(provider: string, retryAfter?: number) {
    super(`${provider} quota exceeded`, 'QUOTA_EXCEEDED')
    this.name = 'ProviderQuotaError'
    this.retryAfter = retryAfter
    Object.setPrototypeOf(this, ProviderQuotaError.prototype)
  }
}
