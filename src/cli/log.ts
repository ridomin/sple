import type { CommandContext } from './cli.js'

/**
 * Redaction function per ADR-0007 §6.
 * Redacts sensitive information from log lines and error messages.
 */
export function redact(text: string): string {
  if (!text) return text

  let result = text

  // Redact "Bearer <token>"
  result = result.replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')

  // Redact query/form parameters: access_token, refresh_token, code, code_verifier, client_secret
  result = result.replace(/\b(access_token|refresh_token|code|code_verifier|client_secret)=[^&\s]+/g, '$1=[REDACTED]')

  // Redact JSON fields: "access_token", "refresh_token", "id_token", "client_secret"
  result = result.replace(/"(access_token|refresh_token|id_token|client_secret)"\s*:\s*"[^"]*"/g, '"$1":"[REDACTED]"')

  return result
}

/**
 * Logger interface for creating namespaced loggers.
 */
export interface Logger {
  info(message: string): void
  debug(message: string): void
  error(message: string): void
  warn(message: string): void
}

/**
 * Create a logger with the given namespace.
 * Logs are written to stderr with the format: sple:<namespace> <message>
 * All messages are redacted before output.
 */
export function createLogger(namespace: string, ctx: CommandContext): Logger {
  const prefix = `sple:${namespace}`
  const isVerbose = ctx.config.verbose || ctx.debug
  const isDebug = ctx.debug

  return {
    info(message: string) {
      if (isVerbose) {
        ctx.io.err(`${prefix} ${redact(message)}`)
      }
    },
    debug(message: string) {
      if (isDebug) {
        ctx.io.err(`${prefix} ${redact(message)}`)
      }
    },
    error(message: string) {
      // Errors always output, but redacted
      ctx.io.err(`${prefix} ${redact(message)}`)
    },
    warn(message: string) {
      // Warnings always output, but redacted
      ctx.io.err(`${prefix} warning: ${redact(message)}`)
    },
  }
}

/**
 * Log an HTTP request/response for --debug mode.
 * Format: sple:http <method> <path> <status> <duration>ms [<retryCount> retries]
 */
export function logHttpCall(
  ctx: CommandContext,
  method: string,
  path: string,
  status: number | string,
  durationMs: number,
  retryCount?: number
): void {
  if (ctx.debug) {
    const retryPart = retryCount && retryCount > 0 ? ` ${retryCount} retries` : ''
    ctx.io.err(`sple:http ${method} ${path} ${status} ${durationMs}ms${retryPart}`)
  }
}

/**
 * Configure global logging based on context flags.
 * Maps --verbose to info logs and --debug to all logs including HTTP.
 */
export function setupGlobalLogging(ctx: CommandContext): void {
  // Future: could set up a global debug namespace handler here
  // For now, individual loggers handle the verbose/debug flags
}
