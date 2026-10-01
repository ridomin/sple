import { readFileSync } from 'node:fs'

/**
 * Read the package version from package.json. Works from both src/cli and
 * dist/cli since package.json is two directories up in either layout.
 */
export function readPackageVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown }
    if (typeof pkg.version === 'string') return pkg.version
  } catch {
    // fall through
  }
  return 'unknown'
}
