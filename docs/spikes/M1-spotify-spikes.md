# M1 Spotify spikes (S1-S4)

- **Date:** 2026-10-02
- **App mode:** Spotify Development Mode
- **Account types:** Premium (all spikes; no non-Premium account or app was available)
- **Related:** [requirements §8 and §10](../requirements.md), [ADR-0003 §5 and Amendment 1](../adr/0003-provider-interface-and-capabilities.md)
- **Fixtures:** sanitized responses in [`tests/fixtures/spotify/`](../../tests/fixtures/spotify/README.md)

| Spike | Status | Decision |
|---|---|---|
| S1 ISRC search | Verified | `isrcSearchMode: 'filter'` |
| S2 Collaborator access | Verified | `playlistItemsAccess: 'owned-or-collaborator'` |
| S3 Page-size limits | Verified | NFR-5 feasible; limits recorded below |
| S4 Premium detection | **Unverified** | Fallback heuristic (below) |

## S1: ISRC search filter

| Item | Result |
|---|---|
| Method | `GET /search?q=isrc:<ISRC>&type=track` for 5 ISRCs (Blinding Lights, Hello, Shape of You, bad guy, Uptown Funk) |
| Result | 5 of 5 returned the expected track |
| `external_ids.isrc` | Present on every returned track; value matched the query |
| Decision | `isrcSearchMode: 'filter'` |
| Fixtures | `search-isrc-bl.json`, `search-isrc-hello.json`, `search-isrc-shape.json`, `search-isrc-badguy.json`, `search-isrc-uptown.json` |

Finding: the February 2026 note that `external_ids` was removed does not hold for search results here, so ISRC stays available as an optional match field (FR-MIG-2).

## S2: Collaborator access to playlist items

| Playlist kind | `GET /playlists/{id}/items` | Readable |
|---|---|---|
| Owned | 200 with items | yes |
| Collaborative (user is collaborator, not owner) | 200 with items | yes |
| Followed, non-collaborative | 403 | no |
| Editorial (Spotify-owned) | 404 | no |

- Not-readable signal: 403 on `/playlists/{id}/items`, or 200 on `/playlists/{id}` with no `items` key.
- Detection: compare `owner.id` with the current user's ID (`GET /me`), and for non-owned playlists probe `/items` and treat 403/404 as not readable. Do not rely on the `collaborative` flag.
- Decision: `playlistItemsAccess: 'owned-or-collaborator'`. Readability of a non-owned playlist is decided at read time from the probe.
- Fixtures: `s2-owned-{pl,items}.json`, `s2-collab-{pl,items}.json`, `s2-followed-{pl,items}.json`, `s2-editorial-{pl,items}.json`

## S3: Page-size limits

| Endpoint | Max `limit` |
|---|---|
| `GET /me/playlists` | 50 |
| `GET /me/tracks` | 50 |
| `GET /playlists/{id}/items` | 100 |
| `GET /search` | 10 |

- Search is capped at `limit + offset <= 1000`, a hard ceiling for any `--all` search pagination.
- Performance for 1,000 tracks: about 2-4 s sequential, under 1 s parallel. This is well under the 15 s budget, so NFR-5 is feasible. NFR-5's assumption of 50 is conservative for playlist items (100 is available).

## S4: Premium detection (unverified)

No non-Premium app or account was available, so the error for a missing Premium subscription was not observed.

Fallback heuristic until verified: treat a 403 whose `error.message` matches `/premium/i` as "Premium required" and map it to `AccessRestrictedError` with `reason: 'premium-required'` (FR-AUTH-2 message). Any other 403 is reported as a generic access error. Re-verify when a non-Premium app is available.
