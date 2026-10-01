# ADR 0004: Token store and config

- **Status:** Accepted (2026-10-01)
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

The `.env` file uses environment variable syntax (`KEY=value`). The file is loaded once at CLI startup by the config module.

**Variables:**

| Variable | Required | Description | Example |
|---|---|---|---|
| `SPLE_SPOTIFY_CLIENT_ID` | Yes (Spotify) | Spotify app Client ID | `abc123def456` |
| `SPLE_YOUTUBE_MUSIC_CLIENT_ID` | Yes (YouTube) | Google Desktop app Client ID (OAuth) | `123456789.apps.googleusercontent.com` |
| `SPLE_GOOGLE_CLIENT_SECRET` | Yes (YouTube) | Google Desktop app client secret (non-confidential, stored to enable refresh tokens) | `secret_xyz` |
| `SPLE_DEFAULT_PROVIDER` | No | Default provider when `--provider` is not specified. Defaults to `spotify`. | `spotify` or `youtube-music` |

Comments and empty lines are allowed in the .env file. Tokens are **never** stored here; they live in `tokens.json` (see below).

**Precedence (CLI-6):** flags > environment variables (including those from .env) > .env file > defaults. Each CLI command accepts flags that override config.

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

**`src/core/config/env-loader.ts`** — Loads and parses the .env file. Provides:
- `loadEnv(configDir?: string): Record<string, string>`: Reads and parses .env. Merges with `process.env`.
- Does not validate variables; the caller (e.g., `src/cli/config.ts`) validates and maps them to config objects.

### 4. HTTP client integration (from ADR-0003)

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

- M0 implements `config/paths.ts`, `config/token-store.ts`, and `env-loader.ts`.
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
