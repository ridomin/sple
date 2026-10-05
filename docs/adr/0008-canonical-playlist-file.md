# ADR 0008: Canonical playlist file

- **Status:** Accepted (2026-10-02)
- **Date:** 2026-10-02
- **Deciders:** project owner (user); architect (author)
- **Related:** `docs/requirements.md` FR-EXP-1, FR-EXP-2, FR-EXP-3, FR-EXP-6, FR-EXP-7, FR-EXP-8, NFR-9; ADR 0005 (Canonical track model); ADR 0007 (CLI conventions, §2.5 `UnsupportedItem`, §3.6 `export`)
- **Supersedes:** n/a

## Context

`sple export` (M1-26) writes playlists to files. FR-EXP-2 requires a lossless, versioned JSON format that is also the hand-off format for import and migration (FR-EXP-7, M3/M4). FR-EXP-3 requires a CSV for spreadsheets. FR-EXP-8 requires the JSON format to be documented and published as a JSON Schema. Liked Songs (FR-EXP-6) must be exported "in the same formats as a playlist".

This ADR fixes the v1 JSON shape, the schema, the CSV dialect and columns, and the rules for changing them.

## Decision

### 1. `CanonicalPlaylistFile` v1

Defined in `src/core/export/format.ts`:

```ts
export interface CanonicalPlaylistFile {
  schemaVersion: 1
  exportedAt: string                                   // ISO 8601 UTC
  generator: { name: 'sple'; version: string }
  source: { provider: ProviderId; kind: 'playlist' | 'liked'; userId?: string }
  playlist: {
    ref?: string; id?: string; name: string; description?: string
    owner?: { id: string; displayName?: string }
    public?: boolean; collaborative?: boolean; url?: string
    trackCount: number
  }
  tracks: Array<CanonicalTrack & { position: number }>
  unsupportedItems: Array<{
    position: number
    kind: 'local' | 'episode' | 'unavailable'
    name?: string; ref?: string
  }>
}
```

Field rules:

| Field | Rule |
|---|---|
| `schemaVersion` | Always `1` for this ADR. Readers must reject other values unless they implement them. |
| `exportedAt` | ISO 8601 in UTC with a `Z` suffix (`Date#toISOString()`). |
| `generator` | `name` is always `sple`; `version` is the package version that wrote the file. |
| `source.provider` | Provider ID (`spotify`, `youtube-music`, …). The schema accepts any lower-case ID so new providers do not need a schema change. |
| `source.kind` | `playlist` for a playlist, `liked` for the saved-tracks library. |
| `source.userId` | The provider user ID of the account that exported, when known. |
| `playlist.*` | Copied from `PlaylistSummary` (ADR 0003). `owned` and `itemsReadable` are not exported: they describe the exporting account, not the playlist. |
| `playlist.trackCount` | The number of items **in this file**: `tracks.length + unsupportedItems.length`. Not the provider's reported total, which can drift during a read. |
| `tracks[]` | `CanonicalTrack` (ADR 0005) plus `position`. `isrc: null` (provider has none) and an absent `isrc` (unknown) stay distinct. |
| `position` | 1-based in the source order, same as ADR 0007 §3.3. `tracks` and `unsupportedItems` share one position space: together they cover `1..trackCount` without duplicates. |
| `unsupportedItems[]` | Same shape as ADR 0007 `UnsupportedItem`: local files, podcast episodes, and items the provider reports as unavailable. Kept so a reader knows what was not exported and where it was. |

Liked Songs: `source.kind` is `liked` and `playlist.name` is `"Liked Songs"`. `ref`, `id`, `owner`, `url` etc. are usually absent. `createPlaylistFile()` sets the name; the schema enforces it with an `if`/`then`.

### 2. JSON serialization

`writeJSON(file)` in `src/core/export/json-writer.ts`:

- Checks the v1 invariants (`assertPlaylistFile`, including ones the schema can't express: unique positions and `trackCount`) and throws `ExportFormatError` on a violation. No runtime schema-validator dependency.
- Copies only v1 fields in a fixed key order (extra runtime properties never leak), sorts `tracks` and `unsupportedItems` by `position`, drops `undefined`, keeps `null`.
- Output: UTF-8, 2-space indent, trailing `\n`.

### 3. JSON Schema

`schemas/canonical-playlist.v1.schema.json`, JSON Schema draft 2020-12, `$id` `https://raw.githubusercontent.com/ridomin/sple/main/schemas/canonical-playlist.v1.schema.json`.

- `additionalProperties: false` on every object except `refs` (a map keyed by provider ID).
- Shipped in the npm package and exposed as the package export `sple/schemas/canonical-playlist.v1.schema.json`.
- Tests validate every `writeJSON` output against it with Ajv (dev dependency only). The schema is also compiled in Ajv strict mode, which catches schema mistakes.

### 4. CSV

`writeCSV(file)` in `src/core/export/csv-writer.ts`:

- Dialect: RFC 4180. Comma separator, CRLF after every record including the last, header row first. UTF-8 **without** BOM.
- A cell is quoted only if it contains `"`, `,`, CR or LF; embedded `"` is doubled.
- Columns: `position,title,artists,album,duration_ms,added_at,isrc,ref`.
  - `artists` joined with `; `. Lossy if an artist name contains `; `; JSON is the lossless format.
  - `isrc`: empty for `null` and for absent.
  - `ref`: the track's ref for `source.provider` (empty if missing). Other providers' refs are JSON-only.
  - Absent optional fields are empty cells.
- One row per track, in position order. `unsupportedItems` are not written, so positions can have gaps.
- Cell values are written unchanged. Values starting with `=`, `+`, `-` or `@` are **not** escaped (M1 plan open question 8, proposed answer). Spreadsheet formula injection is a documented risk of opening CSVs from untrusted playlists; a `--csv-safe` option can be added later without changing this format.
- CSV has no file-level metadata (playlist name, exportedAt, provider). Use JSON when that is needed.

### 5. Versioning

- Adding an optional field, or a new `unsupportedItems.kind`, is still a schema change because objects are closed. It ships as `schemaVersion: 2` with a new `canonical-playlist.v2.schema.json`; the v1 schema file is never edited after release except for fixes that do not change which documents are valid.
- `sple import` (FR-EXP-7) will read every version it knows and reject newer ones with a clear message.
- Changing the CSV columns requires an amendment to this ADR.

### 6. Data ownership

Export files belong to the user and are outside `sple`'s data retention (FR-EXP-8, NFR-9). `sple` writes them where the user asks and never reads, uploads or deletes them on its own. `docs/user/export-format.md` (M1-29) states this and links to the schema.

## Alternatives considered

- **Open objects (`additionalProperties` allowed).** Rejected: closed objects make the schema a real contract, and tests catch accidental fields from the provider layer. The cost is a new version for every addition, which is acceptable for a hand-off format.
- **`trackCount` = provider total.** Rejected: it can disagree with the file contents (playlist edited mid-read, unsupported items), and consumers would have no consistency check.
- **Drop unsupported items.** Rejected: migration and audits need to know what was skipped and where.
- **CSV with a BOM** (helps Excel detect UTF-8). Rejected: breaks many command-line tools and is not part of RFC 4180. Users can import with an explicit UTF-8 encoding.
- **One CSV column per provider ref.** Rejected: columns would depend on the data. JSON carries all refs.
- **Runtime validation with Ajv.** Rejected: a dependency for a check the writer can do on its own typed input. Ajv is a dev dependency used by tests.

## Consequences

- M1-26 builds files with `createPlaylistFile()` and writes them with `writeJSON`/`writeCSV`; atomic file writes and naming are M1-26's job.
- M3 import reads v1 files; the schema is the reference for third-party tools.
- Any change to `CanonicalTrack` (ADR 0005) that should appear in exports needs a schema version bump.

## Sources

- RFC 4180, Common Format and MIME Type for CSV Files: https://www.rfc-editor.org/rfc/rfc4180
- JSON Schema 2020-12: https://json-schema.org/draft/2020-12
- OWASP, CSV Injection: https://owasp.org/www-community/attacks/CSV_Injection
