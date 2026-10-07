# ADR 0004: Token store and config

- **Status:** Accepted (2026-10-01); amended 2026-10-07 (Amendment 1)
- **Date:** 2026-10-01
- **Deciders:** project owner (user); architect (author)
- **Related:** `docs/requirements.md` FR-AUTH-1, FR-AUTH-2, FR-AUTH-3, FR-AUTH-4, FR-AUTH-6, CLI-5, CLI-6, NFR-2, NFR-3; ADR 0003 (Provider interface); ADR 0002 (YouTube Music auth)
- **Supersedes:** n/a (first token store design)

## Context

FR-AUTH-3 and CLI-6 specify that tokens and configuration are stored in the user's config directory, with tokens in a separate file from credentials. The requirements also state that:
- Tokens are refreshed automatically (FR-AUTH-3).
- Multiple providers can be logged in simultaneously, one account per provider (FR-AUTH-6).
- Client IDs and (for Google) the user-supplied client secret are stored separately from tokens (FR-AUTH-3).
- The token file is versioned to support future multi-account profiles (FR-AUTH-6 comment).

ADR 0003 introduces the HTTP client architecture: each adapter has its own HTTP client instance, bound to its provider ID, that owns token refresh and file I/O. This ADR specifies what the token store and config files look like, and how they are accessed.

## Decision

### 1. Config file: .env in the user's config directory

Configuration is stored in a single `.env` file in the user's platform-specific config directory:
- **Linux:** `~/.config/sple/.env` (or `${XDG_CONFIG_HOME}/sple/.env`)
- **macOS:** `~/Library/Application Support/sple/.env`
- **Windows:** `%APPDATA%\sple\.env` (typically `C:\Users\<user>\AppData\Roaming\sple\.env`)
- **Fallback:** `~/.sple/.env` on Windows when `APPDATA` is unset, and on any other platform. macOS does not read `XDG_CONFIG_HOME`.

The `.env` file uses environment variable syntax (`KEY=value`). The file is loaded once at CLI startup by the config module.

**Variables:**

| Variable | Required | Description | Example |
|---|---|---|---|
| `SPLE_SPOTIFY_CLIENT_ID` | Yes (Spotify) | Spotify app Client ID | `abc123def456` |
| `SPLE_YOUTUBE_MUSIC_CLIENT_ID` | Yes (YouTube) | Google Desktop app Client ID (OAuth) | `123456789.apps.googleusercontent.com` |
| `SPLE_GOOGLE_CLIENT_SECRET` | Yes (YouTube) | Google Desktop app client secret (non-confidential, stored to enable refresh tokens) | `secret_xyz` |
| `SPLE_DEFAULT_PROVIDER` | No | Default provider when `--provider` is not specified. Defaults to `spotify`. An unknown value is a `UsageError` (exit 2). | `spotify` or `youtube-music` |
| `SPLE_ENABLE_FAKE_PROVIDER` | No | `1` registers the `fake` provider in the CLI (tests and demos only; ADR 0003 Amendment 2). | `1` |

Values are trimmed; an empty value counts as unset.

Comments and empty lines are allowed in the .env file. Tokens are **never** stored here; they live in `tokens.json` (see below).

**Precedence (CLI-6):** flags > process environment > `.env` file > defaults. A variable already set in the process environment is never overwritten by the file. Only `--provider` has a flag today; client IDs and the secret come from the environment or the file.

**Missing client configuration:** a command that needs a provider whose client ID is not set fails with `UsageError` (exit 2): `Missing <Provider> client ID. Set <VAR> in your environment or .env file.` `auth status` and `auth logout` still work for such a provider from `tokens.json` alone (logout then deletes local tokens and warns that access was not revoked).

### 2. Token file: tokens.json in the user's config directory

Tokens are stored in a versioned JSON file alongside `.env`:
- **Path:** `~/.config/sple/tokens.json` (same directory as .env)
- **Permissions:** user-only (`0600` on POSIX; Windows enforces via profile ACLs)
- **Not committed:** tokens.json is never checked into version control

**Schema:**

```json
{
  "schemaVersion": 1,
  "providers": {
    "spotify": {
      "accounts": [
        {
          "accessToken": "BQD...",
          "refreshToken": "AQA...",
          "expiresAt": "2026-10-01T12:34:56Z",
          "scopes": ["playlist-read-private", "playlist-modify-private"],
          "userId": "rido",
          "grantedAt": "2026-09-01T00:00:00Z"
        }
      ]
    },
    "youtube-music": {
      "accounts": [
        {
          "accessToken": "ya29...",
          "refreshToken": "1//0gx...",
          "expiresAt": "2026-10-01T13:45:00Z",
          "scopes": ["https://www.googleapis.com/auth/youtube"],
          "userId": "user@gmail.com",
          "grantedAt": "2026-09-01T01:00:00Z"
        }
      ]
    }
  }
}
```

**Token object fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `accessToken` | string | Yes | The active OAuth access token. |
| `refreshToken` | string | No | Present if the provider supports refresh tokens (FR-AUTH-3). Absent for providers that don't (e.g., some flows that don't support refresh). |
| `expiresAt` | ISO 8601 string | No | When the access token expires. Absent if the provider doesn't report expiry (e.g., older APIs). |
| `scopes` | string[] | Yes | Granted scopes; may be empty. Used by `auth status` (FR-AUTH-4) and by the CLI to check scope requirements (FR-AUTH-5). |
| `userId` | string | Yes | Provider-specific user identifier (e.g., Spotify username, Google email). Used by `auth status` display (FR-AUTH-4). |
| `grantedAt` | ISO 8601 string | Yes | When the token was granted. Useful for diagnostics and cleanup. |

**Array-based accounts structure:** Each provider has an `accounts` array, currently with one element per provider (one account per provider, FR-AUTH-6). This structure is future-proof: if multi-account support (multiple profiles per provider) is added in a later milestone, the schema is already in place; v2 can fill multiple accounts without a breaking migration.

### 3. Core modules

**`src/core/config/paths.ts`** — OS-aware path resolution. Handles platform detection and XDG conventions. Provides:
- `getConfigDir()`: Returns the platform's config directory.
- `getConfigFilePath(filename: string)`: Returns the full path to a file in the config directory (e.g., `.env`, `tokens.json`).
- Does NOT perform I/O; only path computation.

**`src/core/config/token-store.ts`** — Token file I/O and lifecycle. Provides:
- `loadTokens(providerId: ProviderId): Promise<StoredToken | null>`: Loads the token for the given provider. Returns null if no token is stored.
- `saveTokens(providerId: ProviderId, token: StoredToken): Promise<void>`: Saves or updates a token.
- `deleteTokens(providerId: ProviderId): Promise<void>`: Removes a token (used by logout, FR-AUTH-4).
- Schema validation: rejects tokens that don't match the expected schema.
- File locking (optional, TBD during M0): prevents concurrent writes if multiple CLI instances run simultaneously.

Both modules handle schema versioning and migration (if tokens.json is v0 or v1, ensure it's upgraded to v1).

**Environment variable loading** — The CLI loads `<configDir>/.env` once at startup, before parsing arguments, with Node's `process.loadEnvFile` (Node 20.13+). A missing file is not an error. A file that cannot be parsed prints `Failed to load .env: <reason>` to stderr and the CLI continues without it. Ports use any dotenv parser that supports the subset in Amendment 1.

### 4. HTTP client integration (from ADR-0003)

> Superseded by ADR 0010 (refresh timing, single-flight, persistence). Kept as background.

Each adapter's HTTP client (initialized per provider) integrates with the token store:

```ts
// Example: inside a Spotify adapter's HTTP client
async makeRequest(method: string, path: string, ...): Promise<Response> {
  const response = await fetch(...);
  if (response.status === 401) {
    // Token expired or revoked; refresh
    const token = await tokenStore.loadTokens('spotify');
    if (!token?.refreshToken) throw new AuthRequiredError(...);
    
    const newToken = await this.provider.auth.refreshToken(token.refreshToken);
    await tokenStore.saveTokens('spotify', newToken);
    
    // Retry with new token
    return this.makeRequest(method, path, ...);
  }
  return response;
}
```

Token refresh is transparent to the `Provider` interface and CLI.

## Alternatives considered

- **Store tokens in OS keychain.** Rejected: adds a native dependency; not available on all platforms (WSL, headless systems). Local user-only files (0600) are sufficient for NFR-3 (security).
- **Put client IDs and secrets in config.json (JSON format).** Rejected: .env is simpler, standard across many tools, and easier to document for users.
- **Store all config (tokens, client IDs, preferences) in one file.** Rejected: keeps tokens separate (sensitive, refreshed) from configuration (stable, user-supplied). Easier to rotate tokens without losing config.
- **Single account per provider (flat structure) in v1, add accounts array in v2.** Rejected: the cost of designing v1 with the array structure now is zero; it saves migration work later.

## Consequences

- M0 implements `config/paths.ts` and `config/token-store.ts`.
- The `.env` file is documented in user docs and the setup guide; users learn to add `SPLE_SPOTIFY_CLIENT_ID=…` and other variables there.
- Each adapter's HTTP client calls `tokenStore.loadTokens()` and `tokenStore.saveTokens()` during initialization and on 401 refresh.
- The fake provider (M0) uses the same token-store and paths modules as real providers, so tests can verify token refresh logic.
- If a user has both v0 and v1 token schemas (unlikely; v0 doesn't exist yet), the token-store module upgrades v0 → v1 transparently on first read.
- Future work (M2+): if multi-account support is added, `token-store.ts` changes to accept an account selector (e.g., `providerId: 'spotify', accountIndex: 0`); the schema is already ready.

## Sources

- `docs/requirements.md` FR-AUTH-1…6, CLI-5, CLI-6, NFR-2, NFR-3.
- Node.js path conventions: https://nodejs.org/en/docs/guides/nodejs-path-resolution/
- XDG Base Directory specification: https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
- macOS app support directories: https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXPathnames/MacOSXPathnames.html
- Windows %APPDATA%: https://docs.microsoft.com/en-us/windows/win32/shell/knownfolderid

## Amendment 1 (spec review for ports)

- **Date:** 2026-10-07
- **Why:** record what M0–M3 built, so another implementation reads and writes the same files. Differences in the TypeScript code are tracked in `docs/requirements.md` §12.

| Change | Why |
|---|---|
| `.env` is loaded by the CLI at startup (`process.loadEnvFile`), not with `node --env-file` | `npx sple` and the `bin` entry cannot pass Node flags. Process environment wins over the file. |
| Fallback config directory `~/.sple` | Implemented for Windows without `APPDATA` and unknown platforms. |
| New variable `SPLE_ENABLE_FAKE_PROVIDER` | ADR 0003 Amendment 2. |
| `StoredToken.displayName?: string` | Added in ADR 0003 Amendment 1 (M1-7); listed here so the token schema is in one place. |
| Token refresh moved to ADR 0010 | §4's sketch is replaced by the exact retry, refresh and persistence rules. |

### `.env` syntax (subset ports must accept)

- One `KEY=value` per line; blank lines and lines starting with `#` are ignored.
- The value may be wrapped in single or double quotes, which are removed.
- No variable expansion, no multi-line values.
- **Permissions:** `sple` never writes `.env`. On POSIX, after loading it, the CLI checks its mode; if any group or other bit is set it prints `Warning: <path> is readable by other users. Run: chmod 600 "<path>"` to stderr and continues.

### `tokens.json` rules

- **Shape:** `{ "schemaVersion": 1, "providers": { "<providerId>": { "accounts": [StoredToken] } } }`. Only `accounts[0]` is read or written (one account per provider).
- **`StoredToken`:** `accessToken` (non-empty string), `refreshToken?` (string), `expiresAt?` (ISO 8601 UTC), `scopes` (string array, may be empty), `userId` (non-empty string), `displayName?` (string), `grantedAt` (non-empty ISO 8601 string). A token that breaks these rules is rejected on load and on save.
- **Read:** a missing file means "not logged in" for every provider. `schemaVersion` other than 1 is an error. A missing provider entry or an empty `accounts` array means "not logged in".
- **Write:** create the config directory if needed, read the current file (or start a new v1 document), replace `accounts[0]` for the provider, and write the whole file as UTF-8 JSON with 2-space indentation. On POSIX the file must be created with mode `0600` (never readable by others, even briefly): write a temp file in the same directory with mode `0600`, then rename it over `tokens.json`. Delete rewrites the file the same way.
- **Delete (logout):** remove the provider's entry entirely; other providers are untouched. A missing file is not an error.
- Concurrent writers are not locked against; the last write wins.
