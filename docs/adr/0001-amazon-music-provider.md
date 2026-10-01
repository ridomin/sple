# ADR 0001: Amazon Music as a provider (M4 feasibility)

- Status: **Rejected** (2026-10-01): Amazon Music is not planned as a provider; revisit only if API access and the third-party-integration terms change.
- Date: 2026-10-01
- Deciders: architect (proposal), project owner (acceptance)
- Related: `docs/requirements.md` §4.5 (FR-MIG), §5 (PRV), §8 (known constraints), §11 (M4)

> **Amendment (2026-10-01):**
> - The "M4" in this ADR refers to an earlier plan. M4 is now YouTube Music, split into M4a and M4b (`docs/requirements.md` §11).
> - The capability type and matrix below are superseded by [ADR 0003](0003-provider-interface-and-capabilities.md).
> - Since February 2026, Spotify no longer returns ISRCs to Development Mode apps (requirements §8). This weakens the ISRC-first assumption below.

## Context

`docs/requirements.md` names Amazon Music as the second provider (§10 Q6). Milestone M4 is "Amazon Music adapter + `migrate --to amazon-music`". §8 says the Amazon Music Web API is in closed beta, that access should be requested during M1, and that we still need to check: playlist create, add tracks, ISRC lookup, rate limits, and the Login with Amazon (LWA) flow for a CLI.

`sple` constraints that matter here:

- It is a local CLI. There is no server. Each user brings their own client ID (FR-AUTH-2 pattern).
- Auth is PKCE only, with no client secret stored (FR-AUTH-1, NFR-3), and tokens refresh automatically (FR-AUTH-3).
- Migration writes playlists into the target provider (FR-MIG-1), matching by ISRC first (FR-MIG-2).
- We must follow each provider's developer terms (NFR-7).

All findings below were checked against public documentation on 2026-10-01. The reference pages are publicly readable even though API *access* is gated. Where a page did not answer a question, this ADR says so instead of guessing.

## Findings

### F1. Access status: closed beta, and no new developers are being onboarded

- V1 overview: "These Amazon Music APIs are currently in a closed Beta." Also: "access is limited to already approved developers." [API_web_overview](https://developer.amazon.com/docs/music/API_web_overview.html)
- V2 overview: "Amazon Music Web API V2 is in closed Beta (preview) status. The interface may change before general availability, and access is limited to already approved developers." It also says "Partners currently integrating in production should continue to use the Web API V1." To get access, the page says to contact "your Amazon Business Development representative". [API_web_overview_v2](https://developer.amazon.com/docs/music/API_web_overview_v2.html)
- Program overview: "Access to the APIs will be limited until the implementation is validated and approved by amazon music." Interested developers are pointed to the Contact Us form. [Program Overview](https://developer.amazon.com/docs/music/get_started_program-overview.html)
- How to apply: Amazon staff on the official forum say to use the Contact Us form, choosing the **Music Developers** category and **Business Opportunity**, and to describe who you are and what you are building. [Forum: Accessing the Amazon Music APIs](https://community.amazondeveloper.com/t/accessing-the-amazon-music-apis/2352), [Contact Us](https://developer.amazon.com/support/contact-us)
- Actual onboarding status, from Amazon staff on the official forum:
  - 2025-03-17: "closed beta right now with a full waiting list."
  - 2025-11-03: "We are not onboarding any partner to the API, as it still is in closed Beta." [Forum: How can I access the Amazon Music API?](https://community.amazondeveloper.com/t/how-can-i-access-the-amazon-music-api/9253)
  - 2025-12-02: "we are not onboarding any new client to the API while in closed beta. We hope to have an official timeline (date for a date) available early next year." The thread runs until July 2026 with no further staff update. [Forum: Request for Amazon Music API Access](https://community.amazondeveloper.com/t/request-for-amazon-music-api-access/24864)
- Eligibility criteria: **not published.** Everything points to a business-development relationship ("Business Opportunity", "BD representative") followed by product certification. Amazon publishes no criteria under which an individual or an open-source project would qualify. **I could not confirm this either way.**

### F2. Terms of service (Amazon Music Program Requirements)

Source: [Amazon Music Program Requirements](https://developer.amazon.com/docs/music/requ_AM-Program-Requirements.html), plus the [Amazon Developer Services Agreement](https://developer.amazon.com/support/legal/da).

- **Certification before distribution.** "Your Music Product must be developed and operated by you and not by a third party. You must submit Your Music Product to us for review and certification before Your Music Product is distributed or otherwise made available to any end users." An open-source CLI published on npm would be "distributed". Each user running their own unreviewed copy with their own credentials does not fit this model.
- **No integration with other music services.** Among the prohibited activities: you may not "integrate the Amazon Music Service or any Amazon Music Service content with a third-party music service". A Spotify-to-Amazon migration tool joins Amazon Music with a third-party music service by design. **This is a direct ToS conflict for FR-MIG with Amazon as source or target.** Only Amazon could give a definitive legal reading, but the plain wording covers our use case.
- **Territories.** Distribution is enabled one territory at a time after certification. "you may not provide or facilitate access to ... the Amazon Music Service from outside Enabled Territories."
- **End-user data.** There are limits on collecting and storing data about end users' use of the service. Exporting a user's Amazon library to local files (which `sple export` would do) would need review against this section.

### F3. Authentication (LWA)

- Every Amazon Music request needs an LWA OAuth 2.0 bearer token. V1 also needs `x-api-key: <LWA Security Profile ID>`. V2 instead needs `X-Amzn-Device-Id: <stable id>`; requests without it fail with `401 MISSING_DEVICE_ID`, and V2 ignores `x-api-key`. [API_web_LWA](https://developer.amazon.com/docs/music/API_web_LWA.html), [API_web_overview_v2](https://developer.amazon.com/docs/music/API_web_overview_v2.html)
- **Bring-your-own client ID is not possible.** "The Security Profile ID(s) used by Music client applications must be enabled by the Amazon Music Service in order for authorization to be successful." [API_web_LWA](https://developer.amazon.com/docs/music/API_web_LWA.html). A user who registers their own LWA security profile gets a client ID that Amazon Music rejects, unless Amazon enables that specific profile. The Spotify BYO model (FR-AUTH-2) does not carry over.
- **PKCE is supported**: `code_challenge_method` can be `S256` or `plain`. PKCE "must be used for Browser-Based Applications, and is recommended for all application types." **However:** "When no `client_secret` is passed, no refresh token will be returned. Access token will still be returned if the `code_verifier` is valid." [LWA Authorization Code Grant](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html)
  - Result: a PKCE-only, secretless CLI (FR-AUTH-1, NFR-3) gets **no refresh token**, so the user must log in again roughly every hour. That conflicts with FR-AUTH-3's automatic refresh, and a long migration would be interrupted.
- **Redirect URI**: `redirect_uri` is described as "The HTTPS address where the authorization service should redirect the user", and "Allowed Return URLs" are registered per security profile. [LWA Authorization Code Grant](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html), [Register for LWA (web)](https://developer.amazon.com/docs/login-with-amazon/register-web.html). The official docs **do not say** whether `http://127.0.0.1:<port>` or `http://localhost` loopback redirects are allowed. Community reports suggest `http://localhost` return URLs work in development, but that is not documented. **Unverified.**
- **Device / code-based flow**: the Amazon Music page says devices without browsers "can use a special code-based login" ([API_web_LWA](https://developer.amazon.com/docs/music/API_web_LWA.html)). The generic LWA code-based linking doc (`POST https://api.amazon.com/auth/o2/create/codepair`, `response_type=device_code`, polling `interval`, `device_code` valid for about 600 s) says the client ID is "obtained using the Login with Amazon SDK for Android or iOS". It also lists scopes as "profile, profile:user_id, postal_code, or some combination". [LWA Code-Based Linking](https://developer.amazon.com/docs/login-with-amazon/retrieve-code-other-platforms-cbl-docs.html). Whether `music::*` scopes work with code-based linking for a non-Amazon-certified client is **not documented publicly**.
- **Token lifetime**: "Bearer tokens expire after a certain amount of time, typically one hour". An expired token gives `401 INVALID_ACCESS_TOKEN`. [API_web_LWA](https://developer.amazon.com/docs/music/API_web_LWA.html). The example shows `expires_in: 3600`. Refresh uses `grant_type=refresh_token`, and the documented examples include `client_secret`. Token endpoints are regional: NA `api.amazon.com`, EU `api.amazon.co.uk`, FE `api.amazon.co.jp`. [LWA Authorization Code Grant](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html). Refresh-token lifetime is **not documented**.
- **Scopes** ([API_web_LWA](https://developer.amazon.com/docs/music/API_web_LWA.html)): `music::catalog`, `music::favorites`, `music::favorites:read`, `music::history`, `music::library`, `music::library:read`, `music::playback`, `music::profile`, `music::profile:read`, `music::recommendation`. Minimum set for sple: `music::catalog` (search), `music::library:read` (list playlists, playlist tracks, library and liked tracks in V2), `music::library` (create, add, delete), and `music::profile:read` (auth status).

### F4. Capabilities (endpoint by endpoint)

V1 base URL: `https://api.music.amazon.dev/v1`. V2 base URL: `https://api.music.amazon.com/v2`.

| sple need | V1 (production for approved partners) | V2 (preview) | Notes |
|---|---|---|---|
| Catalog search | `POST /search/tracks`, scope `music::catalog`. Body `searchFilters[{field, query}]`, `limit` max **20**, `token` paging, `sortBy` [Search V1](https://developer.amazon.com/docs/music/API_web_search.html) | `POST /v2/search/tracks`, `first` max 100, `after`, `territory` [Search V2](https://developer.amazon.com/docs/music/API_web_search_v2.html) | Also album, artist and playlist search |
| ISRC lookup | **Through a search filter only**: `{"field":"isrc","query":"<ISRC>"}` (TrackFieldType includes `isrc`) [Search V1](https://developer.amazon.com/docs/music/API_web_search.html) | Same: filter `field` can be `isrc` [Search V2](https://developer.amazon.com/docs/music/API_web_search_v2.html) | No dedicated ISRC endpoint on `/tracks` [Tracks V1](https://developer.amazon.com/docs/music/API_web_track.html), [Tracks V2](https://developer.amazon.com/docs/music/API_web_track_v2.html). Track objects include `isrc` |
| List my playlists | `GET /me/playlists`, scope `music::library:read`, `limit` 1–100, `cursor`, `sortBy` [Playlist V1](https://developer.amazon.com/docs/music/API_web_playlist.html) | `GET /v2/me/playlists/owned` (`music::library:read`); `GET /v2/me/playlists/followed` (`music::favorites:read`) [Library V2](https://developer.amazon.com/docs/music/API_web_library_v2.html) | |
| Get playlist tracks | `GET /playlists/{id}/tracks`, `music::library:read`, `limit` 1–100, `cursor`. Edges carry `cursor` = `<index>:<entryId>` [Playlist V1](https://developer.amazon.com/docs/music/API_web_playlist.html) | `GET /v2/playlists/{id}/tracks`, `first` 1–100, `after` [Playlist V2](https://developer.amazon.com/docs/music/API_web_playlist_v2.html) | Entry IDs are not track IDs |
| Create playlist | `POST /playlists`, `music::library`, body `title`, `description`, `visibility` PUBLIC/PRIVATE (all marked required) [Playlist V1](https://developer.amazon.com/docs/music/API_web_playlist.html) | `POST /v2/playlists` (title required; optional `trackAsins`) [Playlist V2](https://developer.amazon.com/docs/music/API_web_playlist_v2.html) | No collaborative flag |
| Add tracks | `PUT /playlists/{id}/tracks`, `music::library`, body `trackIds[]`, `addDuplicateTracks` (default false). **Max per request not documented** [Playlist V1](https://developer.amazon.com/docs/music/API_web_playlist.html) | `POST /v2/playlists/{id}/tracks`, `trackIds[]`, max **100** [Playlist V2](https://developer.amazon.com/docs/music/API_web_playlist_v2.html) | `addDuplicateTracks=false` helps idempotent resume (FR-MIG-4) |
| Remove/delete playlist | `DELETE /playlists/{id}`, a real delete (also unfollow through `DELETE /me/followed/playlists/{id}`) [Playlist V1](https://developer.amazon.com/docs/music/API_web_playlist.html) | `DELETE /v2/playlists/{id}` [Playlist V2](https://developer.amazon.com/docs/music/API_web_playlist_v2.html) | Unlike Spotify, a **true delete exists** |
| Liked songs / library | Liked: `GET /me/tracks` ("songs ... marked as 'liked'"), `music::favorites:read`, limit 1–100 [Tracks V1](https://developer.amazon.com/docs/music/API_web_track.html). Library: `GET /me/library/tracks`, limit max 100 [User V1](https://developer.amazon.com/docs/music/API_web_user.html) | `GET /v2/me/tracks/liked` and `GET /v2/me/tracks` (`music::library:read`), `first` 1–100 [Library V2](https://developer.amazon.com/docs/music/API_web_library_v2.html) | Amazon separates "liked" from "library"; map `--liked` to liked tracks |
| Batch track lookup | `GET /tracks?ids=` max 100 [Tracks V1](https://developer.amazon.com/docs/music/API_web_track.html) | `GET /v2/tracks?ids=` max **20** [Tracks V2](https://developer.amazon.com/docs/music/API_web_track_v2.html) | |

On paper, the API covers everything sple needs. The blockers are access, auth, and ToS, not missing endpoints.

### F5. Rate limits, pagination, errors

- **Rate limits**: "Transactions Per Second (TPS) limits" are enforced per application. Exceeding them returns `429` with code `THROTTLED`: "Too Many Requests. Rate limiting has been applied." No numbers are published, and no `Retry-After` header is documented. The advice is exponential back-off and asking your Amazon contact for increases. [API_web_overview](https://developer.amazon.com/docs/music/API_web_overview.html), [Errors V1](https://developer.amazon.com/docs/music/API_web_errors.html). V2 says rate limits apply per application based on the LWA token, again without numbers. [API_web_overview_v2](https://developer.amazon.com/docs/music/API_web_overview_v2.html). There is **no daily quota model** like YouTube's.
- **Pagination**: V1 uses a cursor (`limit` + `cursor`), and responses contain `pageInfo { hasNextPage, token }` plus `edges[{ cursor, node }]`. [Playlist V1](https://developer.amazon.com/docs/music/API_web_playlist.html). V2 is forward-only: `first` (default 20, max 100) and `after`, with a response containing `items` and top-level `nextToken`. When `nextToken` is absent you are on the last page. V2 has "no numeric offsets, no page numbers, and no total-count field". [Pagination V2](https://developer.amazon.com/docs/music/API_web_pagination_v2.html). This matters for FR-SEARCH-2 (`--offset` cannot be supported).
- **Errors**: V1 returns `{ "error": { status, code, message, url?, reference, payload? } }`, with statuses 400, 401, 403 (including subscription-tier limits), 404, 422, 429 (`THROTTLED`), and 500. The docs say only `500 INTERNAL` is retryable. [Errors V1](https://developer.amazon.com/docs/music/API_web_errors.html). V2 returns `{ "error": { code, message, traceId } }`. [Errors V2](https://developer.amazon.com/docs/music/API_web_errors_v2.html)

### F6. Regional availability

- Distribution is limited to "Enabled Territories", which are certified one by one. [Program Requirements](https://developer.amazon.com/docs/music/requ_AM-Program-Requirements.html)
- V2 catalog calls take a `territory` parameter, and there is a Markets resource. [Search V2](https://developer.amazon.com/docs/music/API_web_search_v2.html), [Tracks V2](https://developer.amazon.com/docs/music/API_web_track_v2.html). The list of markets and per-territory catalog differences are **not publicly documented** (the Markets V1 page URL I tried returned 404).
- LWA token endpoints are regional (NA/EU/FE), so an adapter would need to pick the right one for the user's marketplace. [LWA Authorization Code Grant](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html)
- 403 errors can come from the user's subscription tier. [Errors V1](https://developer.amazon.com/docs/music/API_web_errors.html). Which tiers (Free, Prime, Unlimited) may create playlists through the API is **not documented**.

## Capability matrix (PRV-2)

Proposed `ProviderCapabilities` values for an Amazon Music adapter, compared with Spotify. Field names follow PRV-2. The three fields marked *new* are suggested additions, because Amazon needs them to be expressed.

```ts
export interface ProviderCapabilities {
  canDeletePlaylist: boolean;          // true delete (vs unfollow only)
  supportsIsrcSearch: boolean;         // can resolve ISRC -> track ref
  isrcSearchMode: 'filter' | 'lookup' | 'none'; // new: how ISRC is resolved
  maxTracksPerRequest: number;         // populate-playlist batch size
  maxSearchPageSize: number;
  paginationModel: 'offset' | 'cursor-forward'; // new: drives --offset support
  quotaModel: 'none' | 'rate-limit' | 'daily-units';
  supportsCollaborative: boolean;
  supportsLikedTracks: boolean;
  supportsRefreshToken: boolean;       // new: false => re-login needed per ~1h
  userSuppliedClientId: boolean;       // FR-AUTH-2 applicability
}
```

| Flag | Spotify (ref) | Amazon Music V1 | Amazon Music V2 | Source |
|---|---|---|---|---|
| `canDeletePlaylist` | false (unfollow) | **true** | **true** | Playlist V1/V2 |
| `supportsIsrcSearch` | true | true | true | Search V1/V2 |
| `isrcSearchMode` | `filter` (`isrc:` query) | `filter` | `filter` | Search V1/V2 |
| `maxTracksPerRequest` | 100 | **unknown** (assume 100 until confirmed) | 100 | Playlist V1/V2 |
| `maxSearchPageSize` | 50 | 20 (tracks) | 100 | Search V1/V2 |
| `paginationModel` | `offset` | `cursor-forward` | `cursor-forward` | Playlist V1, Pagination V2 |
| `quotaModel` | `rate-limit` | `rate-limit` (TPS, unpublished, no Retry-After) | `rate-limit` | Overview, Errors V1 |
| `supportsCollaborative` | true | false | false | Playlist V1/V2 |
| `supportsLikedTracks` | true | true (`/me/tracks`) | true (`/me/tracks/liked`) | Tracks V1, Library V2 |
| `supportsRefreshToken` | true (PKCE) | **false** with PKCE-only; true only with a client secret | same | LWA Auth Code Grant |
| `userSuppliedClientId` | true | **false** (security profile must be enabled by Amazon Music) | false | API_web_LWA |

## Decision / Recommendation

1. **M4 as written is not feasible.** It is blocked by external factors outside our control:
   - (a) Amazon is not onboarding new API clients (F1).
   - (b) Even with access, each security profile must be enabled by Amazon Music, so the BYO client-ID model fails. sple would need one Amazon-certified security profile, which means a project-owned identity that goes through review and certification (F2, F3).
   - (c) The Program Requirements forbid integrating Amazon Music with a third-party music service, which is exactly what `migrate --from spotify --to amazon-music` does (F2).
   - (d) PKCE-only auth gives no refresh token (F3).
2. **Do not schedule Amazon Music as the second provider.** Recommend that the project owner re-open §10 Q6 and pick a second provider whose API is open to self-registered apps. Candidates are YouTube Music via the YouTube Data API v3 (already under investigation) and others to be evaluated in separate ADRs. Amazon Music becomes an "L / blocked-external" provider.
3. **Still submit the access request** (Contact Us → Music Developers → Business Opportunity), describing sple honestly as a personal-use, open-source playlist tool that includes cross-service migration. It costs little. A written answer from Amazon on F2 (third-party integration) and on BYO security profiles is the only way to unblock this path. Track the request in the Open items below.
4. **Keep the abstraction Amazon-ready at no extra cost.** Adopt the extra capability flags above (`paginationModel`, `isrcSearchMode`, `supportsRefreshToken`, `userSuppliedClientId`) in M0, because they also help with YouTube and other providers. Do not write any Amazon adapter code until access is granted.
5. **Fallback if access is denied (or never answered): file hand-off.** `sple export --format csv|json` (already in MVP) produces files that the user can import into Amazon Music through a tool Amazon has authorized. sple's docs can describe this hand-off without sple calling Amazon. Which third-party tools are authorized Amazon Music partners, and which file formats they accept, is **not verified** here (see Open items). sple must not automate the Amazon web app (NFR-7: no scraping).

## Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | API access is never granted to an individual or open-source project | High | M4 blocked indefinitely | Re-prioritize the second provider; file hand-off fallback |
| R2 | ToS forbids third-party music-service integration, so migration is non-compliant even with access | High | Feature unshippable under NFR-7 | Ask Amazon for a written exception; otherwise do not ship Amazon migration |
| R3 | BYO client ID impossible; project-owned certified security profile required | High (documented) | Project needs a legal identity, certification, and a public client ID; a support burden | Only pursue if Amazon approves; then treat the client ID as public (PKCE) |
| R4 | No refresh token without a client secret, so hourly re-login and broken long migrations | High (documented) | UX and FR-MIG-4 resumability | A checkpointed migration survives re-login. A local client secret would violate FR-AUTH-1/NFR-3, so it needs an ADR if ever considered |
| R5 | HTTPS-only redirect URIs; loopback `http://127.0.0.1` not documented as allowed | Medium | Auth flow may need code-based linking instead | Test once credentials exist; code-based linking as an alternative |
| R6 | V2 is a preview and may change; V1 may be retired | Medium | Adapter churn | Target whichever version Amazon assigns; keep adapter thin |
| R7 | Undocumented TPS limits and no `Retry-After` | Medium | Throttling during bulk adds | PRV-4 limiter with conservative default (e.g. 2–5 rps), exponential backoff with jitter on `THROTTLED` |
| R8 | Territory or subscription-tier restrictions (403) | Medium | Some users can't write playlists | Map 403 tier errors to a clear CLI message (exit 3/1) |

## Open items

1. **Access request**: submitted? (owner to do; record date and reference). Ask Amazon explicitly: (a) whether personal-use, open-source tools can be approved; (b) whether a cross-service migration tool is permitted under the "third-party music service" clause; (c) whether users may use their own security profiles.
2. **Loopback redirect**: does an LWA security profile accept `http://127.0.0.1:<port>` or `http://localhost:<port>` as an Allowed Return URL? (Not documented. Test after access.)
3. **Code-based linking with `music::*` scopes** for non-device (desktop/CLI) clients: not publicly documented.
4. **V1 add-tracks batch size** (`PUT /playlists/{id}/tracks`): not documented. V2 documents 100.
5. **Refresh-token lifetime** and whether a refresh is possible without `client_secret`: not documented beyond "no refresh token is returned" when no secret is sent.
6. **TPS numbers** per endpoint: not published.
7. **Markets list and subscription tiers** allowed to create playlists: not published.
8. **Fallback tooling**: which Amazon-authorized third-party importers accept sple's CSV, and in what column layout. Needs a separate check before we document the hand-off.
9. **Project decision**: re-open requirements §10 Q6 (second provider) given this ADR.
