# ADR 0007: CLI conventions and output contracts

- **Status:** Accepted (2026-10-02)
- **Date:** 2026-10-02
- **Deciders:** project owner (user); architect (author)
- **Related:** `docs/requirements.md` CLI-1 to CLI-8, NFR-3, NFR-4, FR-SEARCH-1/2/4, FR-PL-1 to FR-PL-4, FR-PL-6, FR-EXP-1/6, FR-AUTH-4; ADR 0003 (Provider interface, incl. Amendment 1); ADR 0005 (Canonical track model); ADR 0008 (Canonical playlist file, M1-25)
- **Supersedes:** n/a

> ADR 0006 (stack) is reserved for M1-29.

## Context

M1 adds the first user-facing commands: `search`, `playlist list|show|create|remove`, `export`, and `auth status` (next to the existing `auth login|logout`). Requirements §6 states the goals (tables on a TTY, `--json`, `--quiet`, stdin chaining, exit codes, logging, progress) but not the details. Without one written contract, each command would pick its own flag handling, output format, error format, and logging, which makes the CLI hard to script against and hard to maintain.

This ADR fixes those details for every M1 command. Commands added later follow the same rules and add their `--json` shape here by amendment.

## Decision

### 1. Command grammar and argument parsing (CLI-1)

- Grammar is `sple <noun> <verb> [args] [flags]`: `sple playlist list`, `sple playlist show`, `sple auth status`.
- `search` and `export` are single-verb nouns: `sple search <query>`, `sple export <playlist…>`. They take no verb.
- Arguments are parsed with `node:util` `parseArgs`, with `strict: true` and `allowPositionals: true`, once per command (the global pass only finds the noun/verb and global flags). Unknown flags, missing flag values, and wrong positional counts are a `UsageError` (exit 2).
- No CLI framework dependency (no yargs, commander, oclif). Help text is hand-written per command.
- `--help`/`-h` on any command prints that command's help to stdout and exits 0. `--version`/`-v` prints `sple v<version>` to stdout and exits 0.
- Global flags, accepted by every command:

| Flag | Meaning |
|---|---|
| `--provider <id>` | Provider to use (CLI-5); default from config |
| `--json` | JSON output (§2.3) |
| `--quiet` | IDs only (§2.4) |
| `--verbose` | Info logs on stderr (§6) |
| `--debug` | `--verbose` plus HTTP request lines (§6) |
| `--help`, `-h` / `--version`, `-v` | As above |

Flags may appear before or after positionals. `--` ends flag parsing (so a search query may start with `-`).

### 2. Output modes (CLI-2)

stdout carries only the command's result. Everything else (errors, warnings, summaries, logs, progress, prompts) goes to stderr.

Mode selection, in order:

1. `--json` and `--quiet` together → `UsageError`, exit 2.
2. `--json` → JSON (§2.3).
3. `--quiet` → IDs (§2.4).
4. `process.stdout.isTTY` is true → table (§2.1).
5. Otherwise → tab-separated text (§2.2).

#### 2.1 Table (default, stdout is a TTY)

- List results: a header row, then one row per item, with columns padded to their widest value.
- The table fits `process.stdout.columns` (80 if unknown). When too wide, the command's designated flexible columns (title, name, album, artists) shrink, widest first, and their values are cut with `…`. ID columns are never truncated.
- Single-result commands (`playlist create`, `playlist remove`) print one human sentence instead of a table, e.g. `Created playlist "Road trip" (3cEYpjA9oz9GiPac4AsH4n) https://open.spotify.com/playlist/…`.
- ANSI colors and bold headers only when the target stream is a TTY and the `NO_COLOR` environment variable is unset or empty. The same rule applies to stderr independently.
- An empty list prints nothing on stdout and `No results.` (or `No playlists.`) on stderr; exit 0.
- Values: durations `m:ss` (`h:mm:ss` from one hour), dates as local `YYYY-MM-DD`, booleans `yes`/`no`, missing values empty.

#### 2.2 Tab-separated (default, stdout is not a TTY)

- Same columns, same order as the table. **No header row**, no padding, no truncation, no colors.
- One line per item, fields separated by a single `\t`, lines ending in `\n`.
- Tabs, CR and LF inside values are replaced by a single space. No quoting.
- Values: durations in `m:ss` as in the table, timestamps as ISO 8601 UTC, booleans `true`/`false`, missing values empty.
- Single-result commands print one row (columns in §2.5).

The stable machine contract is `--json`. TSV column order may gain columns at the end in a minor release, but existing columns are not reordered or removed.

#### 2.3 `--json`

- stdout gets exactly one JSON document, the command's shape from §3, pretty-printed with 2-space indentation and a trailing newline. Nothing else is written to stdout.
- Progress is disabled; colors never apply.
- Field rules: optional fields are omitted, not `null`, except where a type says `| null` (`isrc`, ADR 0005). Timestamps are ISO 8601 UTC strings. Key order is not part of the contract.
- **Stability:** within a major version, shapes only change additively (new optional fields, new union members announced in the changelog). Fields are never renamed, removed, or retyped. Consumers must ignore unknown fields.
- On failure, see §4.

#### 2.4 `--quiet`

- stdout gets one ID per line and nothing else; no header, no summary. Warnings and errors still go to stderr (logs only with `--verbose`/`--debug`).
- Progress is disabled.
- The ID per command is in the §2.5 table. Every printed value is accepted back by `parsePlaylistRef` where it denotes a playlist, so `sple playlist list --quiet | sple export - -o out/` works.

#### 2.5 Columns and quiet values per command

| Command | Table / TSV columns | `--quiet` prints |
|---|---|---|
| `search --type track` | title, artists (`, `-joined), album, duration, id | `id` |
| `search --type album` | name, artists, release date, tracks, id | `id` |
| `search --type artist` | name, id | `id` |
| `search --type playlist` | name, owner, tracks, id | `id` |
| `playlist list` | name, id, tracks, owner, owned, public, collaborative | `id` |
| `playlist show` | #, title, artists, album, duration, added at, id | track ref for the active provider (`refs[provider]`) |
| `playlist create` | TSV: id, name, url | `id` |
| `playlist remove` | TSV: action, id, name | `id` |
| `export` (to files) | path, format, tracks | `path` |
| `auth status` | provider, logged in, user, user id, scopes (space-joined), expires | IDs of logged-in providers |

For `export` writing to stdout (one source, no `-o`), stdout is the exported file itself, see §3.6.

#### 2.6 Dry run (FR-PL-6)

`--dry-run` makes no write calls. The planned result is printed in the active mode: TTY as a sentence prefixed `[dry-run] Would …`, TSV and `--quiet` as for a real run (for `create`, the TSV `id` is empty and `--quiet` prints nothing), `--json` with `dryRun: true` (§3.4, §3.5).

### 3. JSON output shapes

These types are the contract. They live in `src/cli/output/types.ts` (created by the first command that needs them) and command tests check their output with `satisfies`.

Shared types come from `src/core/provider/provider.ts`: `CanonicalTrack` (ADR 0005), `PlaylistSummary` (ADR 0003), `SearchItem` (ADR 0003 Amendment 1 / M1-7), and `ProviderId`.

```ts
// Shared
export interface PageInfo {
  /** Present when more results exist; pass back as --offset (offset providers). */
  next?: { offset?: number; cursor?: string }
  /** Total results reported by the provider, when it reports one. */
  total?: number
}

export interface UnsupportedItem {
  position: number                     // 1-based, in the playlist's order
  kind: 'local' | 'episode' | 'unavailable'
  name?: string
  ref?: string
}

export interface ErrorInfo {
  type: string                         // error class name, see §4
  message: string
  exitCode: number
}

export interface ErrorOutput {
  error: ErrorInfo
}
```

#### 3.1 `sple search`

```ts
export interface SearchOutput extends PageInfo {
  items: SearchItem[]
}
```

`next` is set when `--limit` or the `--all` cap stopped before the provider ran out of results.

#### 3.2 `sple playlist list`

```ts
export interface PlaylistListOutput extends PageInfo {
  playlists: PlaylistSummary[]
}
```

`list` always reads every page, so in M1 `next` is always absent and `total` is the number of playlists returned after `--owned`/`--followed`/`--filter`.

#### 3.3 `sple playlist show`

```ts
export interface PlaylistShowOutput {
  playlist: PlaylistSummary
  tracks: Array<CanonicalTrack & { position: number }>   // position 1-based; addedAt from CanonicalTrack
  unsupportedItems: UnsupportedItem[]
}
```

Positions number every item in the playlist, supported or not, so `tracks` and `unsupportedItems` together cover `1..n` without gaps. A playlist whose tracks are not readable fails before any output (exit 1, FR-PL-2).

#### 3.4 `sple playlist create`

```ts
export type PlaylistCreateOutput =
  | {
      dryRun: false
      id: string
      ref: string
      name: string
      description?: string
      url?: string
      owner: { id: string; displayName?: string }
      public: boolean
      collaborative: boolean
    }
  | {
      dryRun: true                     // nothing created, so no id/ref/url/owner
      name: string
      description?: string
      public: boolean
      collaborative: boolean
    }
```

#### 3.5 `sple playlist remove`

```ts
export interface PlaylistRemoveOutput {
  dryRun: boolean
  /** From capabilities.canDeletePlaylist: false → 'unfollowed' (Spotify), true → 'deleted'. With dryRun, the action that would be taken. */
  action: 'unfollowed' | 'deleted'
  playlist: { id: string; ref: string; name: string }
}
```

#### 3.6 `sple export`

```ts
export interface ExportOutput {
  files: Array<{
    path: string                       // absolute path written
    format: 'json' | 'csv'
    source: { kind: 'playlist' | 'liked'; id?: string; name: string }
    trackCount: number
    unsupportedCount: number
  }>
  skipped: Array<{
    input: string                      // the ref as given on the command line or stdin
    error: ErrorInfo
  }>
}
```

This shape applies only when export writes files (`-o` given). When export writes the data to stdout (one source, no `-o`), stdout is the export file itself (ADR 0008 JSON, or CSV), and `--json` is a `UsageError` (exit 2): use `--format json` for the data. `--quiet` in that case only suppresses progress and the summary.

#### 3.7 `sple auth status`

```ts
export interface AuthStatusOutput {
  providers: Array<{
    id: ProviderId
    loggedIn: boolean
    user?: { id: string; displayName?: string }
    scopes: string[]                   // granted scopes; empty when not logged in
    expiresAt?: string                 // access-token expiry, ISO 8601 UTC
  }>
}
```

Without `--provider`, there is one entry per registered provider (CLI-5, FR-AUTH-4); with it, exactly one. `auth status` exits 0 whether or not the provider is logged in; scripts read `loggedIn`.

`auth login` and `auth logout` are interactive and have no `--json` contract in M1; `--json` on them is a `UsageError` (exit 2). `--quiet` suppresses their informational output.

### 4. Errors (CLI-4)

- Errors and warnings always go to stderr, as `sple: <message>` (warnings: `sple: warning: <message>`). Messages come from `formatErrorMessage` in `src/cli/exit-codes.ts`; exit codes from `getExitCode` / `EXIT_CODES` in the same file:

| Code | Meaning | Error types |
|---|---|---|
| 0 | Success (warnings allowed) | |
| 1 | General error | `AccessRestrictedError`, `ProviderError`, unexpected `Error`, partial failure |
| 2 | Usage error | `UsageError` (incl. `parseArgs` failures, ambiguous names) |
| 3 | Auth required | `AuthRequiredError` |
| 4 | Not found | `NotFoundError` |
| 5 | Rate limit / quota exhausted | `RateLimitError` (after retries), `QuotaExhaustedError` |

- With `--json`, when the exit code is not 0, the **last line** written to stderr is one compact (single-line) `ErrorOutput`:
  ```json
  {"error":{"type":"AuthRequiredError","message":"Authentication required. Run \"sple auth login\" to log in.","exitCode":3}}
  ```
  `type` is the error class name from `src/core/provider/errors.ts`, `Error` for unexpected errors, or `PartialFailure` (§5). The human `sple: …` message is still written before it. stdout gets nothing, unless the command produced a partial result (§5).
- Stack traces are printed only with `--debug`.

### 5. Partial failure (NFR-4)

Applies to commands that process several items. In M1 that is `export` with several playlists; `show` and `remove` take exactly one.

- **Before any item is processed**, the command validates flags, reads stdin, and resolves every input to a playlist. Any usage problem, including an ambiguous name, exits 2 and nothing is written.
- Then each item is processed in order. A per-item failure (not readable, not found, provider error) is reported on stderr as it happens and the command continues with the next item.
- `AuthRequiredError` and `QuotaExhaustedError`/`RateLimitError` (after retries) stop the remaining items, since they would fail the same way; the remaining items are reported as skipped with that error.
- At the end, a summary goes to stderr: `sple: exported 3 of 5 playlists; 2 skipped (see above)`.
- Successful items are kept (files stay written). With `--json`, stdout gets the full `ExportOutput` including `skipped`; with `--quiet`, the paths that were written.
- Exit code: 0 if no item failed. Otherwise the highest-priority code among failed items, in the order **3 > 5 > 4 > 1**. With `--json`, the stderr `ErrorOutput` has `type: "PartialFailure"` and that exit code.

### 6. Logging (CLI-7)

- All log output goes to stderr. With neither flag, only errors, warnings and summaries are printed.
- `--verbose`: info logs, one line each, as `sple:<namespace> <message>` (namespaces such as `sple:auth`, `sple:export`, `sple:resolve`). Implemented in-house, no `debug` dependency.
- `--debug`: everything from `--verbose`, plus one line per HTTP request after it completes (and per retry):
  ```
  sple:http GET /v1/playlists/3cEY…/items?limit=100&offset=0 200 143ms
  ```
  Method, path with query string, status (or `ERR <code>` for network errors), duration, and retry count when > 0. Host is shown only for non-API hosts such as the token endpoint.
- **Never logged**, at any level: request or response headers, request bodies, response bodies of the token endpoint, and the contents of `tokens.json` or the config file. Response bodies of other endpoints are not logged in M1 either.
- **Redaction**: every log line and every error message passes through one redaction function before it is written:
  - `Bearer \S+` → `Bearer [REDACTED]`
  - query or form parameters `access_token`, `refresh_token`, `code`, `code_verifier`, `client_secret` (`\b<name>=[^&\s]+`) → `<name>=[REDACTED]`
  - JSON fields `"access_token"`, `"refresh_token"`, `"id_token"`, `"client_secret"` → `"<name>":"[REDACTED]"`
  - Tests feed known token strings through every log path and assert none reach stderr.

### 7. Stdin input (CLI-3)

- A playlist argument of `-` reads playlist refs from stdin: one per line, trimmed, CRLF accepted. Blank lines and lines whose first non-space character is `#` are ignored. Each line is a ref in any form `<playlist>` accepts (ID, URI, URL, or name).
- `-` may appear at most once and cannot be combined with other playlist arguments (exit 2).
- If stdin is a TTY, or it yields no refs, the command exits 2.
- `playlist show -` and `playlist remove -` need exactly one ref on stdin; zero or more than one → exit 2.
- `playlist remove -` needs `--yes`, because stdin is consumed and cannot answer the confirmation prompt. Without it → exit 2. More generally, `remove` without `--yes` exits 2 whenever stdin is not a TTY.
- Confirmation prompts are written to stderr and read from stdin.

### 8. Progress (CLI-8)

- Shown only when `process.stderr.isTTY` is true **and** neither `--quiet` nor `--json` is set.
- One line on stderr, redrawn in place with `\r`, at most 10 times per second: a label and counts, with a bar when the total is known, e.g. `Exporting "Road trip" [######----] 600/1000 tracks`; a spinner and count when it is not.
- The line is cleared before any other stderr output (logs, warnings) and when the operation ends, so it never mixes with other output.
- Used by `playlist list` (pages), `playlist show` and `export` (tracks per playlist; for several playlists, also `2/5 playlists`).

## Rationale

- **Consistency:** one grammar, one flag set, one mode-selection rule and one error format make every command predictable and easier to document (M1-29 `docs/user/commands.md` links here).
- **Scripting:** `--json` gives a typed, versioned contract; `--quiet` and stdin `-` make commands chain without `jq`.
- **Graceful degradation:** TTY detection gives people tables and colors and gives pipes plain, header-less TSV that `cut`/`awk` can read without stripping decorations. This settles open question 6 of the M1 plan.
- **Security:** a single redaction pass and a short list of what may be logged keep tokens out of logs, terminals and bug reports (CLI-7, NFR-3).
- **Accessibility:** colors respect `NO_COLOR` and TTY; progress only animates on an interactive stderr, so screen readers, CI logs and pipes are not flooded with redraws.
- **Reliability:** resolving all inputs up front and then continuing past per-item failures matches NFR-4: no silent aborts, nothing half-done because of a typo.

## Consequences

- Every M1 data command implements table, TSV, `--json` and `--quiet`. A shared output module (formatters, table layout, TSV escaping, error writer, progress, redaction, logger) is built once and used by all commands.
- Each command has a test per mode, and its `--json` output is checked against the §3 type with `satisfies`. Changing a shape requires an amendment to this ADR.
- Logging and error paths must go through the redaction function; a test asserts no token leaks at `--debug`.
- `export` must resolve all inputs before writing anything, which costs one playlist-list read when names are used.
- TSV output is lighter than JSON but not a full contract; users who need stability are pointed to `--json`.
- ADR 0008 (canonical file) should use the same 1-based `position` and the same `UnsupportedItem` shape.

## Alternatives considered

- **CLI framework (yargs, commander, oclif):** rejected. `parseArgs` covers the flags M1 needs, keeps the dependency footprint at zero, and avoids framework-specific help/output conventions.
- **Colors always on:** rejected. Breaks pipes and files, and ignores `NO_COLOR` and non-interactive users.
- **Tables also when not a TTY (rely on `--json` for scripts):** rejected. Padded, truncated tables are fragile to parse, and truncation silently loses data in pipes.
- **TSV with a header row:** rejected. Headers have to be stripped in every pipe (`tail -n +2`), and `--json` already serves self-describing output.
- **Errors as JSON on stdout with `--json`:** rejected. stdout would carry two shapes, and `cmd --json | jq` would treat an error as data.
- **Abort on first failure in multi-item commands:** rejected by NFR-4.
- **Logging with the `debug` package:** rejected. A small in-house logger with mandatory redaction is less code than wrapping a dependency so it cannot bypass redaction.
