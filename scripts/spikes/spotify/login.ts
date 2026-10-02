// Spike harness: standalone PKCE login. Never shipped, not in CI.
// Usage: npx tsx scripts/spikes/spotify/login.ts --out <file> [--port 8888] [--scope "a b"]
// Requires SPLE_SPOTIFY_CLIENT_ID. Register http://127.0.0.1:<port>/callback in the Spotify dashboard.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { generatePKCEPair } from '../../../src/core/auth/oauth-handler.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const out = arg('out')
const clientId = process.env.SPLE_SPOTIFY_CLIENT_ID
const port = Number(arg('port') ?? '8888')
const scope = arg('scope') ??
  'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-library-read user-library-modify'
if (!out || !clientId) {
  console.error('Usage: SPLE_SPOTIFY_CLIENT_ID=... npx tsx scripts/spikes/spotify/login.ts --out <file> [--port 8888]')
  process.exit(2)
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('--port must be an integer between 1 and 65535')
  process.exit(2)
}
if (/(^|[\\/])tokens\.json$/i.test(out)) {
  console.error('Refusing to write to tokens.json; use a scratch file.')
  process.exit(2)
}

const redirectUri = `http://127.0.0.1:${port}/callback`
const { codeVerifier, codeChallenge } = generatePKCEPair()
const state = randomBytes(16).toString('hex')

const authUrl = new URL('https://accounts.spotify.com/authorize')
authUrl.search = new URLSearchParams({
  client_id: clientId,
  response_type: 'code',
  redirect_uri: redirectUri,
  code_challenge_method: 'S256',
  code_challenge: codeChallenge,
  state,
  scope,
}).toString()

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', redirectUri)
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const err = url.searchParams.get('error')
    const c = url.searchParams.get('code')
    const ok = !err && c && url.searchParams.get('state') === state
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' })
    res.end(ok ? 'Login complete. You can close this tab.' : 'Login failed.')
    server.close()
    if (ok) resolve(c)
    else reject(new Error(`Callback failed: ${err ?? 'state mismatch or missing code'}`))
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`Open this URL in a browser:\n\n${authUrl.toString()}\n`)
  })
  server.on('error', reject)
})

const resp = await fetch('https://accounts.spotify.com/api/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  }),
})
const body = (await resp.json()) as Record<string, unknown>
if (!resp.ok) {
  console.error(`Token exchange failed (${resp.status}):`, body.error ?? 'unknown')
  process.exit(1)
}
writeFileSync(out, JSON.stringify({ ...body, obtained_at: Date.now() }, null, 2), { mode: 0o600 })
console.log(`Token written to ${out} (scope: ${String(body.scope)})`)
