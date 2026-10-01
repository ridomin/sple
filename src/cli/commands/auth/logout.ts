import type { Provider } from '../../../core/provider/provider.js'
import type { CliIO } from '../../cli.js'
import { formatErrorMessage, getExitCode, EXIT_CODES } from '../../exit-codes.js'

/** Implement `sple auth logout [--provider X]`. (`--all` is handled in Task 5.) */
export async function handleLogout(provider: Provider, io: CliIO): Promise<number> {
  try {
    const result = await provider.auth.logout()

    if (result.revoked) {
      io.out(`Revoked access with ${provider.displayName}`)
    } else {
      io.out(`Logged out from ${provider.displayName}`)
    }
    if (result.deletedData.length > 0) {
      io.out(`Deleted: ${result.deletedData.join(', ')}`)
    }
    return EXIT_CODES.SUCCESS
  } catch (error) {
    io.err(`Logout failed: ${formatErrorMessage(error)}`)
    return getExitCode(error)
  }
}
