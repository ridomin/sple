# Changelog

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
