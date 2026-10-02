import { createInterface } from 'node:readline/promises'
import type { LoginInteraction, Provider } from '../../../core/provider/provider.js'
import type { AuthMode } from '../../../core/auth/oauth-handler.js'
import { openBrowser as defaultOpenBrowser } from '../../../core/auth/browser.js'
import type { CliIO } from '../../cli.js'
import { formatErrorMessage, getExitCode, EXIT_CODES } from '../../exit-codes.js'

export interface LoginOptions {
  mode?: AuthMode
  /** Injected for tests; defaults to the `open`-based opener. Must not throw. */
  openBrowser?: (url: string, opts: { onWarning: (m: string) => void }) => Promise<void>
  /** Injected for tests; defaults to reading one line from stdin. */
  readLine?: (prompt: string) => Promise<string>
}

/** Read one line from stdin, writing the prompt to stderr (stdout stays clean). */
async function readLineFromStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false })
  try {
    // A pending question() never settles if stdin hits EOF, so race it with 'close'.
    const closed = new Promise<never>((_, reject) => {
      rl.once('close', () => reject(new Error('No redirect URL received (stdin closed)')))
    })
    return await Promise.race([rl.question(prompt), closed])
  } finally {
    rl.close()
  }
}

/** Build the CLI side of the login: print URL, open browser, read pasted URL. */
export function createLoginInteraction(io: CliIO, opts: LoginOptions = {}): LoginInteraction {
  const open = opts.openBrowser ?? defaultOpenBrowser
  const readLine = opts.readLine ?? readLineFromStdin
  return {
    async showAuthorizationUrl(url, mode) {
      // Always print the URL first so the user can recover if the browser fails.
      io.err('Open this URL in your browser to authorize sple:')
      io.err(url)
      if (mode === 'loopback') {
        await open(url, { onWarning: (m) => io.err(m) })
      }
      if (mode === 'manual') {
        io.err('After approving, the browser will fail to load http://127.0.0.1/callback.')
        io.err('Copy the full URL from the address bar and paste it below.')
      } else {
        io.err('Waiting for authorization...')
      }
    },
    promptForRedirectUrl(prompt) {
      return readLine(prompt)
    },
  }
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
    const status = await provider.auth.login({
      mode,
      scopes: [],
      interaction: createLoginInteraction(io, opts),
    })

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
