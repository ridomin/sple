# ADR 0002: YouTube Music provider strategy

- **Status:** Accepted with amendments (2026-10-01): Option A (official Data API v3) only, with no unofficial provider for now. Auth as proposed: a user-supplied Desktop OAuth client, loopback + PKCE, and the non-confidential client secret stored to get refresh tokens. A privacy policy will be published (NFR-9).
- **Date:** 2026-10-01
- **Deciders:** project owner (user); architect (author)
- **Related:** `docs/requirements.md` §4.5 (FR-MIG), §5 (PRV), §8, NFR-3, NFR-7, open question 5; ADR 0001 (Amazon Music)

> **Amendments (2026-10-01, requirements review):**
> - **Milestones:** YouTube Music is **M4**, split into **M4a** (read-only + PRIVACY.md + spikes) and **M4b** (writes + `migrate`). Where this ADR says "M5", read M4. "M5.x" (the unofficial provider) is dropped, because Option B was rejected.
> - **Capabilities:** the types in §4.1 are superseded by [ADR 0003](0003-provider-interface-and-capabilities.md). The quota bucket and cost values in §4.1 still hold, except `writeLiked`, which is removed: Liked Songs migrate into a private playlist, never as likes (FR-MIG-1).
> - **Device flow (`--device`)** is out of scope. Headless login uses `--manual` paste-back (FR-AUTH-1).
> - **Open items 1–5 are resolved:**
>   - Option A only.
>   - Storing the user's client secret is accepted.
>   - PRIVACY.md will be published.
>   - User-created export files are outside the 30-day rule (requirements NFR-9).
>   - Open item 6 (the spikes) moves to the start of M4a as spikes S5–S7.

## 1. Context

`sple` will add YouTube Music in M4 (M4a/M4b). There is no official YouTube Music API. The two candidates are:

- **Option A:** the official YouTube Data API v3. YouTube Music playlists are ordinary YouTube playlists, so this API can read and write them.
- **Option B:** an unofficial client that calls YouTube Music's internal "InnerTube" web API: `ytmusicapi` (Python) or `youtubei.js` (JS/TS).

The requirements that shape this decision:

- **FR-MIG-2:** matching is ISRC first, then metadata.
- **FR-MIG-4/5:** migrations are resumable and idempotent, quota-aware, estimate their cost up front, and can be spread across days.
- **PRV-1/2:** all access goes through a `Provider` interface that declares capability flags.
- **NFR-3:** PKCE only, tokens kept in a user-only file.
- **NFR-7:** follow provider terms. Unofficial clients must be opt-in and their risks documented.

All facts below were checked on 2026-10-01 against the cited pages.

## 2. Options and findings

### 2.1 Option A: YouTube Data API v3 (official)

#### 2.1.1 OAuth for a CLI

| Topic | Finding | Source |
|---|---|---|
| Loopback redirect | Supported for desktop apps on macOS, Linux and Windows. It is deprecated only for mobile. Custom URI schemes and the out-of-band (copy/paste) flow are no longer supported. | https://developers.google.com/identity/protocols/oauth2/native-app |
| PKCE | Supported and recommended, with `S256`. | https://developers.google.com/identity/protocols/oauth2/native-app |
| Client secret | The token request for a "Desktop app" client includes `client_secret`. It is "not applicable" only to Android, iOS and Chrome clients. Google states that for installed apps "the client secret is obviously not treated as a secret". | https://developers.google.com/identity/protocols/oauth2/native-app , https://developers.google.com/identity/protocols/oauth2 |
| Device flow | Supported for "TVs and Limited Input devices" clients. Only `youtube` and `youtube.readonly` are allowed among the YouTube scopes (`youtube.force-ssl` is not allowed). This is useful for headless, SSH and WSL setups. | https://developers.google.com/identity/protocols/oauth2/limited-input-device |
| Scopes | `youtube.readonly` (view), `youtube` (manage), `youtube.force-ssl` (see, edit, permanently delete). `playlistItems.insert` and `videos.rate` accept `youtube`, `youtube.force-ssl` or `youtubepartner`. | https://developers.google.com/youtube/v3/guides/auth/installed-apps , https://developers.google.com/youtube/v3/docs/playlistItems/insert , https://developers.google.com/youtube/v3/docs/videos/rate |
| Verification | A public app that uses these scopes must complete OAuth verification. Unverified apps that use sensitive or restricted scopes show an "unverified app" screen and are limited to **100 new users**. Verification is not needed for personal use (fewer than 100 users) or for development/testing builds, but those still get the warning screen and the 100-user cap. | https://developers.google.com/youtube/v3/guides/auth/installed-apps , https://support.google.com/cloud/answer/7454865 , https://support.google.com/cloud/answer/13464323 |
| Testing-mode tokens | A project with external user type and "Testing" publishing status gets refresh tokens that **expire after 7 days**. Each client ID can hold at most 100 refresh tokens per Google account. | https://developers.google.com/identity/protocols/oauth2 |
| Bring your own client | Technically straightforward: each user creates a Google Cloud project, enables the YouTube Data API, and creates a Desktop OAuth client. This mirrors FR-AUTH-2 for Spotify, and `ytmusicapi` already asks users to do the same. It also gives each user their own quota (quota is per project). It runs into the policy that each API Client must have exactly one API project (see 2.1.4). | https://developers.google.com/youtube/terms/developer-policies (III.D.1.c), https://ytmusicapi.readthedocs.io/en/stable/setup/oauth.html |

**Implication for sple:** the best fit is BYO Desktop client + loopback + PKCE (S256). Device flow can be an option (`--device`) for headless use. The user's `client_secret` has to be stored in config next to the client ID. Google says it is not confidential, but it is still a small deviation from the Spotify "no secret stored" rule (FR-AUTH-1) and should be written down in NFR-3. If a user leaves their personal project in "Testing" status, they will have to log in again every 7 days. Switching the project to "In production" without verification avoids this; they then click through the warning screen, which is fine within the personal-use exemption.

#### 2.1.2 Quota

| Fact | Value | Source |
|---|---|---|
| Default allocation | "100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints" | https://developers.google.com/youtube/v3/determine_quota_cost (updated 2026-09-15) |
| Search bucket | Since **2026-06-01**, `search.list` has its **own bucket**: 100 calls per day at 1 per call. It no longer costs 100 units from the main pool. | https://developers.google.com/youtube/v3/revision_history (June 1, 2026), https://developers.google.com/youtube/v3/docs/search/list |
| `playlists.list` / `playlistItems.list` / `videos.list` | 1 unit per call (per page) | https://developers.google.com/youtube/v3/determine_quota_cost |
| `playlists.insert` / `update` / `delete` | 50 units each | same |
| `playlistItems.insert` / `delete` | 50 units each. One item per call, with no batching. A full playlist returns 403 `playlistContainsMaximumNumberOfVideos`. | same, https://developers.google.com/youtube/v3/docs/playlistItems/insert |
| `videos.rate` (like) | 50 units | https://developers.google.com/youtube/v3/docs/videos/rate |
| `videos.list` batching | `id` takes a comma-separated list (up to 50 per page) | https://developers.google.com/youtube/v3/docs/videos/list |
| Invalid calls | Every request costs at least 1 unit, even if it fails. Each extra page costs again. | https://developers.google.com/youtube/v3/determine_quota_cost |
| Reset | Midnight Pacific Time | https://developers.google.com/youtube/v3/determine_quota_cost |
| Exhaustion signal | HTTP 403, reason `quotaExceeded`. The API has no endpoint that reports remaining quota, so sple must keep its own ledger. | https://developers.google.com/youtube/v3/docs/errors |
| Increase | Requires the "YouTube API Services – Audit and Quota Extension Form" and a **compliance audit**. The form asks for an organisation, an HTTPS website, a privacy policy, ToS, demo credentials and screenshots. No timeline is given, and the docs don't say whether the new per-method buckets can be raised separately. | https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits , https://support.google.com/youtube/contact/yt_api_form |

**Migration throughput (default quota, one project):**

Cost to add one *new* track to a playlist:

- 1 × `search.list`: 1 call from the **search bucket** (limit 100 per day).
- 1 × `videos.list`: about 1 unit, to fetch `contentDetails.duration` and `categoryId` for up to 50 candidates. `search.list` does not return duration, and FR-MIG-2 needs duration.
- 1 × `playlistItems.insert`: 50 units.

Overhead per playlist: 50 units for `playlists.insert`, plus about 1 unit per 50 existing items for the idempotency read-back (`playlistItems.list`).

- **Search-bound:** at most **100 tracks per day** that need a fresh search. 100 × 51 = 5,100 units, so the main pool is not the limit.
- **Unit-bound:** when matches are already known (provider ref in the canonical file, or a cached match of 30 days or less, see 2.1.4): (10,000 − 50) / 51 ≈ **195 tracks per day**. Liked Songs written with `videos.rate` costs the same 50 units per track.
- **Planning figure:** about 100 tracks per day. A 1,000-track library takes about **10 days**, and a 5,000-track library about **50 days**. That is too slow for the "Switcher" persona without a quota increase.
- For comparison: before June 2026, search cost 100 units, which gave 10,000 / 150 ≈ 66 tracks per day. The new bucket model is somewhat better, but the hard cap is now the 100 *searches*, not the units.

#### 2.1.3 Can the API see YouTube Music content?

| Need | Finding | Source |
|---|---|---|
| Music-only search | Not available. `search.list` has `type=video`, `videoCategoryId` (category 10 is Music), and `topicId` with curated music topics (e.g. `/m/04rlf` Music). These narrow results but do not equal YouTube Music's "Songs" filter. | https://developers.google.com/youtube/v3/docs/search/list |
| Telling songs (Art Tracks) from music videos | No documented field. The usual heuristic: Art Tracks are auto-generated by YouTube for "Artist Name - Topic" channels, and their description typically starts with "Provided to YouTube by <distributor>". `contentDetails.licensedContent` and `topicDetails.topicCategories` are weak extra signals. | https://support.google.com/youtube/answer/7636475 , https://support.symdistro.com/hc/en-us/articles/115000437283-YouTube-Art-Tracks , https://developers.google.com/youtube/v3/docs/videos |
| ISRC | **Not available.** The `videos` resource has no ISRC or UPC field, so matching must use title, artist and duration (the FR-MIG-2 fallback path only). | https://developers.google.com/youtube/v3/docs/videos |
| User playlists | Playlists created in YouTube Music appear in the YouTube library too, so `playlists.list?mine=true` covers them. Playlists made in the main YouTube app show only their music videos in YouTube Music. | https://support.google.com/youtubemusic/answer/7205933 |
| Liked Songs | YouTube Music has a "Liked Music" playlist pinned in the library. The Data API documents only the channel's `relatedPlaylists.likes` (all liked videos, music and non-music mixed) and `videos.list?myRating=like`. The YouTube Music ID `LM` is **not documented** for the Data API. The Liked videos playlist shows at most 5,000 videos. Export of YouTube Music likes through Option A is therefore approximate: it needs filtering by category or topic and is capped at 5,000. Writing a like with `videos.rate` is documented. | https://support.google.com/youtubemusic/answer/6313542 , https://developers.google.com/youtube/v3/docs/channels , https://developers.google.com/youtube/v3/docs/videos/list , https://support.google.com/youtube/answer/6083270 |
| Playlist creation limit | "There's a limit to how many public playlists a channel can create each day across the YouTube main app, YouTube Music, and the YouTube API." The number is not published. | https://support.google.com/youtube/answer/57792 |

#### 2.1.4 Terms and policy constraints for a migration tool

- **Privacy policy:** each API Client must publish one, link to the Google Privacy Policy, and explain what it accesses and stores (ToS §7; Developer Policies III.A). Sources: https://developers.google.com/youtube/terms/api-services-terms-of-service , https://developers.google.com/youtube/terms/developer-policies
- **Revocation:** sple must offer an easy way to revoke access and must delete Authorized Data within 7 days of revocation (III.D.2.3). `sple auth logout` must call Google's revoke endpoint and delete the related local cache.
- **30-day storage limit:** Authorized Data may be stored for at most 30 days without a refresh, and so may Non-Authorized Data such as search results (III.E.4). Any match cache or state file that holds YouTube metadata needs a TTL of 30 days or less. A migration spread over more than 30 days must re-validate cached matches. User-owned export files that the user saves on purpose are a judgement call; see Open items.
- **No circumventing quota:** "will not … exceed or circumvent use or quota restrictions" (ToS §15). sple must not rotate between several projects to get around the quota.
- **One project per API Client** (III.D.1.c). The BYO-client model (each user owns a project used only by their own copy of sple) appears to fit this, but YouTube has not said so. See Open items.
- **Undocumented APIs and scraping:** prohibited (III.D.7 "must not use undocumented APIs without express permission"; III.E.6 scraping). This is the main clause that Option B conflicts with.
- **Audio separation** (III.I): irrelevant, because sple never plays or downloads audio (requirements §9).

### 2.2 Option B: unofficial InnerTube clients

#### 2.2.1 `ytmusicapi` (Python)

| Topic | Finding | Source |
|---|---|---|
| Maintenance | Active. Latest tag is **1.12.3 (2026-09-16)**, with regular releases through 2025–2026 (1.11.0 Jul 2025 → 1.12.0 Apr 2026). About 3k stars, MIT licence, Python 3.10 or later. | https://github.com/sigma67/ytmusicapi/tags , https://github.com/sigma67/ytmusicapi |
| Capabilities | Search with a `songs` vs `videos` filter. Results include `videoId`, title, artists, album, `duration_seconds`, `isExplicit` and a video type (ATV = song, OMV = official video, UGC). It also covers library playlists, `get_liked_songs` ("Liked Songs" playlist), `rate_song`, playlist create/edit/delete, and `add_playlist_items(videoIds: list)` (batched, with a duplicate guard). **No ISRC.** | https://ytmusicapi.readthedocs.io/en/stable/reference/search.html , https://ytmusicapi.readthedocs.io/en/stable/reference/library.html , https://ytmusicapi.readthedocs.io/en/stable/reference/playlists.html , https://ytmusicapi.readthedocs.io/en/stable/faq.html |
| Auth | (1) **Browser headers:** the user copies the `Cookie` and `Authorization` headers from a logged-in music.youtube.com request. These are valid for about 2 years unless the user logs out, and they are a full Google session credential. (2) **OAuth:** since Nov 2024 it requires the user's own Data API client of the "TVs and Limited Input devices" type. | https://ytmusicapi.readthedocs.io/en/stable/setup/browser.html , https://ytmusicapi.readthedocs.io/en/stable/setup/oauth.html |
| Stability history | OAuth calls began returning HTTP 400 "Request contains an invalid argument" in Nov 2024 while browser auth kept working (discussions #677, #682). Issue #813 (Sep 2025) reported the same problem. Issue #921 (May 2026, "OAuth authentication still failing") was fixed by PR #932. Breakages follow YouTube-side changes (label "yt-update"). | https://github.com/sigma67/ytmusicapi/discussions/677 , https://github.com/sigma67/ytmusicapi/discussions/682 , https://github.com/sigma67/ytmusicapi/issues/921 |
| Rate limits | "There most certainly is [a rate limit], although you shouldn't run into it during normal usage." The limit is not documented. | https://ytmusicapi.readthedocs.io/en/stable/faq.html |

#### 2.2.2 JS/TS options

| Library | Status | Fit | Source |
|---|---|---|---|
| **`youtubei.js` (LuanRT/YouTube.js)** | Active: v18.1.0 (2026-09-22), v18.0.0 (2026-08-13, breaking), v17.0.0 (2026-03-16, breaking). About 5.3k stars, MIT licence. Runs on Node, Deno and browsers. | `Music` client: `search`, `getLibrary`, `getPlaylist`, `getAlbum`, `getArtist`, `getInfo`. `PlaylistManager`: `create(title, videoIds)`, `addVideos(id, videoIds)` (batched), `delete`, `setName`, `setDescription`, `removeVideos`. `InteractionManager.like(videoId)`. Auth: **cookies are recommended**; OAuth works only with the TV client. Reading Liked Songs (presumably `getPlaylist('LM')` or a library filter) is not documented and needs a spike. Two breaking majors in 6 months. | https://github.com/LuanRT/YouTube.js/releases , https://ytjs.dev/guide/authentication , https://ytjs.dev/api/youtubei.js/namespaces/Clients/classes/Music , https://ytjs.dev/api/youtubei.js/namespaces/Managers/classes/PlaylistManager , https://ytjs.dev/api/youtubei.js/namespaces/Managers/classes/InteractionManager , https://ytjs.dev/api/youtubei.js/namespaces/YTMusic/classes/Library |
| `node-youtube-music` | **Archived 2024-06-26**, GPL-3.0. Rejected. | n/a | https://github.com/baptisteArno/node-youtube-music |
| `ytmusic-api` (npm) | Could not verify (npm returned 403). Generally known as search/read-only without auth, so it can't do playlist writes. Not considered. | n/a | https://www.npmjs.com/package/ytmusic-api |

**Node vs. shelling out to Python.** `youtubei.js` is a credible, maintained TS-native option that covers search, playlist CRUD, batched adds and likes. Calling `ytmusicapi` from Node would mean:

- requiring Python 3.10+ next to Node, which breaks `npx sple` (NFR-1) and adds Windows and WSL friction (NFR-2);
- building a JSON-over-stdio bridge, with versions pinned on both sides;
- testing two runtimes (NFR-6).

What it would buy: `ytmusicapi` is music-specific and has richer song metadata (album, video type ATV/OMV, `duration_seconds` in search results), and it has a bigger body of migration use. **Choice: `youtubei.js`**, behind a thin internal port so that a `ytmusicapi` bridge could be added later if `youtubei.js` falls short. That later choice would be a separate ADR.

#### 2.2.3 Terms and account risk

- The YouTube ToS prohibit accessing the Service "using any automated means (such as robots, botnets or scrapers)" without written permission, as well as circumventing features that "limit the use of the Service" (https://www.youtube.com/static?template=terms). The YouTube API Developer Policies prohibit undocumented APIs and scraping (III.D.7, III.E.6; https://developers.google.com/youtube/terms/developer-policies). Option B **violates the provider's terms**. This is not a gray area.
- **Account risk:** YouTube may suspend or terminate accounts for material or repeated ToS breaches (https://support.google.com/youtube/answer/2802168). I found no documented wave of bans aimed at ytmusicapi users, but the risk is real and falls on the user's **whole Google account**, not on sple.
- **Credential risk:** browser-header auth stores a full Google session cookie, valid for about 2 years. A leak exposes far more than YouTube, so the local token file is much more sensitive than an OAuth token with limited scope (NFR-3).
- **Stability risk:** this approach breaks without warning whenever YouTube changes InnerTube (see the ytmusicapi history above and the youtubei.js breaking majors). It also has undocumented rate limits and an undocumented daily cap on playlist creation.
- **NFR-7 already anticipates this case:** "Unofficial clients … are opt-in and their risks are documented." It is allowed only as an explicit, user-acknowledged opt-in, never the default, and never used silently as a fallback.

### 2.3 Non-code alternative worth documenting

YouTube Music has a **built-in "Transfer playlists from other apps"** feature (Settings → Privacy & data), and Google's help pages point to TuneMyMusic and Soundiiz (https://support.google.com/youtubemusic/answer/14729358). The user docs should mention this so that users with large libraries have a compliant path that isn't limited by quota.

## 3. Comparison

| Criterion | A: Data API v3 | B: InnerTube (`youtubei.js`) |
|---|---|---|
| ToS / NFR-7 | Compliant (privacy policy, revocation, 30-day cache rules) | Violates YouTube ToS and API policies. Acceptable only as an opt-in. |
| Account risk to user | None beyond normal use | Possible suspension of the whole Google account |
| Auth | OAuth Desktop + loopback + PKCE (or device flow). BYO client; the non-confidential secret is stored. | Copy-pasted browser cookie (a full session, about 2 years). OAuth only through the TV client. |
| Setup effort for user | Create a GCP project, enable the API, create an OAuth client, consent screen. Moderate. | Copy headers from browser DevTools. Low, but error-prone. |
| Throughput | **About 100 new tracks per day** (search bucket). About 195 per day if matches are cached. | No published quota. Batched adds. Limited by undocumented rate limits (in practice, a library in minutes or hours). |
| Music-aware search | No. Heuristics only (category 10, Topic channel, "Provided to YouTube by"). | Yes. "Songs" filter plus video type (ATV/OMV/UGC). |
| Duration in search results | No. Needs an extra `videos.list` call (1 unit per 50 IDs). | Yes |
| ISRC | No | No |
| YT Music Liked Songs read | Approximate (Liked videos, filtered, max 5,000) | Yes (LM playlist; to be verified in `youtubei.js`) |
| Like / write Liked Songs | `videos.rate` (50 units) | `like()` |
| Playlist delete | Yes (`playlists.delete`) | Yes |
| Stability | Versioned and documented, with a public revision history | Breaks with YouTube UI changes. 2 breaking majors in 2026. |
| Runtime fit (Node/TS) | Plain HTTPS with sple's own HTTP client (PRV-4). No SDK needed. | Native TS library, no Python |
| Testability (NFR-6) | Easy to build fixtures from documented JSON | Fixtures are brittle and drift as InnerTube changes |

## 4. Recommendation

**Both, under a clear policy: A is the default and supported provider; B is an opt-in, experimental provider that ships later and only if the user wants it.**

1. **M5: ship `youtube-music` (Option A) only.**
   - Auth uses a BYO Desktop OAuth client with loopback + PKCE. `--device` is available for headless use.
   - Scopes are minimal: `youtube.readonly` for list, show and export; `youtube` is added only for create, remove, import and migrate (FR-AUTH-5).
   - Full quota awareness: a per-bucket ledger, a cost estimate before every run, resume on the next Pacific day, and exit code 5 when quota runs out.
2. **M5.x (optional, user decision): add `youtube-music-unofficial` (Option B) via `youtubei.js`.**
   - It is a separate provider ID, so choosing it is always explicit (`--provider youtube-music-unofficial` / `--to youtube-music-unofficial`).
   - On first `auth login`, it shows a blocking risk notice (ToS violation, account-suspension risk, stores a full session cookie, may break at any time). It needs typed confirmation, and the acknowledgement is recorded in config (`providers.youtube-music-unofficial.riskAcknowledged: "<ISO date>"`).
   - It is never used as an automatic fallback when A runs out of quota. The CLI may *mention* it in the quota-exhausted message, next to the built-in YouTube Music transfer feature.
3. **Shared code:** both adapters share a `youtube-common` module and the same track ref namespace (`youtube:video:<videoId>`). A canonical file exported through one adapter can then be imported through the other, and the match cache (30-day TTL or less) is shared.

Rejected alternatives:

- **A only:** compliant, but it makes YouTube Music migration impractical for large libraries, and Liked Songs export is only approximate. B covers that gap for users who knowingly accept the risk, as NFR-7 already allows.
- **B only:** it violates the provider's terms by default and contradicts NFR-7's "follow each provider's developer terms".
- **Hybrid (B for search, A for writes):** it would remove the 100-searches-per-day ceiling while keeping writes official, but it still uses undocumented APIs (III.D.7) and arguably "circumvents quota restrictions" (ToS §15). Not adopted. If the user wants it later, it can only be an opt-in mode of the unofficial provider, never of `youtube-music`.

### 4.1 Fit with the Provider interface and PRV-2 capabilities

Capabilities become richer and are declared per adapter. Proposed additions to the M0 types (they are generic and also serve Spotify and Amazon):

```ts
// core/provider/capabilities.ts
export type ProviderOperation =
  | 'search' | 'resolveTrack' | 'getTrackDetails'
  | 'listPlaylists' | 'getPlaylistItems'
  | 'createPlaylist' | 'removePlaylist' | 'populatePlaylist'
  | 'readLiked' | 'writeLiked';

export interface QuotaBucket {
  id: string;                  // e.g. 'units', 'search'
  dailyLimit: number;          // default; user-overridable in config if they got an extension
  resetTimeZone: string;       // IANA, e.g. 'America/Los_Angeles'
}

export interface QuotaCost {
  bucket: string;              // QuotaBucket.id
  amount: number;
  per: 'call' | 'page' | 'item';
  pageSize?: number;           // for per: 'page' (e.g. 50)
}

export type QuotaModel =
  | { kind: 'rate-limited' }                                        // Spotify: 429 + Retry-After only
  | { kind: 'daily-buckets'; buckets: QuotaBucket[];
      costs: Partial<Record<ProviderOperation, QuotaCost[]>> }      // YouTube Data API
  | { kind: 'undocumented'; minDelayMs: number; maxBatch: number }; // unofficial clients

export interface ProviderCapabilities {
  official: boolean;
  requiresRiskAcknowledgement: boolean;
  canDeletePlaylist: boolean;            // YouTube: true (Spotify: false = unfollow)
  supportsIsrcSearch: boolean;           // YouTube: false (both options)
  searchReturnsDuration: boolean;        // A: false (needs getTrackDetails), B: true
  musicAwareSearch: boolean;             // A: false (heuristics), B: true
  maxTracksPerRequest: number;           // A: 1 (playlistItems.insert), B: batch size
  maxPlaylistSize?: number;              // unknown for YouTube; handle 403 playlistContainsMaximumNumberOfVideos
  likedSongs: { read: 'exact' | 'approximate' | 'none'; write: boolean; readCap?: number };
  quotaModel: QuotaModel;
}
```

The Option A declaration (values from 2.1.2):

```ts
quotaModel: {
  kind: 'daily-buckets',
  buckets: [
    { id: 'units',  dailyLimit: 10_000, resetTimeZone: 'America/Los_Angeles' },
    { id: 'search', dailyLimit: 100,    resetTimeZone: 'America/Los_Angeles' },
  ],
  costs: {
    search:           [{ bucket: 'search', amount: 1, per: 'call' }],
    resolveTrack:     [{ bucket: 'search', amount: 1, per: 'call' },
                       { bucket: 'units',  amount: 1, per: 'call' }],   // + videos.list for durations
    getTrackDetails:  [{ bucket: 'units',  amount: 1, per: 'page', pageSize: 50 }],
    listPlaylists:    [{ bucket: 'units',  amount: 1, per: 'page', pageSize: 50 }],
    getPlaylistItems: [{ bucket: 'units',  amount: 1, per: 'page', pageSize: 50 }],
    createPlaylist:   [{ bucket: 'units',  amount: 50, per: 'call' }],
    removePlaylist:   [{ bucket: 'units',  amount: 50, per: 'call' }],
    populatePlaylist: [{ bucket: 'units',  amount: 50, per: 'item' }],
    writeLiked:       [{ bucket: 'units',  amount: 50, per: 'item' }],
    readLiked:        [{ bucket: 'units',  amount: 1, per: 'page', pageSize: 50 }],
  },
},
```

How this serves FR-MIG-4/5:

- **Estimate (FR-MIG-5):** `core/quota/estimate.ts` computes `{ perBucket: Record<string, number>, days: number }` from the migration plan and `costs`. It counts the tracks that still need a search (no `youtube:` ref and no valid cache entry) separately from the inserts. `sple migrate` prints the estimate and the projected number of days, and asks for confirmation (or honours `--yes` / `--max-days`).
- **Ledger (PRV-4):** `core/quota/ledger.ts` is persisted in the state directory and keyed by provider, bucket and the Pacific calendar day. Every call debits it *before* it is sent, because failed calls cost quota too. The limiter refuses calls that would overdraw a bucket.
- **Exhaustion:** if the ledger hits zero or the API returns 403 `quotaExceeded`, the run checkpoints and exits with code 5. The message gives the reset time in local time, plus `sple migrate --resume <runId>`.
- **Resumability (FR-MIG-4):** the state file records, per source track: `matched → inserted(playlistItemId)`. The match phase and the write phase are checkpointed separately, so searches already spent are never repeated. Before resuming inserts, the adapter reads the target playlist back once (`playlistItems.list`, 1 unit per 50) and skips videoIds that are already present. This guards against crashes between the API call and the checkpoint write.
- **30-day rule:** match-cache entries carry `fetchedAt`. Entries older than 30 days are re-validated with `videos.list` (cheap, 1 unit per 50 IDs) instead of a new search, or dropped.
- **Option B** uses `kind: 'undocumented'`. The limiter applies `minDelayMs` and `maxBatch` and treats HTTP 429 or 403 responses as "stop and checkpoint", never as "retry hard".

## 5. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | 100 searches per day makes large migrations take weeks under Option A | High for the Switcher persona | Up-front estimate and multi-day resume; reuse existing `youtube:` refs and the match cache; document the built-in YouTube Music transfer; let users enter an increased quota in config if they obtain one |
| R2 | Quota extension needs a compliance audit that asks for an organisation, website and privacy policy; a BYO personal project is unlikely to qualify | High | Treat the default quota as the planning baseline; don't promise extensions |
| R3 | Metadata-only matching (no ISRC) picks music videos or covers instead of the audio track | Medium | Heuristic scoring: prefer Topic channels and "Provided to YouTube by"; duration tolerance; `--review` for low confidence (FR-MIG-3) |
| R4 | Google OAuth friction: unverified-app screen, 7-day tokens in Testing mode, 100-user cap | Medium | BYO-client docs tell users to set "In production" (personal use, no verification) and explain the warning screen |
| R5 | Option B: ToS violation and suspension of the user's Google account | High (falls on the user) | Separate provider ID, blocking risk notice, recorded acknowledgement, never the default or a fallback |
| R6 | Option B: full-session cookie stored on disk | High if leaked | 0600 file (FR-AUTH-3), never logged (CLI-7), `auth logout` deletes it, docs advise logging out of that browser session to invalidate it |
| R7 | Option B: InnerTube breakage (two youtubei.js majors in 2026; ytmusicapi OAuth outages 2024–2026) | Medium | Pin versions, isolate behind a port, label the provider "experimental", and don't count it toward coverage gates on live behaviour |
| R8 | Undocumented daily cap on creating public playlists | Low/Med | Create playlists as private by default; treat creation failures as checkpointed partial failures |
| R9 | Policy ambiguity: does a BYO project per user satisfy "one project per API Client", and does the 30-day rule apply to user-saved export files? | Low/Med | Record as open items; keep sple caches at 30 days or less regardless |
| R10 | Liked Songs export under A is approximate (mixed liked videos, 5,000 cap) | Medium | `likedSongs.read: 'approximate'` capability; the CLI warns and filters by category 10 or Topic heuristics |

## 6. Open items (for the user)

1. **Decision:** approve "A default + B opt-in later", or choose A only (and drop B entirely)?
2. If B is approved: ship it in M5 alongside A, or defer it to M5.x after A is stable?
3. Accept storing the user's own (non-confidential) Google Desktop `client_secret` in config? This needs an amendment to NFR-3 / FR-AUTH-1 wording for Google.
4. Should sple publish a privacy-policy page (docs/PRIVACY.md) to satisfy YouTube ToS §7, even though users bring their own project? (Recommended: yes, it costs little.)
5. Do user-initiated export files (canonical JSON with YouTube metadata) fall under the 30-day storage rule? We could add a notice in the exported file and docs, or ask YouTube API support.
6. **Spike tasks, before M5 implementation starts:**
   - Does `playlistItems.list?playlistId=LM` work through the Data API?
   - Does a Desktop client token exchange with PKCE succeed *without* `client_secret`?
   - Does `youtubei.js` read Liked Songs (`getPlaylist('LM')`)?
   - What is the actual daily cap on playlist creation?
