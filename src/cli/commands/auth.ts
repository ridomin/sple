import type { AuthMode } from '../../core/auth/oauth-handler.js'
import type { CliIO } from '../cli.js'
import type { Config } from '../config.js'
import type { ProviderRegistry } from '../provider-registry.js'
import { handleLogin } from './auth/login.js'
import { handleStatus } from './auth/status.js'
import { handleLogout } from './auth/logout.js'
import { resolveAllTargets, resolveTarget } from './auth/targets.js'
import { UsageError } from '../../core/provider/errors.js'

export const USAGE =
  'Usage: sple auth login [--provider <name>] [--no-browser | --manual]\n' +
  '       sple auth status [--provider <name>] [--json]\n' +
  '       sple auth logout [--provider <name> | --all]'

export interface AuthCommandContext {
  registry: ProviderRegistry
  config: Config
  /** True when `--provider` was given on the command line. */
  providerExplicit: boolean
  noBrowser?: boolean
  manual?: boolean
  json?: boolean
  all?: boolean
}

/** Route `sple auth <subcommand>`. `args` are the positionals after "auth". */
export async function handleAuthCommand(
  args: string[],
  ctx: AuthCommandContext,
  io: CliIO
): Promise<number> {
  const [subcommand, ...extra] = args
  if (subcommand === undefined) throw new UsageError(USAGE)
  if (!['login', 'status', 'logout'].includes(subcommand)) {
    throw new UsageError(`Unknown auth subcommand: ${subcommand}\n${USAGE}`)
  }
  if (extra.length > 0) {
    throw new UsageError(`Unexpected argument: ${extra[0]}\n${USAGE}`)
  }
  if ((ctx.noBrowser || ctx.manual) && subcommand !== 'login') {
    throw new UsageError('--no-browser and --manual only apply to "auth login"')
  }
  if (ctx.json && subcommand !== 'status') {
    throw new UsageError(`--json is not supported by "auth ${subcommand}"`)
  }
  if (ctx.all && subcommand !== 'logout') {
    throw new UsageError('--all only applies to "auth logout"')
  }

  switch (subcommand) {
    case 'login': {
      if (ctx.noBrowser && ctx.manual) {
        throw new UsageError('--no-browser and --manual cannot be used together')
      }
      const mode: AuthMode = ctx.noBrowser ? 'no-browser' : ctx.manual ? 'manual' : 'loopback'
      const provider = ctx.registry.create(ctx.config.provider, ctx.config)
      return handleLogin(provider, io, { mode })
    }
    case 'status': {
      const targets = ctx.providerExplicit
        ? [resolveTarget(ctx.registry, ctx.config, ctx.config.provider)]
        : resolveAllTargets(ctx.registry, ctx.config)
      return handleStatus(targets, io, { json: ctx.json })
    }
    default: {
      if (ctx.all && ctx.providerExplicit) {
        throw new UsageError('Use either --provider or --all with "auth logout", not both')
      }
      const targets = ctx.all
        ? resolveAllTargets(ctx.registry, ctx.config)
        : [resolveTarget(ctx.registry, ctx.config, ctx.config.provider)]
      return handleLogout(targets, io)
    }
  }
}
