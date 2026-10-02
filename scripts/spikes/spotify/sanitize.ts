// Spike harness: strip PII/secrets from a dump so it can be used as a test fixture.
// Usage: npx tsx scripts/spikes/spotify/sanitize.ts <in.json> [out.json]  (stdout if no out)
import { readFileSync, writeFileSync } from 'node:fs'

const SECRET_KEYS = /^(access_token|refresh_token|id_token|authorization|code|client_secret)$/i
const PII_KEYS: Record<string, string> = {
  display_name: 'Test User',
  email: 'user@example.com',
}

export function sanitizeString(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer REDACTED')
    .replace(/spotify:user:[A-Za-z0-9_.-]+/g, 'spotify:user:testuser0000000000000')
    .replace(/\/users\/[A-Za-z0-9_.-]+/g, '/users/testuser0000000000000')
    .replace(/https:\/\/(?:i\.scdn\.co|mosaic\.scdn\.co|image-cdn[\w.-]*\.spotifycdn\.com|[\w.-]*\.scdn\.co)\/[^\s"]*/g, 'https://example.com/image.jpg')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'user@example.com')
}

export function sanitize(value: unknown, key = '', parentKey = ''): unknown {
  if (Array.isArray(value)) {
    if (key === 'images') return value.map(() => ({ url: 'https://example.com/image.jpg', height: null, width: null }))
    return value.map((v) => sanitize(v, key, key))
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    // Objects that are users (type "user" or having display_name) carry a user ID in `id`
    const isUser = o.type === 'user' || 'display_name' in o
    return Object.fromEntries(
      Object.entries(o).map(([k, v]) => [k, isUser && k === 'id' && typeof v === 'string' ? 'testuser0000000000000' : sanitize(v, k, key)]),
    )
  }
  if (typeof value === 'string') {
    if (SECRET_KEYS.test(key)) return 'REDACTED'
    if (key in PII_KEYS) return PII_KEYS[key]
    // 22-char base62 user id: under owner/user objects or "id" of a user
    if ((key === 'id' && (parentKey === 'owner' || parentKey === 'user')) || key === 'owner_id' || key === 'user_id') {
      return 'testuser0000000000000'
    }
    return sanitizeString(value)
  }
  return value
}

const [inFile, outFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (process.argv[1]?.endsWith('sanitize.ts')) {
  if (!inFile) {
    console.error('Usage: npx tsx scripts/spikes/spotify/sanitize.ts <in.json> [out.json]')
    process.exit(2)
  }
  const result = JSON.stringify(sanitize(JSON.parse(readFileSync(inFile, 'utf8'))), null, 2)
  if (outFile) writeFileSync(outFile, result)
  else console.log(result)
}
