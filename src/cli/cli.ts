#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { loadConfig, loadEnvFile, PROVIDER_IDS } from './config.js'
import { EXIT_CODES, getExitCode, formatErrorMessage } from './exit-codes.js'
import { createDefaultRegistry, type ProviderRegistry } from './provider-registry.js'
import { readPackageVersion } from './version.js'
import { UsageError } from '../core/provider/errors.js'
import type { Config } from './config.js'

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
const LEGACY_COMMANDS = ['import', 'migrate'] as const

function rootHelpText(version: string): string {
  return `sple v${version}

Usage: sple [options] <command> [command-options]

Commands:
  auth       Authentication and account management
  search     Search the provider catalog
  playlist   Playlist management
  export     Export playlists to files
  import     Import playlists from files (available in a later release)
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

  try {
    // Handle --version and --help at the root level
    if (argv.includes('--version') || argv.includes('-v')) {
      io.out(`sple v${version}`)
      return EXIT_CODES.SUCCESS
    }

    // Manually extract global flags to avoid consuming command-specific flags
    let parsed
    const globalFlagIndices: number[] = []
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === '--provider' && i + 1 < argv.length) {
        globalFlagIndices.push(i, i + 1)
        i++ // Skip the next value
      } else if (arg === '--json' || arg === '--quiet' || arg === '--verbose' || arg === '--debug' || arg === '--yes' || arg === '--help' || arg === '-h') {
        globalFlagIndices.push(i)
      } else if (arg.startsWith('-')) {
        // Unknown global flag, let parseArgs handle it for error
        break
      } else {
        // Found the command, stop looking for global flags
        break
      }
    }

    const globalArgs = globalFlagIndices.map((i) => argv[i])
    const commandAndArgs = argv.filter((_, i) => !globalFlagIndices.includes(i))

    try {
      parsed = parseArgs({
        args: globalArgs,
        allowPositionals: false,
        options: {
          provider: { type: 'string' },
          json: { type: 'boolean' },
          quiet: { type: 'boolean' },
          verbose: { type: 'boolean' },
          debug: { type: 'boolean' },
          yes: { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
      })
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e))
    }
    const { values } = parsed
    const [command, ...commandArgs] = commandAndArgs

    const config = loadConfig(
      {
        provider: values.provider,
        verbose: values.verbose,
      },
      opts.env
    )
    const registry = opts.registry ?? createDefaultRegistry()
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

    if (config.verbose) io.err(`[sple] provider=${config.provider} command=${command}`)

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
      const { handleAuthCommand } = await import('./commands/auth.js')
      // Parse auth-specific flags from commandArgs
      let authParsed
      try {
        authParsed = parseArgs({
          args: commandArgs,
          allowPositionals: true,
          options: {
            provider: { type: 'string' },
            'no-browser': { type: 'boolean' },
            manual: { type: 'boolean' },
            json: { type: 'boolean' },
            all: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
          },
          strict: false,
        })
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e))
      }
      return await handleAuthCommand(
        authParsed.positionals,
        {
          registry,
          config,
          providerExplicit: values.provider !== undefined,
          noBrowser: typeof authParsed.values['no-browser'] === 'boolean' ? authParsed.values['no-browser'] : undefined,
          manual: typeof authParsed.values.manual === 'boolean' ? authParsed.values.manual : undefined,
          json: typeof authParsed.values.json === 'boolean' ? authParsed.values.json : undefined,
          all: typeof authParsed.values.all === 'boolean' ? authParsed.values.all : undefined,
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

    throw new UsageError(`Command '${command}' is not implemented`)
  } catch (error) {
    io.err(formatErrorMessage(error))
    return getExitCode(error)
  }
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
    loadEnvFile()
  } catch (e) {
    console.error(`Failed to load .env: ${formatErrorMessage(e)}`)
  }
  process.exitCode = await run(process.argv.slice(2))
}
