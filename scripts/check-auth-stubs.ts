/**
 * Fail when auth code contains unfinished stubs (#74): TODO/FIXME/XXX markers
 * or a bare `void <identifier>` that silences an argument instead of using it.
 * Auth code that cannot be finished yet should throw, never pass silently.
 *
 * Usage: npm run check:stubs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Stub {
  line: number
  text: string
}

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..')

const MARKER = /\b(TODO|FIXME|XXX)\b/
const SILENCED_ARG = /^\s*void\s+[A-Za-z_$][\w$]*\s*;?\s*$/

/** Whether a repo-relative POSIX path is auth code covered by the check. */
export function isAuthFile(path: string): boolean {
  return (
    /^src\/core\/auth\/.+\.ts$/.test(path) ||
    /^src\/providers\/[^/]+\/(auth|scopes)\.ts$/.test(path)
  )
}

/** Lines (1-based) of `source` that look like unfinished stubs. */
export function findStubs(source: string): Stub[] {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => MARKER.test(text) || SILENCED_ARG.test(text))
}

/** Every stub in the repository's auth code, as `path:line: text`. */
export function scanRepo(root: string = REPO_ROOT): string[] {
  const files = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .map((f) => relative(root, join(root, 'src', f)).split(sep).join('/'))
    .filter(isAuthFile)
    .sort()
  return files.flatMap((f) =>
    findStubs(readFileSync(join(root, f), 'utf8')).map((s) => `${f}:${s.line}: ${s.text.trim()}`)
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const found = scanRepo()
  if (found.length > 0) {
    console.error('Unfinished stubs in auth code (finish them, or throw instead):')
    for (const f of found) console.error(`  ${f}`)
    process.exit(1)
  }
}
