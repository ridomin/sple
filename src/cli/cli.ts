#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { loadConfig, loadEnvFile, PROVIDER_IDS } from './config.js'
import { EXIT_CODES, getExitCode, formatErrorMessage } from './exit-codes.js'
import { createDefaultRegistry, type ProviderRegistry } from './provider-registry.js'
import { readPackageVersion } from './version.js'
import { UsageError } from '../core/provider/errors.js'

export interface CliIO {
  out: (msg: string) => void
  err: (msg: string) => void
}

export const COMMANDS = ['auth', 'search', 'playlist', 'export', 'import', 'migrate'] as const

export function helpText(version: string): string {
  return `sple v${version}

Usage: sple <command> [options]

Commands:
  auth       Authentication and account management
  search     Search the provider catalog
  playlist   Playlist management
  export     Export playlists to files
  import     Import playlists from files
  migrate    Migrate playlists between providers

Options:
  --provider <name>  Specify the provider (${PROVIDER_IDS.join(', ')}); default: spotify
  --no-browser       auth login: don't open a browser (URL is printed; listener still runs)
  --manual           auth login: no listener; paste the redirect URL from the browser
  --all              auth logout: log out of every provider
  --json             auth status: JSON output
  --verbose          Enable verbose output (stderr)
  --help, -h         Show this help message
  --version, -v      Show version number
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
    let parsed
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          provider: { type: 'string' },
          'no-browser': { type: 'boolean' },
          manual: { type: 'boolean' },
          all: { type: 'boolean' },
          json: { type: 'boolean' },
          verbose: { type: 'boolean' },
          version: { type: 'boolean', short: 'v' },
          help: { type: 'boolean', short: 'h' },
        },
      })
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e))
    }
    const { values, positionals } = parsed

    if (values.version) {
      io.out(`sple v${version}`)
      return EXIT_CODES.SUCCESS
    }
    if (values.help || positionals.length === 0) {
      io.out(helpText(version))
      return EXIT_CODES.SUCCESS
    }

    const config = loadConfig({ provider: values.provider, verbose: values.verbose }, opts.env)
    const registry = opts.registry ?? createDefaultRegistry()
    if (!registry.has(config.provider)) {
      throw new UsageError(`Unknown provider '${config.provider}'`)
    }

    const command = positionals[0]
    if (!(COMMANDS as readonly string[]).includes(command)) {
      throw new UsageError(`Unknown command: ${command}. Run "sple --help" for usage information`)
    }
    if (config.verbose) io.err(`[sple] provider=${config.provider} command=${command}`)

    if (command === 'auth') {
      const { handleAuthCommand } = await import('./commands/auth.js')
      return await handleAuthCommand(
        positionals.slice(1),
        {
          registry,
          config,
          providerExplicit: values.provider !== undefined,
          noBrowser: values['no-browser'],
          manual: values.manual,
          json: values.json,
          all: values.all,
        },
        io
      )
    }

    // Other commands arrive in M1.
    throw new UsageError(`Command '${command}' is not implemented yet`)
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
