# ADR 0007: CLI conventions and output contracts

- **Status:** Accepted (2026-10-02); amended 2026-10-07 (Amendment 1)
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
| `--yes` | Answer yes to confirmation prompts (Amendment 1) |
| `--help`, `-h` / `--version`, `-v` | As above |

Flags may appear before or after positionals. `--` ends flag parsing (so a search query may start with `-`). Global flags are recognised anywhere before `--`; `--help`/`-h` is global only before the command name (after it, the command prints its own help).

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

`--dry-run` makes no write calls. The planned result is printed in the active mode: TTY as a sentence prefixed `[dry-run] Would …`, TSV and `--quiet` as for a real run (for `create`, the TSV `id` is empty and `--quiet` prints nothing), `--json` with `dryRun: true` (§3.4, §3.5). Because a TSV row cannot show that nothing changed, TSV mode also prints the `[dry-run] Would …` sentence on **stderr** (#34); stdout stays the same as a real run, so pipes are unaffected.

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

~~Positions number every item in the playlist, supported or not.~~ **Amendment 1:** providers drop unsupported items (local files, episodes, unavailable), so positions number the returned tracks `1..k` without gaps and `unsupportedItems` is always `[]` for now. When the provider reports a `total` larger than `k`, stderr gets `sple: warning: <total-k> of <total> items in "<name>" are not supported (local files, podcast episodes, or unavailable tracks) and are not shown`. A playlist whose tracks are not readable fails before any output (exit 1, FR-PL-2).

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
    refreshTokenExpiresAt?: string     // refresh-token expiry when the provider limits it, ISO 8601 UTC (Amendment 2)
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

Applies to commands that process several items: `export` with several playlists, and adding tracks in `import` (Amendment 1). `show` and `remove` take exactly one.

- **Before any item is processed**, the command validates flags, reads stdin, and resolves every input to a playlist. Any usage problem, including an ambiguous name, exits 2 and nothing is written.
- Then each item is processed in order. A per-item failure (not readable, not found, provider error) is reported on stderr as it happens and the command continues with the next item.
- `AuthRequiredError` and `QuotaExhaustedError`/`RateLimitError` (after retries) stop the remaining items, since they would fail the same way; the remaining items are reported as skipped with that error.
- At the end, a summary goes to stderr: `sple: exported 3 of 5 playlists; 2 skipped (see above)`.
- Successful items are kept (files stay written). With `--json`, stdout gets the full `ExportOutput` including `skipped`; with `--quiet`, the paths that were written.
- Exit code: 0 if no item failed. Otherwise the highest-priority code among failed items, in the order **3 > 5 > 4 > 1**. With `--json`, the stderr `ErrorOutput` has `type: "PartialFailure"` and that exit code.

### 6. Logging (CLI-7)

- All log output goes to stderr. With neither flag, only errors, warnings and summaries are printed.
- `--verbose`: info logs, one line each, as `sple:<namespace> <message>` (namespaces such as `sple:auth`, `sple:export`, `sple:resolve`). Logs are written through the `debug` package so they can be filtered by namespace; see A11, which supersedes the original "in-house, no `debug` dependency" rule.
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
- **Logging with the `debug` package:** originally rejected because a dependency could bypass redaction. Reversed by A11: `debug` gives `DEBUG=<pattern>` namespace filtering for free, and replacing its single output function makes redaction mandatory.

## Amendment 1 (spec review for ports)

- **Date:** 2026-10-07
- **Why:** record the per-command rules M1–M3 implemented, add the `import` contract, and settle the unsupported-items question, so the CLI can be rebuilt in another language with the same behavior. Differences in the TypeScript code are tracked in `docs/requirements.md` §12.

### A1. Global behavior

- `--yes` is a global flag; commands also accept it after their name.
- `--version`/`-v` anywhere prints `sple v<version>` and exits 0. `sple` with no command, or `--help` before the command, prints the root help and exits 0.
- An unknown option before the command, an unknown command, or a missing `--provider` value → exit 2.
- `migrate` is a reserved command: `Command 'migrate' is available in a later release` (exit 2).
- `--provider` choices in help and messages list registered providers only (`fake` only with `SPLE_ENABLE_FAKE_PROVIDER=1`).
- `--json` and `--quiet` together are rejected before any request (exit 2).
- Table headers are the column names below, lower-case. Flexible (shrinkable) columns are `title`, `name`, `album`, `artists`, `description`, `url`.

### A2. Error messages (§4)

`sple: <message>` where `<message>` is built from the error type (ADR 0003 §4), then redacted (§6):

| Error | Message |
|---|---|
| `AuthRequiredError` with `scope` | `Missing scope '<scope>'. Run "sple auth login" to grant <scope>` |
| `AuthRequiredError` without `scope` | `Authentication required. Run "sple auth login" to log in.` |
| `NotFoundError` | `<resourceType> not found: <message>` |
| `QuotaExhaustedError` | `Quota exhausted: <bucket>` plus ` (resets at <ISO>)` when `resetAt` is known |
| `RateLimitError` | `Rate limited. Please try again later.` plus ` Retry after <ceil(retryAfterMs/1000)>s.` when known |
| `AccessRestrictedError` | `Access restricted: <message>` |
| anything else | the error's message |

### A3. `search`

`sple search <query…> [--type track|album|artist|playlist] [--limit N] [--offset N | --all [--max-results N]]`

- Positionals are joined with one space to form the query; an empty query → exit 2.
- `--limit` default **10**, integer ≥ 1. `--offset` default 0, integer ≥ 0, and > 0 only on `offset` providers. `--offset + --limit ≤ 1000`.
- `--all` reads until results run out or `--max-results` (default **100**, maximum **1000**) is reached. `--all` with `--offset` or `--limit`, and `--max-results` without `--all`, → exit 2.
- Requests are split into pages of `maxSearchPageSize` (Spotify: `--limit 25` → 10 + 10 + 5).
- `next.offset` is set only on offset providers, when the provider reported more results and the read stopped at the limit or cap, and the next offset is < 1000.
- Columns: track `title, artists, album, duration, id`; album `name, artists, released, tracks, id`; artist `name, id`; playlist `name, owner, tracks, id`. Empty result → stderr `No results for "<query>" in <Provider>`.

### A4. `playlist list`

`sple playlist list [--owned | --followed]` (`--filter` arrives in M2, FR-PL-1). Both flags → exit 2. Reads every page with `readPageSize.playlists`; when the first page reports `total` on an offset provider, the remaining pages are fetched with at most 4 concurrent requests, in order. `--owned` keeps `owned === true`, `--followed` keeps `owned === false`. Empty → stderr `No playlists.`

### A5. `playlist show`

`sple playlist show <playlist|->`. Resolution per ADR 0003 §3.2. Pages of `readPageSize.playlistItems`. A readable playlist the user does not own (on a provider whose access is not `'all'`) prints `sple: note: "<name>" is owned by <owner>; readable via collaborator access` on stderr. The not-readable message (exit 1) is: `cannot read the tracks of "<name>" (owned by <owner>). <Provider> only returns the tracks of playlists you own[ or collaborate on]. Workaround: in the <Provider> app, copy its tracks into a playlist you own, then use that playlist.` Empty playlist → stderr `Playlist "<name>" has no tracks.` `--quiet` prints `refs[<provider>]` per track.

### A6. `playlist create`

`sple playlist create <name> [--description <text>] [--public | --private] [--collaborative] [--dry-run]`

- Exactly one non-empty name (quote names with spaces), else exit 2.
- Default visibility is private. `--public` with `--private` → exit 2. `--collaborative` means private and cannot be combined with `--public` (exit 2). `--collaborative` on a provider without `supportsCollaborative` → exit 2.
- Table sentence: `Created <public|private|collaborative> playlist "<name>" (<id>)[ <url>]`; dry run: `[dry-run] Would create <visibility> playlist "<name>" in <Provider>`.

### A7. `playlist remove`

`sple playlist remove <playlist|-> [--yes] [--dry-run]`

- Confirmation rules are checked before any request: without `--yes` (and not `--dry-run`), `-` input or a non-TTY stdin → exit 2.
- Before the prompt, stderr gets the provider notice: `This permanently deletes the playlist from <Provider>.` (`canDeletePlaylist`) or `<Provider> cannot delete playlists; this unfollows it (removes it from your library). Owned playlists can be restored from your <Provider> account page.`
- Prompt on stderr: `<Delete|Unfollow> playlist "<name>" (<id>)? (y/n): `; `y` or `yes` (any case) confirms. Anything else → stderr `Aborted; nothing was changed.`, **exit 1**.
- Table sentence: `<Deleted|Unfollowed> playlist "<name>" (<id>)`; dry run: `[dry-run] Would <delete|unfollow> playlist "<name>" (<id>) in <Provider>`, with the notice on stderr.

### A8. `export`

`sple export <playlist…|-> [--liked] [-o <file|dir>] [--format json|csv] [--force]`; `--all` arrives in M2 (FR-EXP-5) and is rejected with exit 2 until then.

- **Validation first:** format is `json` (default) or `csv`; `-` at most once and alone; no empty arguments; at least one playlist or `--liked`. Several sources without `-o` → exit 2. `--json` without `-o` → exit 2.
- **Destination:** without `-o`, the single source is written to stdout. With `-o`, the path is a **directory** when there are several sources, when it ends with a path separator, or when it is an existing directory; otherwise it is a **file** and its parent directory must exist. A directory path that exists as a file → exit 2. The directory is created if needed.
- **File names in a directory:** `<slug(name)>-<id>.<format>`; Liked Songs is `liked-songs.<format>`. `slug`: NFKD, drop combining marks, lower-case, runs of characters outside `[a-z0-9]` → `-`, trim `-`, cut to 60 characters, trim a trailing `-`; empty → `playlist`.
- **Overwrite:** an existing target without `--force` → exit 2, checked for every target before anything is written. Files are written atomically (temporary file in the same directory, then rename); a failed write leaves no partial file.
- **Resolution:** every input is resolved first (ADR 0003 §3.2). An ambiguous name, or an auth/quota/rate-limit error, stops with nothing written. Other resolution errors are reported and skipped (§5). An input resolving to a playlist already listed → stderr warning, exported once.
- **Reading:** playlist items in pages of `readPageSize.playlistItems`, Liked Songs in pages of `readPageSize.liked`. Unsupported items are dropped as in A5 (warning ends `and were not exported`). `source.userId` is the logged-in user's ID when `auth.status()` returns one.
- **Summary (stderr):** `sple: exported <n> playlist(s)` on success (not with `--json`/`--quiet`), or the §5 partial-failure line.

### A9. `import`

`sple import <file> [--name <name>] [--report <path>] [--min-confidence <0..1>] [--dry-run] [--yes]`. The target provider is the global `--provider`. There are no short flags.

**Order of work**

1. Validate flags: exactly one file; `--min-confidence` is a number in [0, 1] (default 0.5); unless `--dry-run` or `--yes`, stdin must be a TTY (else exit 2 before any request).
2. Read the file (ADR 0008 Amendment 1). An unreadable or invalid file → exit 2 (`Failed to read file: <reason>`).
3. Match every track on the target provider (ADR 0009 Amendment 1). Auth, quota and rate-limit errors stop the command with their exit code and nothing is created.
4. Write `--report <path>` if given: JSON (`MatchReport`) when the path ends in `.json` (any case), otherwise the text report. An existing file is overwritten.
5. Print the result (below) and, on stderr, `<matched>/<total> tracks ready to import (<pct>%)` and, when there are any, `<n> low-confidence match(es) skipped (below --min-confidence <x>)`.
6. Unless `--dry-run`: confirm on stderr with `Create playlist "<name>" with <n> matched track(s)? (y/n): ` (skipped with `--yes`). Declining → `Aborted; nothing was changed.`, exit 1.
7. Create a **private**, non-collaborative playlist named `--name` or the file's `playlist.name`, then `populatePlaylist` with the `matched` refs in position order (`skipExisting: false`). Low-confidence and unmatched tracks are not added.

**Output modes**

| Mode | stdout |
|---|---|
| table / TSV | The text report (ADR 0009 Amendment 1), then `Created private playlist "<name>" (<id>)[ <url>] with <added> of <requested> tracks` (or `[dry-run] Would create private playlist "<name>" with <n> tracks`). Import has no tabular result, so TSV mode prints the same text. |
| `--quiet` | The created playlist's ID; nothing on a dry run. |
| `--json` | One `ImportOutput` document. |

```ts
export interface ImportOutput {
  dryRun: boolean
  report: MatchReport                                    // ADR 0009 Amendment 1
  /** Absent on a dry run. */
  playlist?: { id: string; ref: string; name: string; url?: string }
  added: number                                          // 0 on a dry run
  failed: Array<{ ref: string; error: string }>          // per-track populate failures
}
```

**Exit codes:** 0 when every matched track was added (or on a dry run). Per-track add failures → each on stderr as `sple: failed to add <ref>: <error>`, then `sple: added <a> of <n> tracks; <f> failed (see above)`, exit 1, and with `--json` the `PartialFailure` `ErrorOutput` on stderr while stdout still gets `ImportOutput`. If `populatePlaylist` throws, stderr gets `sple: playlist <url or id> was created, but adding tracks failed` and the command exits with the thrown error's code.

### A10. `auth`

- `auth login [--no-browser | --manual]` (both → exit 2); output per ADR 0010 §2. `--quiet` suppresses the stdout lines.
- `auth status [--json]`: human form per provider: `<Provider> (<id>): logged in` / `: not logged in`, then `  User: [<displayName> ](<id>)`, `  Scopes: <space-joined or (none)>`, `  Token expires: <ISO>`. A token that has already expired (`expiresAt <= now`) is printed as `  Token expires: <ISO> (expired)` with the stderr warning `Warning: <Provider> access token has expired; it will be refreshed on next use`; one expiring within 5 minutes gets `Warning: <Provider> access token expires in less than 5 minutes`. Status is read from `tokens.json` and makes no network call.
- `auth logout [--provider X | --all]` (both → exit 2): stdout `Revoked access with <Provider>` or `Logged out from <Provider>`, then `Deleted: <items>` and the provider's notice. Every target is attempted; the exit code is that of the first failure.
- `--no-browser`/`--manual` on other subcommands, `--all` outside logout, and `--json` outside status → exit 2.

### A11. Logging through the `debug` package (§6)

Supersedes the "implemented in-house, no `debug` dependency" rule in §6 and the matching rejected alternative.

- **Library:** the TypeScript implementation logs through the [`debug`](https://www.npmjs.com/package/debug) package, one `createDebug('sple:<namespace>')` instance per namespace. Ports use their platform's equivalent and must support the same `DEBUG` filter syntax.
- **Namespaces:** `sple:<area>[:<sub>]`. Defined so far: `sple:cli` (the selected provider and command), `sple:auth`, `sple:export`, `sple:resolve`, `sple:import`, `sple:<provider>:auth` (e.g. `sple:spotify:auth`), `sple:http` (one line per attempt, §6), `sple:http:retry`, `sple:http:error`.
- **Selecting namespaces:** the enabled set is the comma-joined list of `DEBUG` (if set) and the flag pattern, passed to `debug.enable()` once at startup:
  - `--verbose` → `sple:*,-sple:http*`
  - `--debug` → `sple:*`
  - neither flag → `DEBUG` alone
  
  `DEBUG` uses the `debug` syntax: comma- or space-separated names, `*` wildcards, and a leading `-` to exclude (exclusions win). Examples: `DEBUG=sple:http sple export …` shows only HTTP lines; `DEBUG=-sple:http:retry sple --debug …` hides retry lines. `DEBUG` patterns outside `sple:*` have no effect on `sple` output.
- **Redaction is not optional:** at startup, before any namespace is enabled, the global output function (`createDebug.log`) is replaced with one that formats the arguments (`util.format`), passes the result through the §6 redaction function, and writes it to stderr. No code may set a per-instance `log` or write log lines any other way.
- **Line format:** the stable part is `sple:<namespace> <message>`, with `<message>` as specified in §6 and ADR 0010 §5. The decoration `debug` adds (colors and a `+Nms` suffix on a TTY, an ISO timestamp prefix otherwise, controlled by `DEBUG_COLORS`, `DEBUG_HIDE_DATE` and `NO_COLOR`) is not part of the contract. Logs are for people; scripts use `--json`.
- **Not logs:** errors (§4), warnings and summaries are always printed through the error writer, are redacted, and are not affected by `DEBUG`.
- **Tests:** the §6 leak test enables `sple:*` and feeds known token strings through every namespace.

## Amendment 2 (refresh-token expiry, #80)

- **Date:** 2026-10-07
- **Why:** an expired Google refresh token (ADR 0010 Amendment 1) was reported as "not logged in" and as the generic auth message, so users could not tell an expired grant from a missing login.

| Change | Rule |
|---|---|
| A2 error message | `AuthRequiredError` with reason `revoked` and no `scope` prints the error's own message, which names the provider and the login command. Other `AuthRequiredError`s are unchanged. |
| §3.7 / A10 `auth status` | When the stored token has `refreshTokenExpiresAt`, the human form adds `  Refresh token expires: <ISO>` after `Token expires`. If it has passed, the line ends in ` (expired)` and stderr gets `Warning: <Provider> refresh token has expired; run "sple auth login --provider <id>"` instead of the "will be refreshed on next use" warning. `--json` adds `refreshTokenExpiresAt` (omitted when unknown). Status still makes no network call. |

## Amendment 3 (match cache, #94)

- **Date:** 2026-10-07
- **Why:** the match cache (ADR 0009 Amendment 2) needs a switch on `import` and a cleanup on logout (NFR-9).

| Change | Rule |
|---|---|
| A9 `import` | Usage gains `[--no-cache]`: neither reuse nor store matches. Step 3 runs the chain with the `cache` strategy unless `--no-cache` is given. |
| A10 `auth logout` | After each provider's logout, the match-cache entries involving it are deleted. If any were, `match_cache` is added to the `Deleted: …` line (printed as `Deleted: match_cache` when the provider reported nothing else). |

## Amendment 4 (resumable imports, #95)

- **Date:** 2026-10-07
- **Why:** FR-MIG-4. An interrupted import had to start over and created a second playlist. On YouTube only about 100 new tracks fit in a day's quota (ADR 0002 §2.1.2), so any larger import was interrupted.

### Usage

`sple import <file> [--name <name>] [--report <path>] [--min-confidence <0..1>] [--no-cache] [--dry-run] [--yes]`
`sple import --resume <runId|last> [--report <path>] [--yes]`

`--resume` takes no file and cannot be combined with `--name`, `--min-confidence`, `--no-cache` or `--dry-run` (exit 2: `--resume takes a run ID, not a file` / `--resume cannot be combined with --<flag>`). The run keeps its own target provider, options and source snapshot; `--provider` is ignored.

### Run file

`runs/<runId>.json` in the config directory (directory mode `0700`, file `0600`, written by temp file and rename). `runId` is `<UTC date YYYYMMDD>-<6 lowercase hex digits>`; anything else is never used as a path.

```ts
interface RunState {
  schemaVersion: 1
  runId: string
  kind: 'import' | 'migrate'
  target: ProviderId
  createdAt: string                    // ISO 8601 UTC
  updatedAt: string
  options: { minConfidence: number; cache: boolean }
  items: RunItem[]                     // one for import
}
interface RunItem {
  file: CanonicalPlaylistFile          // snapshot of the source
  name: string                         // target playlist name
  sourceFilePath: string
  phase: 'matching' | 'matched' | 'adding' | 'done'
  results: MatchResult[]               // track results so far, position order
  report?: MatchReport                 // set when matching ends
  playlist?: { id: string; ref: string; name: string; url?: string }
  toAdd: string[]                      // matched refs, position order
  cursor: number                       // toAdd entries processed (added or failed)
  added: number
  failed: Array<{ ref: string; error: string }>
}
```

A run is resumable for **30 days** after `createdAt`. After that it is ignored and deleted the next time an import starts, because it holds provider data (ADR 0002 §4.1).

### Order of work (replaces A9 steps 3, 6 and 7 when not `--dry-run`)

1. Steps 1–2 of A9, then delete expired runs and **create the run** (`phase: 'matching'`).
2. Match. After **each** track, append its result and save the run, so a stop never repeats a search. On a resume, tracks that already have a result are not matched again.
3. `phase: 'matched'`, `toAdd` = the matched refs. Report, `--report` and stderr counts as in A9.
4. Confirm as in A9. Declining deletes the run.
5. `phase: 'adding'`. If the run has no playlist, create it and **save before adding anything**. Then add `toAdd` from `cursor` in batches of `maxTracksPerRequest`, saving after each batch.
6. On success, delete the run. Per-track failures are reported as in A9.

**Stops:** any error after the run exists prints `sple: import stopped; resume with: sple import --resume <runId>` on stderr (after `… was created, but adding tracks failed` when that applies), then the error as usual, with its exit code (5 for quota).

### Resuming

1. Delete expired runs. Load the run; `last` means the unfinished `import` run with the latest `createdAt` (none → exit 2, `There are no unfinished imports`). If it is missing (or expired), exit 2 with `No unfinished import '<id>'`, followed by `. Unfinished imports:` and one line per run, `  <runId>  "<name>" → <target> (<progress>)`, when there are any. A `migrate` run → exit 2, `Run <id> is a migration; continue it with "sple migrate --resume <id>"`.
2. The confirmation rule of A9 applies only while the run hasn't reached `adding`. Once adding has started, it was already confirmed.
3. stderr: `Resuming import <runId>: "<name>" → <target> (<progress>)`. `<progress>` is `matched <n> of <total> tracks`, `matched, playlist not created yet` or `added <cursor> of <toAdd.length> tracks`.
4. Continue at the run's phase. Output is the same as a fresh import, and the report is printed again.
5. **Reconcile** (ADR 0002 §4.1): when resuming in `adding` with tracks left, read the playlist once (`getPlaylist`). If its `trackCount` is greater than `added`, the difference was added after the last save. Advance `cursor` and `added` by it (capped at the tracks left) and save, so those tracks aren't added twice.

### Logout

`auth logout` also deletes the runs whose `target` is the provider or whose snapshot's `source.provider` is the provider, and adds `runs` to the `Deleted:` line (Amendment 3).

