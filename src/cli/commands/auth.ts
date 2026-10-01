import type { Provider } from '../../core/provider/provider.js'
import type { AuthMode } from '../../core/auth/oauth-handler.js'
import type { CliIO } from '../cli.js'
import { handleLogin } from './auth/login.js'
import { handleStatus } from './auth/status.js'
import { handleLogout } from './auth/logout.js'
import { UsageError } from '../../core/provider/errors.js'

const USAGE = 'Usage: sple auth <login|status|logout> [--provider <name>] [--no-browser | --manual]'

/**
 * Route `sple auth <subcommand>`. `args` are the arguments after "auth":
 * the subcommand plus any --no-browser / --manual flags.
 */
export async function handleAuthCommand(
  args: string[],
  provider: Provider,
  io: CliIO
): Promise<number> {
  const [subcommand, ...rest] = args
  const noBrowser = rest.includes('--no-browser')
  const manual = rest.includes('--manual')

  if (noBrowser && manual) {
    throw new UsageError('--no-browser and --manual cannot be used together')
  }
  const mode: AuthMode = noBrowser ? 'no-browser' : manual ? 'manual' : 'loopback'

  switch (subcommand) {
    case 'login':
      return handleLogin(provider, io, { mode })
    case 'status':
    case 'logout':
      if (noBrowser || manual) {
        throw new UsageError(`--no-browser and --manual only apply to "auth login"`)
      }
      return subcommand === 'status' ? handleStatus(provider, io) : handleLogout(provider, io)
    case undefined:
      throw new UsageError(USAGE)
    default:
      throw new UsageError(`Unknown auth subcommand: ${subcommand}. ${USAGE}`)
  }
}
