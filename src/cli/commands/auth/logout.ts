import { loadTokens, deleteTokens } from '../../../core/config/token-store.js'
import type { CliIO } from '../../cli.js'
import { formatErrorMessage, getExitCode, EXIT_CODES } from '../../exit-codes.js'
import type { AuthTarget } from './targets.js'

/**
 * Implement `sple auth logout [--provider X | --all]` (FR-AUTH-4, FR-AUTH-6).
 * Only tokens are removed; client configuration is never touched.
 * Every target is attempted; the exit code is that of the first failure.
 */
export async function handleLogout(targets: AuthTarget[], io: CliIO): Promise<number> {
  let failure: unknown

  for (const target of targets) {
    try {
      if (!target.provider) {
        // Not constructible (e.g. no client ID): remove local tokens only.
        if (!loadTokens(target.id)) {
          io.out(`Not logged in to ${target.displayName}`)
          continue
        }
        deleteTokens(target.id)
        io.out(`Logged out from ${target.displayName} (local tokens deleted)`)
        io.err(`Warning: access was not revoked with ${target.displayName}: ${target.unavailable}`)
        continue
      }

      const result = await target.provider.auth.logout()
      io.out(
        result.revoked
          ? `Revoked access with ${target.displayName}`
          : `Logged out from ${target.displayName}`
      )
      if (result.deletedData.length > 0) {
        io.out(`Deleted: ${result.deletedData.join(', ')}`)
      }
      if (result.notice) {
        io.out(result.notice)
      }
    } catch (error) {
      io.err(`Logout failed for ${target.displayName}: ${formatErrorMessage(error)}`)
      failure ??= error
    }
  }

  return failure === undefined ? EXIT_CODES.SUCCESS : getExitCode(failure)
}
