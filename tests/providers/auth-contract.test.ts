import { readFileSync } from 'node:fs'
import { runAuthContract } from './auth-contract.js'
import { SpotifyAuth, SPOTIFY_ME_URL, SPOTIFY_TOKEN_URL } from '../../src/providers/spotify/auth.js'
import { SPOTIFY_LOGIN_SCOPES } from '../../src/providers/spotify/scopes.js'
import { YouTubeMusicAuth } from '../../src/providers/youtube-music/auth.js'

// Recorded, sanitized responses; see the README in each fixtures directory.
const fixture = (path: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')) as Record<string, unknown>

runAuthContract({
  name: 'Spotify',
  providerId: 'spotify',
  create: (dir) => new SpotifyAuth('contract-client-id', dir),
  requestedScopes: SPOTIFY_LOGIN_SCOPES,
  tokenUrl: SPOTIFY_TOKEN_URL,
  identityUrl: SPOTIFY_ME_URL,
  tokenBody: fixture('spotify/oauth-token.json'),
  identityBody: fixture('spotify/oauth-me.json'),
})

runAuthContract({
  name: 'YouTube Music',
  providerId: 'youtube-music',
  create: (dir) => new YouTubeMusicAuth('contract-client-id', 'contract-client-secret', dir),
  requestedScopes: ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/userinfo.profile'],
  tokenUrl: 'https://oauth2.googleapis.com/token',
  identityUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  tokenBody: fixture('google/oauth-token-refresh.json'),
  identityBody: fixture('google/oauth-userinfo.json'),
})
