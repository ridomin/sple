# sple — Multi-Provider Music Playlist Export

A command-line tool for exporting, searching, and migrating playlists across music providers (Spotify, YouTube Music).

## Features

- **Search** the Spotify or YouTube Music catalog for tracks, albums, artists and playlists
- **Manage playlists:** list, show, create and remove
- **Export** playlists and Liked Songs to a lossless JSON format or CSV
- **Import** an exported file into another provider: tracks are matched by ref, ISRC or metadata, with a match report
- **Migrate** playlists or Liked Songs from one provider to another in one step, resumable across days of YouTube quota
- **Authentication:** browser, no-browser and manual OAuth flows, with tokens stored locally and refreshed automatically

## Getting Started

### Installation

```bash
git clone https://github.com/ridomin/sple.git
cd sple
npm install
npm run build
```

### Quick Start

The tool is invoked as `sple` (see npm scripts or shell wrapper for your environment).

#### Authentication

Authenticate with your music provider:

```bash
# Spotify
sple auth login --provider spotify

# YouTube Music
sple auth login --provider youtube-music
```

The default provider is Spotify. You can specify `--provider youtube-music` to authenticate with YouTube Music. YouTube Music needs your own Google OAuth client first: see [docs/user/youtube-music-setup.md](docs/user/youtube-music-setup.md). What sple accesses and stores is described in [docs/PRIVACY.md](docs/PRIVACY.md).

**Login modes:**

- **Interactive (default):** Opens your browser to the OAuth consent screen. Works on systems with a default browser.
  ```bash
  sple auth login --provider spotify
  ```

- **No-browser mode:** Prints the authorization URL for manual entry in a browser (useful for remote/headless systems).
  ```bash
  sple auth login --provider spotify --no-browser
  ```

- **Manual mode:** Waits for you to paste the redirect URL after authorization.
  ```bash
  sple auth login --provider spotify --manual
  ```

#### Check login status

View your authentication status and granted scopes:

```bash
sple auth status

# Check a specific provider
sple auth status --provider youtube-music
```

Output shows:
- Login status (logged in / not logged in)
- User ID and display name
- Granted scopes (permissions)
- Token expiry time

#### Logout

Revoke authentication and delete local tokens:

```bash
sple auth logout

# Logout from a specific provider
sple auth logout --provider youtube-music

# Logout from all providers
sple auth logout --all
```

### Search

```bash
sple search "daft punk" --type artist
sple search "harder better faster stronger" --type track --limit 5
sple search "road trip" --type playlist --provider youtube-music
```

`--type` is `track` (default), `album`, `artist` or `playlist`. YouTube Music has no albums.

### Playlists

```bash
sple playlist list [--owned | --followed]
sple playlist show "Road trip"                 # name, ID, URI or URL
sple playlist create "New mix" --private
sple playlist remove "Old mix"                 # Spotify unfollows; YouTube deletes
```

### Export

```bash
sple export "Road trip" -o road-trip.json      # canonical JSON (lossless)
sple export "Road trip" --format csv -o road-trip.csv
sple export --liked -o liked.json              # Liked Songs
```

The JSON format is published as [a JSON Schema](schemas/canonical-playlist.v1.schema.json). Export files are yours: sple never tracks or deletes them.

### Import

```bash
sple import road-trip.json --provider youtube-music
sple import road-trip.json --provider youtube-music --dry-run --report report.json
```

`import` matches each track on the target provider (known ref, then a cached match, then ISRC, then title, artist and duration), prints a match report, and after you confirm creates a private playlist with the matched tracks. See the [import guide](docs/user/import.md).

### Migrate

```bash
sple migrate --from spotify --to youtube-music "Road trip" --dry-run
sple migrate --from spotify --to youtube-music --liked
sple migrate --from spotify --to youtube-music --all --report reports/
sple migrate --resume last
```

`migrate` reads the source playlists, matches every track on the target, and creates a private playlist for each source with the matched tracks. Progress is saved, so a migration stopped by the YouTube quota continues with `--resume` the next day. See the [migrate guide](docs/user/migrate.md).

### Global options

| Option | Effect |
|---|---|
| `--provider <name>` | `spotify` (default, or `SPLE_DEFAULT_PROVIDER`) or `youtube-music` |
| `--json` | Machine-readable output on stdout |
| `--quiet` | IDs only |
| `--yes` | Don't ask for confirmation (required for prompts when stdin isn't a terminal) |
| `--verbose`, `--debug` | Diagnostic lines on stderr; filter them with `DEBUG=sple:…` ([logging](docs/user/logging.md)) |

Exit codes: 0 success, 1 error or partial failure, 2 usage error, 3 authentication needed, 4 not found, 5 quota or rate limit.

### Configuration

Create a `.env` file in the config directory:
- **Linux:** `~/.config/sple/.env`
- **macOS:** `~/Library/Application Support/sple/.env`
- **Windows:** `%APPDATA%\sple\.env`

**Environment variables:**

```bash
# Spotify
SPLE_SPOTIFY_CLIENT_ID=your_spotify_client_id

# YouTube Music
SPLE_YOUTUBE_MUSIC_CLIENT_ID=your_google_client_id
SPLE_GOOGLE_CLIENT_SECRET=your_google_secret

# Optional: default provider (spotify or youtube-music)
SPLE_DEFAULT_PROVIDER=spotify
```

Copy the block above into your `.env` and fill in the values; lines you don't need can stay commented out with `#`.

### Tokens

Tokens are stored in `tokens.json` in the same directory as `.env`:
- User-only permissions (`0600` on POSIX)
- Multiple providers can be authenticated simultaneously
- Tokens are refreshed automatically when expired
- Never check tokens into version control

The same directory holds `quota.json`, which counts today's YouTube API calls. See the [privacy policy](docs/PRIVACY.md) for everything sple stores.

## Project Structure

```
sple/
├── src/
│   ├── cli/               # Entry point, commands, output formatting, logging
│   ├── core/
│   │   ├── auth/          # OAuth (PKCE, loopback), scope helpers
│   │   ├── config/        # Config paths, .env, token store
│   │   ├── export/        # Canonical file and CSV writers
│   │   ├── http/          # HTTP client: retries, token refresh, debug logging
│   │   ├── import/        # File reader, match report, playlist creation
│   │   ├── matching/      # Matching engine, normalizer, strategies
│   │   ├── provider/      # Provider interface, capabilities, errors
│   │   └── quota/         # Daily quota ledger
│   └── providers/
│       ├── spotify/
│       ├── youtube-music/
│       └── fake/          # In-memory provider for tests (SPLE_ENABLE_FAKE_PROVIDER=1)
├── tests/                 # node:test suites and recorded fixtures
├── schemas/               # Canonical playlist JSON Schema
├── scripts/               # Repository checks (check:stubs)
└── docs/
    ├── requirements.md    # Requirements, milestones, and deviations (§12)
    ├── adr/               # Architecture Decision Records
    ├── user/              # User guides
    └── PRIVACY.md
```

## Architecture

The behavior is specified in [docs/requirements.md](docs/requirements.md) and the Architecture Decision Records:

| ADR | Topic |
|---|---|
| [0002](docs/adr/0002-youtube-music-provider.md) | YouTube Music provider (Data API v3, quota) |
| [0003](docs/adr/0003-provider-interface-and-capabilities.md) | Provider interface, capabilities, scope tables |
| [0004](docs/adr/0004-token-store-and-config.md) | Config, token store |
| [0005](docs/adr/0005-canonical-track-model.md) | Canonical track model |
| [0007](docs/adr/0007-cli-conventions.md) | CLI conventions: output, errors, exit codes, logging |
| [0008](docs/adr/0008-canonical-playlist-file.md) | Canonical playlist file (JSON, CSV) |
| [0009](docs/adr/0009-matching-strategy.md) | Matching strategy and match report |
| [0010](docs/adr/0010-http-oauth-and-token-refresh.md) | HTTP client, OAuth and token refresh |

### Key Design Decisions

1. **Closed provider interface:** all operations go through one `Provider` interface, and core never branches on a provider ID.
2. **Capability-driven CLI:** differences between providers (pagination, page sizes, playlist access, quota model) are declared as capabilities.
3. **Transparent token refresh:** the HTTP client refreshes tokens, so commands don't handle refresh themselves.
4. **Typed errors:** a closed set of error types maps to exit codes.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, testing patterns and how changes are made. In short:

```bash
npm install && npm run build
npm run lint && npm test && npm run check:stubs
node dist/cli/cli.js --help
```

## License

TBD

## Support

For issues, questions, or contributions, please open an issue or pull request on GitHub.
