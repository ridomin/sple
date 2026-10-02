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

## Sanitization

Produced by the spike sanitizer. User IDs are replaced with `testuser0000000000000` (so owner IDs in the collab and followed fixtures are not the real owners), display names with `Test User`, and image URLs with `example.com`. No tokens or emails are present. Catalog IDs (tracks, albums, artists, playlists) and `snapshot_id` values are public or non-sensitive and kept as recorded.
