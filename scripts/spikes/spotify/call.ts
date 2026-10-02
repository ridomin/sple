// Spike harness: raw authenticated request; dumps response to out/<spike>-<n>.json (git-ignored).
// Usage: npx tsx scripts/spikes/spotify/call.ts --token <file> --spike <name> [--method GET] [--body '<json>'] <path-or-url>
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const tokenFile = arg('token')
const spike = arg('spike')
const method = (arg('method') ?? 'GET').toUpperCase()
const body = arg('body')
const target = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--')).pop()
if (!tokenFile || !spike || !target || !/^[\w.-]+$/.test(spike)) {
  console.error('Usage: npx tsx scripts/spikes/spotify/call.ts --token <file> --spike <name> [--method GET] [--body json] <path-or-url>')
  process.exit(2)
}

const accessToken = (JSON.parse(readFileSync(tokenFile, 'utf8')) as { access_token: string }).access_token
const url = target.startsWith('http') ? target : `https://api.spotify.com/v1/${target.replace(/^\//, '')}`

const resp = await fetch(url, {
  method,
  headers: {
    authorization: `Bearer ${accessToken}`,
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  body,
})
const text = await resp.text()
let parsed: unknown = text
try { parsed = JSON.parse(text) } catch { /* keep raw text */ }

const headers: Record<string, string> = {}
resp.headers.forEach((v, k) => { if (k.toLowerCase() !== 'authorization') headers[k] = v })

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(outDir, { recursive: true })
const n = readdirSync(outDir).filter((f) => f.startsWith(`${spike}-`) && f.endsWith('.json')).length + 1
const file = join(outDir, `${spike}-${n}.json`)
writeFileSync(file, JSON.stringify({ request: { method, url }, status: resp.status, headers, body: parsed }, null, 2))
console.log(`${method} ${url} -> ${resp.status}; dumped to ${file}`)
