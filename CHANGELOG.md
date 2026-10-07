# Changelog

## Unreleased (YouTube Music M4a)

### Added

- **YouTube quota ledger:** daily `units` (10,000) and `search` (100) buckets, reset at midnight Pacific Time. A call that would overdraw a bucket is refused before it's sent (exit 5, with the reset time). Usage is kept in `quota.json` (#84).
- **YouTube read gaps closed:** `search --type playlist|artist` (`album` is a usage error), `playlist list --followed` (always empty on YouTube), correct ownership in `getPlaylist`, and Liked Songs export from the `LM` playlist (#85, spike S5).
- **Per-operation YouTube scope table:** reads accept `youtube.readonly` or `youtube`, writes need `youtube` (#83).
- **`auth login` warns** when you declined a requested permission on the consent screen (#72).
- **`auth status` shows the refresh-token expiry** when the provider limits it (Google apps in Testing status: 7 days) (#80).
- **Docs:** [YouTube Music setup](docs/user/youtube-music-setup.md), [privacy policy](docs/PRIVACY.md) (#86), [logging](docs/user/logging.md), [CONTRIBUTING.md](CONTRIBUTING.md), a rewritten [import guide](docs/user/import.md) (#71).
- **Spikes S5–S7 reported** ([report](docs/spikes/M4a-youtube-spikes.md)): `LM` is readable (S5); a Google Desktop client needs its secret even with PKCE (S6); the playlist-creation cap was not measured (S7) (#82).
- **Tooling:** `npm run check:stubs` in CI (#74); a shared auth contract test suite for every OAuth provider (#75), built on recorded, sanitized API responses (#76).

### Fixed

- **YouTube:** a partially granted login was stored as fully granted, so every call failed with `insufficientPermissions`. sple now stores the granted scopes, checks them before each call, and maps that 403 to a missing-scope error (#72).
- **YouTube:** an expired refresh token was reported as "not logged in". It's now `authorization expired or was revoked … run "sple auth login --provider youtube-music"` (exit 3) (#80).
- **YouTube:** `auth status` no longer refreshes over the network. Logout reports `revoked` truthfully and lists only what it deletes (#80, #83).
- **Spotify:** login stored no scopes when the token response had no `scope` field, and never warned about declined scopes (#75).

## [M3.3] 2026-10-07 — Spec conformance

Fixes from the spec review that made requirements and ADRs complete enough for ports (#37).

### Matching and import

- A candidate with no title similarity was accepted, so the wrong song could be added. Scoring and normalization now follow ADR 0009 Amendment 1, folding accents and typographic punctuation (#25, #30).
- Auth, quota and rate-limit errors stop the import instead of marking the remaining tracks unmatched (#43).
- `Provider.searchTracks(TrackQuery)`: core no longer builds provider query syntax (#39).
- Spotify `populatePlaylist` and `searchTracks` are implemented, so imports to Spotify no longer create an empty playlist (#40).
- `parseTrackRef` and canonical track and playlist refs for every adapter (#41).
- The file reader follows ADR 0008 Amendment 1: CSV source inference and strict JSON validation (#42).
- Match report v1, with `schemaVersion`, `minConfidence` and the full strategy list (#44).
- `import` follows the ADR 0007 A9 output contract: `--json`, `--quiet`, and exit 1 when you decline (#45).

### Providers

- YouTube: 409 inserts are retried, error reasons are kept, a quota 403 is reported as quota, and `--debug` shows HTTP lines (#27).
- YouTube matching searches the Music category, prefers "Artist - Topic" uploads, and parses artist and title from video titles (ADR 0002 Amendment 1) (#29).
- Spotify export includes the ISRC (`external_ids.isrc`) (#28).
- Reads use a per-provider `readPageSize` instead of the write batch size, so YouTube no longer reads one item per request (#38).

### CLI, config and logging

- `auth status` reports an expired token as expired (#31). `auth login` and `logout` honor `--quiet` (#48).
- `playlist remove --dry-run` says on stderr that it was a dry run (#34).
- The fake provider is hidden unless `SPLE_ENABLE_FAKE_PROVIDER=1` (#46).
- `tokens.json` is written atomically with mode 0600, and a group- or world-readable `.env` triggers a warning (#47).
- All logging goes through `debug` namespaces (`DEBUG=sple:*`) with redaction (#49).

## [M3] 2026-10-05 — Import and Matching

### Added

- **Import command:** `sple import <file> [--provider X] [--name ...] [--report path] [--min-confidence n] [--dry-run] [--yes]` reads a canonical export file and matches its tracks on the target provider.
- **Matching engine:** Three-strategy chain (known ref -> ISRC -> metadata) with confidence scoring. Metadata strategy uses normalized title/artist comparison.
- **Match report:** Human-readable and JSON formats listing matched, low-confidence, unmatched and unsupported items with recommendations.
- **Canonical file reader:** Parses JSON and CSV export files for import.
- **Docs:** User guide (`docs/user/import.md`), developer guide (`docs/dev/matching-strategy.md`), ADR 0009.
- **E2E tests:** `tests/e2e/import.test.ts` (fake provider, no network).

### Known gaps

- Playlist creation on the target provider is not implemented yet; `sple import` currently stops after the match report (placeholder message).

### Test Coverage (line %, node --experimental-test-coverage)

- Matching (`src/core/matching`): engine 95.8%, normalizer 100%, strategies 100% (metadata branches 84.6%)
- Import (`src/core/import`): file reader 100%, report writer 100%; `src/cli/commands/import.ts` 94.3%
- Overall: 93.2% lines, 90.0% branches, 90.1% functions (826 tests passing)

### Next Steps (M3.1+)

- Playlist creation from matched tracks
- Resumable imports with progress checkpoints (FR-MIG-4)
- Interactive match review mode (`--review`, FR-MIG-3)
- Low-confidence match override file
