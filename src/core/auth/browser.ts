/**
 * Thin wrapper around the `open` package (WSL-aware) so tests can stub it.
 * Opening the browser is best-effort: a failure is reported as a warning
 * and never thrown, because the authorization URL is always printed too.
 */

/** Launches `url` in the user's browser. Resolves once the launcher has started. */
export type BrowserLauncher = (url: string) => Promise<unknown>

const defaultLauncher: BrowserLauncher = async (url) => {
  const { default: open } = await import('open')
  const child = await open(url)
  // Guard against post-spawn 'error' events crashing the CLI.
  child.on('error', () => {})
  return child
}

let launcher: BrowserLauncher = defaultLauncher

/**
 * Replace the launcher (tests only). Call with no argument to restore
 * the real `open`-based launcher.
 */
export function setBrowserLauncher(fn?: BrowserLauncher): void {
  launcher = fn ?? defaultLauncher
}

export interface OpenBrowserOptions {
  /** Receives a warning message if the browser could not be opened. Defaults to stderr. */
  onWarning?: (message: string) => void
}

/**
 * Try to open `url` in the default browser. Never rejects: on failure the
 * warning callback is invoked and the promise resolves normally.
 */
export async function openBrowser(url: string, opts: OpenBrowserOptions = {}): Promise<void> {
  const warn = opts.onWarning ?? ((m: string) => process.stderr.write(`${m}\n`))
  try {
    await launcher(url)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`Warning: could not open a browser (${reason}). Open the URL above manually.`)
  }
}
