import type { Provider } from '../../../core/provider/provider.js'
import type { CliIO } from '../../cli.js'
import { formatErrorMessage, getExitCode, EXIT_CODES } from '../../exit-codes.js'

const EXPIRY_WARN_MS = 5 * 60 * 1000

/** Implement `sple auth status [--provider X]`. */
export async function handleStatus(provider: Provider, io: CliIO): Promise<number> {
  try {
    const status = await provider.auth.status()

    if (!status.loggedIn) {
      io.err(`Not logged in to ${provider.displayName}`)
      return EXIT_CODES.AUTH_REQUIRED
    }

    if (status.user) {
      io.out(`User: ${status.user.displayName || status.user.id}`)
    }
    io.out(`Scopes: ${status.scopes.join(', ') || '(none)'}`)

    if (status.expiresAt) {
      io.out(`Token expires: ${status.expiresAt}`)
      const expiresMs = new Date(status.expiresAt).getTime() - Date.now()
      if (expiresMs < EXPIRY_WARN_MS) {
        io.err('⚠️ Token expires in less than 5 minutes')
      }
    }
    return EXIT_CODES.SUCCESS
  } catch (error) {
    io.err(`Status check failed: ${formatErrorMessage(error)}`)
    return getExitCode(error)
  }
}
