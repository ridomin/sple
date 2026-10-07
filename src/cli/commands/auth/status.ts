import type { AuthStatus } from '../../../core/provider/provider.js'
import type { ProviderId } from '../../../core/provider/capabilities.js'
import { loadTokens } from '../../../core/config/token-store.js'
import type { CliIO } from '../../cli.js'
import { formatErrorMessage, getExitCode, EXIT_CODES } from '../../exit-codes.js'
import type { AuthTarget } from './targets.js'

const EXPIRY_WARN_MS = 5 * 60 * 1000

/** `sple auth status --json` shape (ADR-0007 §3.7). */
export interface AuthStatusOutput {
  providers: Array<{
    id: ProviderId
    loggedIn: boolean
    user?: { id: string; displayName?: string }
    scopes: string[]
    expiresAt?: string
    refreshTokenExpiresAt?: string
  }>
}

export interface StatusOptions {
  json?: boolean
}

/** Status of a provider that could not be constructed, read from the token store. */
function statusFromTokenStore(id: ProviderId): AuthStatus {
  const token = loadTokens(id)
  if (!token) return { loggedIn: false, scopes: [] }
  return {
    loggedIn: true,
    user: { id: token.userId, displayName: token.displayName },
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    refreshTokenExpiresAt: token.refreshTokenExpiresAt,
  }
}

function toEntry(id: ProviderId, s: AuthStatus): AuthStatusOutput['providers'][number] {
  // Optional fields are omitted, not null (ADR-0007 §2.3).
  return {
    id,
    loggedIn: s.loggedIn,
    ...(s.loggedIn && s.user
      ? { user: { id: s.user.id, ...(s.user.displayName ? { displayName: s.user.displayName } : {}) } }
      : {}),
    scopes: s.loggedIn ? s.scopes : [],
    ...(s.loggedIn && s.expiresAt ? { expiresAt: s.expiresAt } : {}),
    ...(s.loggedIn && s.refreshTokenExpiresAt ? { refreshTokenExpiresAt: s.refreshTokenExpiresAt } : {}),
  }
}

function printHuman(target: AuthTarget, s: AuthStatus, io: CliIO): void {
  const label = target.displayName === target.id ? target.id : `${target.displayName} (${target.id})`
  if (!s.loggedIn) {
    io.out(`${label}: not logged in`)
    return
  }
  io.out(`${label}: logged in`)
  if (s.user) {
    const name = s.user.displayName && s.user.displayName !== s.user.id ? `${s.user.displayName} ` : ''
    io.out(`  User: ${name}(${s.user.id})`)
  }
  io.out(`  Scopes: ${s.scopes.join(' ') || '(none)'}`)
  const refreshExpired =
    s.refreshTokenExpiresAt !== undefined && new Date(s.refreshTokenExpiresAt).getTime() <= Date.now()
  if (s.expiresAt) {
    const remaining = new Date(s.expiresAt).getTime() - Date.now()
    if (remaining <= 0) {
      io.out(`  Token expires: ${s.expiresAt} (expired)`)
      // With an expired refresh token it cannot be refreshed; that warning follows below.
      if (!refreshExpired) {
        io.err(`Warning: ${target.displayName} access token has expired; it will be refreshed on next use`)
      }
    } else {
      io.out(`  Token expires: ${s.expiresAt}`)
      if (remaining < EXPIRY_WARN_MS) {
        io.err(`Warning: ${target.displayName} access token expires in less than 5 minutes`)
      }
    }
  }
  if (s.refreshTokenExpiresAt) {
    if (refreshExpired) {
      io.out(`  Refresh token expires: ${s.refreshTokenExpiresAt} (expired)`)
      io.err(`Warning: ${target.displayName} refresh token has expired; run "sple auth login --provider ${target.id}"`)
    } else {
      io.out(`  Refresh token expires: ${s.refreshTokenExpiresAt}`)
    }
  }
}

/**
 * Implement `sple auth status [--provider X] [--json]` (FR-AUTH-4).
 * `targets` is one provider with `--provider`, otherwise every registered one.
 * Exits 0 whether or not a provider is logged in (ADR-0007 §3.7).
 */
export async function handleStatus(
  targets: AuthTarget[],
  io: CliIO,
  opts: StatusOptions = {}
): Promise<number> {
  const results: Array<{ target: AuthTarget; status: AuthStatus }> = []
  let failure: unknown

  for (const target of targets) {
    try {
      const status = target.provider ? await target.provider.auth.status() : statusFromTokenStore(target.id)
      results.push({ target, status })
    } catch (error) {
      io.err(`Status check failed for ${target.displayName}: ${formatErrorMessage(error)}`)
      failure ??= error
    }
  }

  if (failure !== undefined) {
    // A partial table is still useful to a human; --json stdout stays empty on failure.
    if (!opts.json) for (const r of results) printHuman(r.target, r.status, io)
    return getExitCode(failure)
  }

  if (opts.json) {
    const output: AuthStatusOutput = {
      providers: results.map((r) => toEntry(r.target.id, r.status)),
    }
    io.out(JSON.stringify(output, null, 2))
  } else {
    for (const r of results) printHuman(r.target, r.status, io)
  }
  return EXIT_CODES.SUCCESS
}
