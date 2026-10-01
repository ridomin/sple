# ADR 0005: Canonical track model

- **Status:** Accepted (2026-10-01)
- **Date:** 2026-10-01
- **Deciders:** project owner (user); architect (author)
- **Related:** `docs/requirements.md` FR-MIG-1, FR-MIG-2, FR-MIG-4; ADR 0003 (Provider interface); ADR 0004 (Token store)
- **Supersedes:** n/a (first canonical track design)

## Context

FR-MIG-1 and FR-MIG-2 require cross-provider playlist migration. To match tracks across providers with different metadata formats, we need a canonical representation of a track that:

1. **Unifies metadata:** Captures title, artists, album, duration, ISRC, and provider-specific references.
2. **Enables matching:** Supports multiple matching strategies (known reference, ISRC, metadata-based).
3. **Preserves context:** Tracks when a track was added to a playlist.
4. **Is provider-agnostic:** No provider-specific fields; providers map to this model via their adapters.

The `CanonicalTrack` type is the central model for playlist export and migration (S3, S4).

## Decision

### 1. CanonicalTrack interface

A track is represented as:

```ts
export interface CanonicalTrack {
  title: string;                 // Required: track title
  artists: string[];             // Required: artist names (display names, not IDs)
  album?: string;                // Optional: album name (not ID)
  durationMs?: number;           // Optional: track duration in milliseconds
  isrc?: string | null;          // Optional: ISRC code (null if not available)
  refs: Record<string, string>;  // Required: provider IDs → provider-specific track refs
  addedAt?: string;              // Optional: ISO 8601 timestamp (playlist insertion time)
}
```

**Field semantics:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | Yes | The track's canonical title. |
| `artists` | string[] | Yes | Artist display names in the order they appear on the provider (e.g., featured artists). Never empty. |
| `album` | string | No | Album name if available. Not the album ID; use display name. |
| `durationMs` | number | No | Track duration in milliseconds. Absent if the provider doesn't report duration. |
| `isrc` | string \| null | No | International Standard Recording Code (ISRC). Null if the provider doesn't provide it (e.g., Spotify since Feb 2026). Absent if not yet resolved. |
| `refs` | Record<string, string> | Yes | Map of provider ID (e.g., `'spotify'`, `'youtube-music'`) to provider-specific track reference (URI, ID, or API path). At minimum, includes the source provider. As tracks are migrated and matched, refs accumulate. |
| `addedAt` | string | No | ISO 8601 timestamp (UTC) of when the track was added to the source playlist. Used to preserve insertion order and date context during migration. |

### 2. Provider refs (refs field)

`refs` is a multi-provider reference map. When a track is:

1. **First loaded** from a provider (e.g., Spotify), it contains only that provider:
   ```json
   { "refs": { "spotify": "spotify:track:abc123def456" } }
   ```

2. **Matched to another provider** (e.g., during migration to YouTube Music), the matching provider is added:
   ```json
   { "refs": { "spotify": "spotify:track:abc123def456", "youtube-music": "ABCDefg-_1234" } }
   ```

3. **Populated into a destination playlist**, the destination provider's track ref is used (not added to `refs` unless the track is re-queried).

This design allows:
- Tracking the source provider's track ID (crucial for reruns and audits).
- Cross-referencing in multi-provider workflows (S5 and later).
- Graceful degradation if a provider is added or removed later.

### 3. Matching strategies

`CanonicalTrack` supports multiple matching strategies (defined in ADR-0003, but documented here for context):

| Strategy | Input | Matching logic | Reliability |
|---|---|---|---|
| `known-ref` | `refs` map | Direct provider ID lookup if both providers have entries. | Perfect (if refs are accurate). |
| `isrc` | `isrc` field | Search by ISRC on the target provider. | High (ISRC is unique and stable). |
| `metadata` | `title`, `artists`, `album`, `durationMs` | Full-text search or metadata API. | Variable (depends on provider's search algorithm and data quality). |

Adapters attempt strategies in order: known-ref → ISRC → metadata.

### 4. Artist list semantics

The `artists` array is ordered and includes all credited artists (main, featured, remixers, etc.) as reported by the provider. This is crucial for:

- **Metadata matching:** "Artist A feat. Artist B" must match across providers that report them as separate.
- **Display:** Show the canonical artist list as the user sees it on the source provider.
- **Auditing:** Preserve the exact artist credits from the source.

Empty `artists` is an error (every track has at least one artist). If a provider doesn't return artists, adapters supply a fallback (e.g., "Unknown Artist").

### 5. Album optional, duration optional, ISRC nullable

- **Album:** Optional because some providers (e.g., single tracks without an album context) may not have this. Matching can work without it.
- **Duration:** Optional because some read-only APIs (e.g., likes) may not report duration. Matching can work without it.
- **ISRC:** Nullable (not just optional) to distinguish three states:
  - **Absent** (`undefined`): Not yet resolved or not applicable for this track.
  - **Null** (`null`): Provider confirmed it doesn't have ISRC (e.g., Spotify since Feb 2026).
  - **String:** ISRC is present and valid.

### 6. Date context (addedAt)

`addedAt` preserves the original playlist's insertion date. It is:

- **Read** when exporting (S3): included in the export format.
- **Preserved** during migration (S4): added to the destination playlist in the same order (or as close as possible; some providers sort by date).
- **Optional** for search results and library reads: only playlists carry insertion dates.

Format: ISO 8601 UTC (e.g., `"2026-09-01T12:34:56Z"`).

## Alternatives considered

- **Flat string identifiers** (one "canonical ID" per track). Rejected: providers use incompatible ID schemes; a flat ID can't express multi-provider refs.
- **Numeric IDs** (sple-assigned sequential IDs). Rejected: migrating to a new provider requires re-querying all tracks; numeric IDs provide no value for cross-provider matching.
- **Embedded provider objects** (one `spotify: { ... }`, one `youtube: { ... }`). Rejected: less flexible than `refs` map; adds coupling to known provider IDs.
- **ISRC as required field.** Rejected: Spotify no longer provides ISRC (Feb 2026); metadata-based matching is a fallback.
- **ISO 8601 string for duration.** Rejected: milliseconds are simpler for calculations and match provider APIs (Spotify, YouTube both use ms).

## Consequences

- M0 defines this interface in `src/core/provider/provider.ts` (already in ADR-0003, but this ADR clarifies semantics).
- M1 (S3) implements playlist export in this format; M1 (S4) implements migration using these matching strategies.
- Test data and fixtures for M1 spike tests will use `CanonicalTrack` instances with various combinations of optional fields.
- Adapters must implement a `resolveTrack()` method that takes a `CanonicalTrack` and returns `MatchCandidate[]` (ref + confidence + strategy). See ADR-0003 § 3.
- The `addedAt` field enables date-preserving migrations; lack of it is acceptable for non-playlist contexts (search results, library reads).

## Sources

- `docs/requirements.md` FR-MIG-1, FR-MIG-2, FR-MIG-4.
- Spotify ISRC deprecation (February 2026): https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- ISRC standard: https://www.ifpi.org/isrc/
- ISO 8601 date/time format: https://en.wikipedia.org/wiki/ISO_8601
