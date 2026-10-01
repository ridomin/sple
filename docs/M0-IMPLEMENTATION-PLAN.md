# M0 Implementation Plan

**Milestone:** M0 — Foundations  
**Scope:** Repo tooling, provider interface + capabilities, config, multi-provider token store, HTTP client, fake provider, ADRs  
**Target:** All tasks complete before M1 spike tests (S1–S4)

## Task Breakdown

### Phase 1: Project Setup

**[M0-1] Initialize project structure**
- Set up TypeScript strict mode (tsconfig.json)
- Configure Node.js LTS target and module system (ESM)
- Set up build pipeline (tsc, dist/)
- Configure development tools: eslint, prettier, jest
- Set up npm scripts: build, lint, test, dev
- Create .gitignore and .env.example (no secrets)
- No CLI entry point yet; just the infrastructure

**Acceptance criteria:**
- `npm run build` produces dist/ without errors
- `npm run lint` and `npm run test` run successfully (empty test suite is OK)
- TypeScript strict mode enabled
- ESM build target (Node.js 18+)

---

### Phase 2: Core Types and Interfaces

**[M0-2] Implement provider interface and capabilities (ADR-0003)**
- Create `src/core/provider/capabilities.ts` with `ProviderCapabilities`, `ProviderOperation`, `QuotaModel`, etc.
- Create `src/core/provider/provider.ts` with `Provider` interface, `PlaylistSummary`, `CanonicalTrack`, `MatchCandidate`, etc.
- Create `src/core/provider/errors.ts` with closed error types: `AuthRequiredError`, `NotFoundError`, `QuotaExhaustedError`, `RateLimitError`, `AccessRestrictedError`, `UsageError`
- Add exit code mapping in a separate module: `src/cli/exit-codes.ts`

**Acceptance criteria:**
- All types from ADR-0003 are defined and exported
- Error types are classes with proper inheritance and message formatting
- Exit code mapping is correct and documented
- No circular dependencies

---

### Phase 3: Config and Token Management (ADR-0004)

**[M0-3] Implement config path resolution**
- Create `src/core/config/paths.ts` with `getConfigDir()` and `getConfigFilePath()`
- Handle platform detection (Linux, macOS, Windows, WSL)
- XDG Base Directory compliance on Linux
- Unit tests for path resolution on all platforms

**Acceptance criteria:**
- `getConfigDir()` returns correct path for each platform
- Respects `XDG_CONFIG_HOME` on Linux if set
- Returns absolute paths
- Tests mock `process.platform` to avoid platform dependencies

---

**[M0-4] Use Node's --env-file for environment loading (skipped)**
- Environment variables are loaded using Node's built-in `--env-file` flag (Node.js 21.7.0+)
- No custom env-loader module needed; simplifies the codebase
- The .env file is specified in the CLI wrapper (npm script or shell invocation)

**Acceptance criteria:**
- `npm run dev` and `npm test` work with environment variables from the .env file
- CLI entry point can be invoked with `node --env-file=<path>/.env dist/cli/cli.js`

---

**[M0-5] Implement token store**
- Create `src/core/config/token-store.ts` with `loadTokens()`, `saveTokens()`, `deleteTokens()`
- Define `StoredToken` interface from ADR-0004
- Implement tokens.json file I/O with schema versioning
- Validate token objects on load
- User-only file permissions (0600 on POSIX, Windows profile ACL)
- Unit tests with mock file system

**Acceptance criteria:**
- `loadTokens(providerId)` returns `StoredToken | null`
- `saveTokens()` creates tokens.json if missing, updates if exists
- Schema validation rejects invalid tokens
- Tokens are saved with 0600 permissions on POSIX
- File locking (basic; optional for M0)

---

### Phase 4: HTTP Client

**[M0-6] Implement HTTP client base class**
- Create `src/core/http/client.ts` with `HttpClient` class
- Abstract away provider SDK differences; use native `fetch` (or `node-fetch` polyfill)
- Implement retry logic: exponential backoff, jitter, `Retry-After` header support
- Implement token refresh: detect 401, call auth adapter to refresh, retry transparently
- Implement rate/quota limiting based on `ProviderCapabilities.quotaModel` (basic; may be deferred to M2)
- Logging (verbose/debug, no token leaks)

**Acceptance criteria:**
- Retries on 5xx and network errors with exponential backoff
- Respects `Retry-After` header
- Transparent token refresh on 401
- No secrets logged (tokens, secrets filtered)
- Tests with mocked responses (mock fixtures, no real API calls)

---

### Phase 5: Fake Provider

**[M0-7] Implement fake provider**
- Create `src/providers/fake/index.ts` implementing the `Provider` interface
- Configurable capabilities: can test with `owned-only` playlists, `cursor-forward` pagination, `daily-buckets` quota, etc.
- In-memory storage for playlists and tracks
- Supports all provider operations (search, list, create, remove, resolve track, populate)
- Throws the closed error types from M0-2
- Tests: prove the abstraction works (can plug in another provider without CLI changes)

**Acceptance criteria:**
- Implements all `Provider` interface methods
- Capabilities can be configured in tests
- In-memory state: playlists and tracks
- Tests verify search, playlist creation, error handling
- No external dependencies (not a real API client)

---

### Phase 6: CLI Entry Point and Config

**[M0-8] Set up CLI structure and config loading**
- Create `src/cli/cli.ts` with main entry point
- Create `src/cli/config.ts` to load and validate config (env vars + .env)
- Create `src/cli/provider-registry.ts` to register and instantiate providers (Spotify stub, YouTube stub, fake provider)
- Parse global flags: `--provider`, `--verbose`, `--version`
- Error-to-exit-code mapping (from M0-2)
- Help text and `--version` output

**Acceptance criteria:**
- CLI can be invoked: `sple --version`, `sple --help`
- `--provider` flag works; defaults to `spotify`
- Config loads from .env without errors
- Provider registry can be instantiated
- Exit codes match the mapping from M0-2

---

### Phase 7: Auth Interface Stubs

**[M0-9] Implement auth interface and login flow (stubs)**
- Create `src/core/auth/auth.ts` with `ProviderAuth` interface (from ADR-0003)
- Create `src/core/auth/oauth-handler.ts` with PKCE flow, loopback redirect, `--no-browser` / `--manual` modes
- Implement `sple auth login [--provider X] [--no-browser | --manual]` command
- Implement `sple auth status [--provider X]` command
- Implement `sple auth logout [--provider X | --all]` command
- Integration with token-store (M0-5): save tokens after login, load on status, delete on logout
- Tests with mock OAuth responses (no real provider APIs)

**Acceptance criteria:**
- `sple auth login --provider spotify` initiates PKCE flow
- `--no-browser` prints the URL only
- `--manual` waits for pasted redirect URL
- `sple auth status` shows logged-in user and scopes
- `sple auth logout` deletes tokens and returns success
- Tokens are stored and loaded from token-store

---

### Phase 8: Provider Adapters (Stubs)

**[M0-10] Create Spotify and YouTube Music adapter stubs**
- Create `src/providers/spotify/index.ts` implementing `Provider` interface
- Create `src/providers/youtube-music/index.ts` implementing `Provider` interface
- Both adapters have HTTP client instances (from M0-6)
- Both declare capabilities (from ADR-0003 §5)
- Placeholder implementations for all methods (throw "not implemented" or call fake provider internally for now)
- Auth integration: login/logout use the OAuth handler (M0-9)

**Acceptance criteria:**
- Both adapters export a `Provider` instance
- Capabilities match ADR-0003 declared values
- HTTP client is initialized per adapter
- Auth methods (login, status, logout) are implemented
- Other provider methods throw "not implemented" (will be filled in M1/M4a)

---

### Phase 9: Testing and Documentation

**[M0-11] Set up test infrastructure**
- Configure Jest with TypeScript support
- Mock fixtures for HTTP responses (don't call real APIs)
- Mock file system for config/token store tests
- Mock OAuth responses for auth tests
- Test structure mirrors src/ structure
- Achieve ≥ 50% coverage on core and adapters (will increase in M1+)

**Acceptance criteria:**
- `npm test` runs all tests
- Tests don't call real provider APIs
- Mocked responses are recorded and documented
- Coverage reported (≥ 50% target)

---

**[M0-12] Update ADRs and documentation**
- Finalize ADR-0003 and ADR-0004 (already done; verify complete)
- Create ADR-0005: canonical track model (title, artists, album, duration, ISRC, refs, addedAt)
- Create ADR-0006: stack and build decisions (TypeScript, Node.js LTS, ESM, Jest, no ORM)
- Update README.md with project overview and contributing guide
- Document the fake provider's configuration for tests
- Changelog entry for M0

**Acceptance criteria:**
- All ADRs are complete and cross-linked
- README explains project structure
- Fake provider configuration is documented
- Contributing guide covers testing patterns

---

## Dependency Graph

```
Phase 1: [M0-1] Project Setup
         ↓
Phase 2: [M0-2] Core Types
         ↓
Phase 3: [M0-3] Paths ──→ [M0-4] .env Loader ──→ [M0-5] Token Store
         ↓                                             ↓
Phase 4: [M0-6] HTTP Client ←─────────────────────────┘
         ↓
Phase 5: [M0-7] Fake Provider
         ↓
Phase 6: [M0-8] CLI Setup
         ↓
Phase 7: [M0-9] Auth Interface ──→ [M0-10] Adapter Stubs
         ↓
Phase 8: [M0-11] Testing
         ↓
Phase 9: [M0-12] Documentation
```

## Effort Estimate

| Task | Effort | Notes |
|---|---|---|
| M0-1 | 2d | Standard TypeScript project setup |
| M0-2 | 2d | Type definitions; no logic |
| M0-3 | 1d | Path resolution; platform detection |
| M0-4 | — | Use Node's `--env-file` flag (skipped) |
| M0-5 | 2d | File I/O, schema versioning, validation |
| M0-6 | 3d | Retry logic, token refresh, logging |
| M0-7 | 2d | In-memory provider; all operations |
| M0-8 | 2d | CLI entry, config loading, provider registry |
| M0-9 | 3d | PKCE flow, loopback redirect, manual mode |
| M0-10 | 1d | Adapter stubs (minimal implementations) |
| M0-11 | 2d | Jest setup, mock fixtures, test structure |
| M0-12 | 2d | ADRs, README, documentation |
| **Total** | **22d** | ~4–5 weeks at 5d/week |

## Success Criteria

✓ All M0 tasks completed and tested  
✓ Provider abstraction proven with fake provider + stubs  
✓ Config and token store working (roundtrip: save → load → verify)  
✓ Auth flow working (login → save token → status → logout)  
✓ HTTP client retries and refresh transparently  
✓ All ADRs complete and documented  
✓ ≥ 50% test coverage on core modules  
✓ No real API calls in tests  
✓ Ready for M1 spike tests (S1–S4)
