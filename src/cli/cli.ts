#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { loadConfig, loadEnvFile, envFilePermissionWarning, PROVIDER_IDS } from './config.js'
import { EXIT_CODES, getExitCode, formatErrorMessage, formatErrorOutput } from './exit-codes.js'
import { createDefaultRegistry, type ProviderRegistry } from './provider-registry.js'
import { readPackageVersion } from './version.js'
import { UsageError } from '../core/provider/errors.js'
import type { Config } from './config.js'
import { redact, formatHttpLine } from './log.js'
import type { HttpLogEntry } from '../core/http/client.js'

export interface CliIO {
  out: (msg: string) => void
  err: (msg: string) => void
}

export interface CommandContext {
  registry: ProviderRegistry
  config: Config
  io: CliIO
  version: string
  json: boolean
  quiet: boolean
  debug: boolean
  yes: boolean
}

export interface CommandModule {
  name: string
  summary: string
  usage: string
  options?: Record<string, { type: string; description?: string }>
  run(ctx: CommandContext, args: string[]): Promise<number>
}

export interface CommandGroupModule {
  name: string
  summary: string
  commands: Record<string, () => Promise<CommandModule>>
}

const MAIN_COMMANDS = ['auth', 'search', 'playlist', 'export', 'import', 'migrate'] as const
const LEGACY_COMMANDS = ['migrate'] as const

function rootHelpText(version: string): string {
  return `sple v${version}

Usage: sple [options] <command> [command-options]

Commands:
  auth       Authentication and account management
  search     Search the provider catalog
  playlist   Playlist management
  export     Export playlists to files
  import     Import playlists from files
  migrate    Migrate playlists between providers (available in a later release)

Global Options:
  --provider <name>  Specify the provider (${PROVIDER_IDS.join(', ')}); default: spotify
  --json             Output in JSON format
  --quiet            Quiet mode (IDs only)
  --verbose          Enable verbose output (stderr)
  --debug            Enable HTTP debug logs
  --yes              Automatically confirm prompts
  --help, -h         Show this help message
  --version, -v      Show version number

Examples:
  sple auth login
  sple --provider spotify search track "hello world"
  sple playlist list
`
}

export interface RunOptions {
  io?: CliIO
  env?: NodeJS.ProcessEnv
  registry?: ProviderRegistry
  version?: string
}

/** Run the CLI and return the process exit code. Never calls process.exit. */
export async function run(argv: string[], opts: RunOptions = {}): Promise<number> {
  const io: CliIO = opts.io ?? {
    out: (m) => console.log(m),
    err: (m) => console.error(m),
  }
  const version = opts.version ?? readPackageVersion()

  let jsonErrors = false
  try {
    const { values, rest } = extractGlobalFlags(argv)
    jsonErrors = values.json === true

    if (values.version) {
      io.out(`sple v${version}`)
      return EXIT_CODES.SUCCESS
    }

    const [command, ...commandArgs] = rest

    const config = loadConfig(
      {
        provider: values.provider,
        verbose: values.verbose === true || values.debug === true,
      },
      opts.env
    )
    // --debug: one redacted line per HTTP attempt on stderr (ADR 0007 §6).
    const onHttp = values.debug === true ? (entry: HttpLogEntry) => io.err(formatHttpLine(entry)) : undefined
    const registry = opts.registry ?? createDefaultRegistry({ onHttp })
    if (!registry.has(config.provider)) {
      throw new UsageError(`Unknown provider '${config.provider}'`)
    }

    if (!command) {
      if (values.help) {
        io.out(rootHelpText(version))
        return EXIT_CODES.SUCCESS
      }
      io.out(rootHelpText(version))
      return EXIT_CODES.SUCCESS
    }

    if (!(MAIN_COMMANDS as readonly string[]).includes(command)) {
      throw new UsageError(
        `Unknown command: ${command}. Run "sple --help" for usage information`
      )
    }

    if ((LEGACY_COMMANDS as readonly string[]).includes(command)) {
      throw new UsageError(
        `Command '${command}' is available in a later release`
      )
    }

    if (config.verbose) io.err(redact(`sple:cli provider=${config.provider} command=${command}`))

    // Validate mutually exclusive flags
    if (values.json && values.quiet) {
      throw new UsageError('--json and --quiet cannot be used together')
    }

    // Create command context
    const ctx: CommandContext = {
      registry,
      config,
      io,
      version,
      json: values.json === true,
      quiet: values.quiet === true,
      debug: values.debug === true,
      yes: values.yes === true,
    }

    // Route to command handler
    if (command === 'auth') {
      const { handleAuthCommand, USAGE: AUTH_USAGE } = await import('./commands/auth.js')
      // Global flags (incl. --provider and --json) were already extracted from
      // anywhere in argv; only auth-specific flags remain (ADR 0007 §1).
      let authParsed
      try {
        authParsed = parseArgs({
          args: commandArgs,
          allowPositionals: true,
          strict: true,
          options: {
            'no-browser': { type: 'boolean' },
            manual: { type: 'boolean' },
            all: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
          },
        })
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e))
      }
      if (authParsed.values.help) {
        io.out(AUTH_USAGE)
        return EXIT_CODES.SUCCESS
      }
      return await handleAuthCommand(
        authParsed.positionals,
        {
          registry,
          config,
          providerExplicit: values.provider !== undefined,
          noBrowser: authParsed.values['no-browser'],
          manual: authParsed.values.manual,
          json: values.json,
          all: authParsed.values.all,
        },
        io
      )
    }

    if (command === 'search') {
      const mod = await import('./commands/search.js')
      return await mod.run(ctx, commandArgs)
    }

    if (command === 'playlist') {
      const mod = await import('./commands/playlist/index.js')
      return await mod.handlePlaylistCommand(ctx, commandArgs)
    }

    if (command === 'export') {
      const mod = await import('./commands/export.js')
      return await mod.run(ctx, commandArgs)
    }

    if (command === 'import') {
      const mod = await import('./commands/import.js')
      return await mod.run(ctx, commandArgs)
    }

    throw new UsageError(`Command '${command}' is not implemented`)
  } catch (error) {
    const exitCode = getExitCode(error)
    io.err(redact(`sple: ${formatErrorMessage(error)}`))
    if (jsonErrors) io.err(formatErrorOutput(error, exitCode))
    return exitCode
  }
}

const GLOBAL_BOOLEAN_FLAGS = {
  '--json': 'json',
  '--quiet': 'quiet',
  '--verbose': 'verbose',
  '--debug': 'debug',
  '--yes': 'yes',
} as const

export interface GlobalFlagValues {
  provider?: string
  json?: boolean
  quiet?: boolean
  verbose?: boolean
  debug?: boolean
  yes?: boolean
  help?: boolean
  version?: boolean
}

/**
 * Pull the global flags (ADR 0007 §1) out of argv, wherever they appear
 * before `--`: `sple --provider fake auth logout` and
 * `sple auth logout --provider fake` mean the same thing. Everything else,
 * in order, is returned in `rest` for the command's own strict parse.
 *
 * `--help`/`-h` is global only before the command; after it, it stays in
 * `rest` so the command prints its own help.
 */
export function extractGlobalFlags(argv: string[]): { values: GlobalFlagValues; rest: string[] } {
  const values: GlobalFlagValues = {}
  const rest: string[] = []
  let commandSeen = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      rest.push(...argv.slice(i))
      break
    }
    if (arg === '--provider') {
      const value = argv[i + 1]
      if (value === undefined || value === '--' || value.startsWith('-')) {
        throw new UsageError("Option '--provider <name>' argument missing")
      }
      values.provider = value
      i++
      continue
    }
    if (arg.startsWith('--provider=')) {
      const value = arg.slice('--provider='.length)
      if (!value) throw new UsageError("Option '--provider <name>' argument missing")
      values.provider = value
      continue
    }
    if (arg in GLOBAL_BOOLEAN_FLAGS) {
      values[GLOBAL_BOOLEAN_FLAGS[arg as keyof typeof GLOBAL_BOOLEAN_FLAGS]] = true
      continue
    }
    if (arg === '--version' || arg === '-v') {
      values.version = true
      continue
    }
    if (!commandSeen) {
      if (arg === '--help' || arg === '-h') {
        values.help = true
        continue
      }
      if (arg.startsWith('-')) {
        throw new UsageError(`Unknown option '${arg}'. Run "sple --help" for usage information`)
      }
      commandSeen = true
    }
    rest.push(arg)
  }
  return { values, rest }
}

function isMain(): boolean {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMain()) {
  try {
    if (loadEnvFile()) {
      const warning = envFilePermissionWarning()
      if (warning) console.error(warning)
    }
  } catch (e) {
    console.error(`Failed to load .env: ${formatErrorMessage(e)}`)
  }
  process.exitCode = await run(process.argv.slice(2))
}
