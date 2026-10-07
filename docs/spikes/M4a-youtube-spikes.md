# M4a YouTube spikes (S5–S7)

- **Date:** 2026-10-07
- **Client:** the owner's Google Desktop OAuth client, app in **Testing** status
- **Account:** the owner's Google account (49 YouTube Music likes, 105 liked videos)
- **Related:** [requirements §8](../requirements.md), [ADR 0002 §6](../adr/0002-youtube-music-provider.md) (open item 6), [ADR 0003 §5](../adr/0003-provider-interface-and-capabilities.md)
- **Data handling:** only status codes, counts, reasons and field names were recorded. No titles, IDs or other account content are kept here.

| Spike | Status | Decision |
|---|---|---|
| S5 `LM` playlist through the Data API | Verified | Liked Songs read from `LM`; `likedSongs.read: 'exact'` ([ADR 0002 Amendment 3](../adr/0002-youtube-music-provider.md)) |
| S6 PKCE code exchange without `client_secret` | Verified | Secret stays required; no change ([ADR 0002 Amendment 4](../adr/0002-youtube-music-provider.md)) |
| S7 Daily playlist-creation cap | **Not run** (owner decision) | No change; keep R8 handling |

## S5: `LM` (YouTube Music "Liked Music") through the Data API

| Request | Result |
|---|---|
| `playlistItems.list?playlistId=LM&part=snippet,contentDetails&maxResults=50` | 200, `totalResults` 49, one page |
| `playlists.list?id=LM` | 200, 1 item |
| `channels.list?mine=true&part=contentDetails` → `relatedPlaylists.likes` | `LL` |
| `playlistItems.list?playlistId=LL` | 200, `totalResults` 105 |
| `videos.list?myRating=like` | 200, `totalResults` 105 |

| Check | Result |
|---|---|
| LM ⊆ LL (all pages compared by video ID) | 49 of 49 |
| LM items that are `Private video` / `Deleted video` | 0 |
| LM by `categoryId` (`videos.list` on the 49 IDs) | 10 (Music): 36, 22: 7, 24: 3, 1: 1, 20: 1, 29: 1 |
| LM items from "Artist - Topic" channels | 2 of 49 |
| LL first page by `categoryId` | 10: 23 of 50, the rest spread over 8 other categories |
| `snippet.publishedAt` on LM items | Present (the time the song was liked) |

**Findings**

- The Data API serves `LM` with the user's OAuth token, although the ID isn't documented (ADR 0002 §2.1.3 assumed it wasn't available).
- `LM` is the list YouTube Music shows as "Liked Music": a subset of `LL` (all liked videos), 49 of 105. Whether every `LL` item outside `LM` is non-music was not checked.
- Filtering `LL` by category 10, as ADR 0002 R10 planned, would have dropped 13 of the 49 YouTube Music likes, the ones uploaded in other categories. Category is not a reliable music signal.

**Decision:** read Liked Songs from `LM` and don't filter by category. `likedSongs` becomes `{ read: 'exact', write: false }` with no `readCap`, because LM's limit is unknown. Because `LM` is undocumented, requirements §8 records the fallback if YouTube withdraws it: liked videos, approximate. Implemented in #85.

## S6: Desktop-client token exchange with PKCE and without the secret

A throwaway script ran the normal loopback login with PKCE (S256) against the owner's Desktop client, asking only for `userinfo.profile`. It then sent the authorization code to `https://oauth2.googleapis.com/token` with `client_id`, `code`, `code_verifier`, `redirect_uri` and `grant_type=authorization_code`, but **no `client_secret`**.

| Request | Result |
|---|---|
| Token exchange without `client_secret` | **400** `invalid_request`, `error_description` "client_secret is missing." |

No token was issued, so there was nothing to revoke.

**Finding:** for a Desktop app client, Google requires `client_secret` at the token endpoint even when PKCE is used. This matches Google's installed-app documentation (ADR 0002 §2.1), where the secret is "not applicable" only to Android, iOS and Chrome clients.

**Decision:** no change. `SPLE_GOOGLE_CLIENT_SECRET` stays required, and the user's non-confidential secret is stored as FR-AUTH-1 and NFR-3 already allow. The client types that work without a secret (Android, iOS, Chrome) can't be used by a CLI.

## S7: Daily playlist-creation cap

**Not run.** Measuring the cap means creating playlists in the owner's account until YouTube refuses. Each one costs 50 quota units, so up to about 200 a day, and it clutters the account until they're deleted. The owner chose not to run it (2026-10-07).

**Decision:** no capability change. The cap stays unknown (ADR 0002 §2.1.3) and the R8 handling stands: playlists are created private by default, and a failed creation is a checkpointed error, not a retry loop.

## Re-running

S5 needs a logged-in `youtube-music` token and costs about 7 quota units (LM and LL pages, `channels.list`, `videos.list`). S6 needs a browser login and costs no quota. Scripts aren't kept in the repo because they read the live account. The requests are listed in the tables above.
