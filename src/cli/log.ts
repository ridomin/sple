import { format } from 'node:util'
import createDebug from 'debug'
import type { CommandContext } from './cli.js'

export { formatHttpMessage } from '../core/http/client.js'

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

/** `--verbose`: every sple namespace except HTTP request lines (ADR-0007 A11). */
export const VERBOSE_PATTERN = 'sple:*,-sple:http*'
/** `--debug`: every sple namespace. */
export const DEBUG_PATTERN = 'sple:*'

/**
 * Configure the `debug` package once at startup (ADR-0007 A11). The global
 * output function is replaced first, so every enabled line is redacted and
 * written through `write`; then `DEBUG` and the flag pattern are enabled.
 */
export function setupLogging(opts: {
  verbose: boolean
  debug: boolean
  /** The `DEBUG` environment variable. */
  debugEnv?: string
  write: (line: string) => void
}): void {
  createDebug.log = (...args: unknown[]) => opts.write(redact(format(...args)))
  const flagPattern = opts.debug ? DEBUG_PATTERN : opts.verbose ? VERBOSE_PATTERN : ''
  createDebug.enable([opts.debugEnv, flagPattern].filter(Boolean).join(','))
}

/** A namespaced logger: `info` is a `debug` log on `sple:<namespace>`; warnings and errors always print. */
export interface Logger {
  info(message: string): void
  error(message: string): void
  warn(message: string): void
}

export function createLogger(namespace: string, ctx: CommandContext): Logger {
  const prefix = `sple:${namespace}`
  const debug = createDebug(prefix)

  return {
    info(message: string) {
      // '%s' so a '%' in the message is never read as a format directive.
      debug('%s', message)
    },
    error(message: string) {
      ctx.io.err(`${prefix} ${redact(message)}`)
    },
    warn(message: string) {
      ctx.io.err(`${prefix} warning: ${redact(message)}`)
    },
  }
}
