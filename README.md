# sple — Multi-Provider Music Playlist Export

A command-line tool for exporting, searching, and migrating playlists across music providers (Spotify, YouTube Music).

## Features

- **Multi-provider support:** Seamlessly work with multiple music providers
- **Playlist export:** Export playlists with metadata (tracks, artists, albums)
- **Cross-provider migration:** Migrate playlists between services
- **Flexible authentication:** Support for interactive, no-browser, and manual OAuth flows
- **Token management:** Secure, multi-provider token storage with automatic refresh

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

### Import

```bash
sple import <file> [--provider spotify|youtube-music] [--name "Name"]
```

Create a new playlist by matching tracks from an exported canonical file. Uses a three-strategy matching chain: known refs → ISRC → metadata. See [import guide](docs/user/import.md).

Example:

```bash
# Import Spotify playlist to YouTube Music
sple import my-songs.json --provider youtube-music

# With a match report
sple import my-songs.json --report report.txt
```

Note: playlist creation on the target provider is not implemented yet; `sple import` currently matches tracks and prints or saves the match report.

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

See `.env.example` for a template.

### Tokens

Tokens are stored securely in `~/.config/sple/tokens.json` (same directory as `.env`):
- User-only permissions (`0600` on POSIX)
- Multiple providers can be authenticated simultaneously
- Tokens are refreshed automatically when expired
- Never check tokens into version control

## Project Structure

```
sple/
├── src/
│   ├── core/              # Core abstractions
│   │   ├── auth/          # Auth interface and OAuth handler
│   │   ├── config/        # Config paths and token store
│   │   ├── http/          # HTTP client base class
│   │   └── provider/      # Provider interface and capabilities
│   ├── providers/         # Provider adapters
│   │   ├── spotify/
│   │   ├── youtube-music/
│   │   └── fake/          # Fake provider for testing
│   └── cli/               # CLI commands and entry point
├── docs/
│   ├── adr/               # Architecture Decision Records
│   ├── M0-IMPLEMENTATION-PLAN.md
│   └── requirements.md
├── test/                  # Test files
├── tsconfig.json
├── jest.config.js
└── package.json
```

## Architecture

This project follows a provider-agnostic architecture documented in Architecture Decision Records (ADRs):

- **ADR-0003:** [Provider interface and capabilities](docs/adr/0003-provider-interface-and-capabilities.md)
- **ADR-0004:** [Token store and config](docs/adr/0004-token-store-and-config.md)

### Key Design Decisions

1. **Closed provider interface:** All operations are mediated through a single `Provider` interface. No provider-specific code in core logic.

2. **Capability-driven CLI:** The CLI checks provider capabilities before acting (e.g., `owned-only` playlists, pagination model, quota limits).

3. **Transparent token refresh:** HTTP clients handle token refresh automatically; the CLI and core are unaware of refresh logic.

4. **Typed errors:** A closed set of error types map to exit codes for predictable CLI behavior.

## Development

### Building

```bash
npm run build
```

Outputs compiled code to `dist/`.

### Linting

```bash
npm run lint
```

### Testing

```bash
npm test
```

All tests use mocked providers and HTTP responses. No real API calls.

### Running locally

```bash
npm run dev -- auth login --provider spotify
```

## Contributing

### Code style

- TypeScript with `strict` mode
- ESM modules
- No external provider SDKs (use native fetch + type definitions)

### Testing

- All code changes require tests
- Use mock fixtures for HTTP responses
- No real API credentials in tests
- Target ≥ 50% coverage on core modules

### Committing

Follow conventional commits:
- `feat:` new feature
- `fix:` bug fix
- `refactor:` code reorganization
- `test:` test additions/changes
- `docs:` documentation
- `chore:` build, dependencies, tooling

Example:
```bash
git commit -m "feat(auth): add token refresh to HTTP client"
```

## License

TBD

## Support

For issues, questions, or contributions, please open an issue or pull request on GitHub.
