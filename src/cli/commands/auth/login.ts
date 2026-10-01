import type { Provider } from '../../../core/provider/provider.js'
import type { AuthMode } from '../../../core/auth/oauth-handler.js'
import type { CliIO } from '../../cli.js'
import { formatErrorMessage, getExitCode, EXIT_CODES } from '../../exit-codes.js'

export interface LoginOptions {
  mode?: AuthMode
}

/** Implement `sple auth login [--provider X] [--no-browser | --manual]`. */
export async function handleLogin(
  provider: Provider,
  io: CliIO,
  opts: LoginOptions = {}
): Promise<number> {
  const mode: AuthMode = opts.mode ?? 'loopback'

  try {
    // Scopes are decided by the provider adapter when none are requested.
    const status = await provider.auth.login({ mode, scopes: [] })

    io.out(`Logged in to ${provider.displayName}`)
    if (status.user) {
      io.out(`User: ${status.user.displayName || status.user.id}`)
    }
    if (status.scopes.length > 0) {
      io.out(`Scopes: ${status.scopes.join(', ')}`)
    }
    if (status.expiresAt) {
      io.out(`Token expires: ${status.expiresAt}`)
    }
    return EXIT_CODES.SUCCESS
  } catch (error) {
    io.err(`Login failed: ${formatErrorMessage(error)}`)
    return getExitCode(error)
  }
}
