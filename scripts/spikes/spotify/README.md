# Spotify spike harness

Standalone scripts for probing the live Spotify API (Development Mode app, Premium account).
Never shipped, never run in CI. Excluded from `tsc` (`rootDir`/`include` is `src/`) and from `npm test` (`tests/**`).

## Run

```sh
export SPLE_SPOTIFY_CLIENT_ID=<your dev-mode app client id>
# Register http://127.0.0.1:8888/callback as a redirect URI in the Spotify dashboard
npx tsx scripts/spikes/spotify/login.ts --out /tmp/spotify-spike-token.json
npx tsx scripts/spikes/spotify/call.ts --token /tmp/spotify-spike-token.json --spike me me
npx tsx scripts/spikes/spotify/sanitize.ts scripts/spikes/spotify/out/me-1.json fixture.json
```

- `login.ts` prints an authorize URL; open it in a browser. Listens on `127.0.0.1` (not `localhost`). Refuses `tokens.json` as output.
- `call.ts` dumps status, headers (minus `authorization`) and body to `out/<spike>-<n>.json`.
- `sanitize.ts` redacts tokens, `Bearer` values, user IDs, display names, emails and image URLs.

## What not to commit

- Anything in `out/` (raw responses contain PII) - git-ignored.
- Token files (`*.token.json`, `spike-token*.json`) - prefer writing them outside the repo, e.g. `/tmp`.
- Unsanitized dumps. Always run `sanitize.ts` and eyeball the result before turning it into a fixture.
- Client secrets or `.env` files.
