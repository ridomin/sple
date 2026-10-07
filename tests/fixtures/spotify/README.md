# Spotify fixtures

- **Source:** spike fixtures from milestone M1 (spikes S1 and S2), recorded against the live Spotify Web API in Development Mode with a Premium account. See [docs/spikes/M1-spotify-spikes.md](../../../docs/spikes/M1-spotify-spikes.md).
- **Date:** 2026-10-02
- **Purpose:** test data for validating the Spotify adapter's parsing and access detection.

| Files | Spike | Content |
|---|---|---|
| `search-isrc-{bl,hello,shape,badguy,uptown}.json` | S1 | `isrc:` search results, with `external_ids.isrc` |
| `s2-owned-{pl,items}.json` | S2 | owned playlist (readable) |
| `s2-collab-{pl,items}.json` | S2 | collaborative playlist (readable) |
| `s2-followed-{pl,items}.json` | S2 | followed playlist (`/items` returns 403) |
| `s2-editorial-{pl,items}.json` | S2 | editorial playlist (404) |
| `oauth-me.json` | auth contract (#76) | `GET /v1/me`, recorded 2026-10-07 |
| `oauth-token.json` | auth contract (#76) | **Synthetic, not recorded.** Token response in the shape of Spotify's documented example. A live refresh rotates the user's refresh token, so it isn't recorded. |
| `premium-required.json` | S4 | **Synthetic, not recorded.** Hand-written `GET /me` 403 body used to test the S4 fallback rule (403 + `error.message` matching `/premium/i`). Replace with a sanitized recording once S4 is run with a non-Premium account. |

## Sanitization

Produced by the spike sanitizer. User IDs are replaced with `testuser0000000000000` (so owner IDs in the collab and followed fixtures are not the real owners), display names with `Test User`, and image URLs with `example.com`. No tokens or emails are present. In `oauth-me.json`, `account_id` is replaced with `testaccount`. `email`, `country` and `product` are absent because sple requests neither `user-read-email` nor `user-read-private`. Catalog IDs (tracks, albums, artists, playlists) and `snapshot_id` values are public or non-sensitive and kept as recorded.
