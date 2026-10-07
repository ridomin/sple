# Contributing to sple

## Setup

Requires Node.js 22 or later (CI runs 22.x and 24.x).

```bash
git clone https://github.com/ridomin/sple.git
cd sple
npm install
npm run build          # compiles src/ to dist/
node dist/cli/cli.js --help
```

To try commands against real services, put your client IDs in sple's `.env` (see the README's Configuration section and [the YouTube Music setup guide](docs/user/youtube-music-setup.md)). Tests never need them.

## Checks

Run these before opening a pull request. CI runs the same ones.

| Command | What it checks |
|---|---|
| `npm run lint` | TypeScript type check (`tsc --noEmit`, `strict`) |
| `npm test` | All tests (`node --test` with `tsx`, `tests/**/*.test.ts`) |
| `npm run check:stubs` | No `TODO`/`FIXME`/`XXX` or silenced arguments (`void x`) in auth code (#74) |
| `npm run build` | The build succeeds and leaves no uncommitted changes |

Run a single file with `node --test --import=tsx tests/path/to/file.test.ts`.

## How we work

- **Test first.** Write a failing test that shows the bug or the missing behavior, then make it pass. A bug fix includes the test that would have caught it.
- **One issue per pull request.** When a fix depends on an unmerged pull request, branch from it and say "stacked on #N" in the description.
- **Conventional commits:** `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `ci:`, `chore:`, with an optional scope (`fix(youtube-music): …`). Reference the issue: `(#72)`.
- **The spec lives in [`docs/requirements.md`](docs/requirements.md) and the [ADRs](docs/adr/).** A change in behavior updates the ADR that defines it, usually as an amendment section at the end.

### Spec deviations

Where the TypeScript code differs from the spec, the difference is listed in `docs/requirements.md` §12 ("Deviations"), with an ID (`D12`) and the issue that tracks it. When you close a deviation, remove its row, or the item within it, in the same pull request. When you knowingly add one, add a row and an issue.

## Testing patterns

Tests use `node:test` and `node:assert/strict`. No test may call a real service or need credentials.

- **Mocked `fetch`:** provider tests replace `globalThis.fetch` with a small fake of the API they talk to and restore it in `finally`. Assert on the requests made, not just the result. For example, "no request was sent" is how scope and quota refusals are tested.
- **Temporary config directories:** anything that reads or writes `tokens.json` or `quota.json` takes a `configDir`. Create one with `mkdtempSync(join(tmpdir(), 'sple-…'))`. Never touch the real config directory.
- **Recorded fixtures:** `tests/fixtures/<service>/` holds sanitized recordings of real API responses, with a README for each directory listing where each file came from and how it was sanitized. Prefer a recording to a hand-written body, because hand-written mocks miss fields the real API sends (#72). Mark anything synthetic as such.
- **Auth contract:** every OAuth provider runs the shared suite in [`tests/providers/auth-contract.ts`](tests/providers/auth-contract.ts) (granted vs requested scopes, refresh, `requireScopes`). A new provider registers itself in `auth-contract.test.ts`.

### The fake provider

`src/providers/fake/` is an in-memory provider for tests and demos. It needs no credentials, and its playlists and tracks live only in the current process.

- **In tests**, construct it directly. `new FakeProvider({ initialTracks, initialPlaylists, capabilities, configDir })` lets you override any capability, for example to test the CLI against a cursor-paginated or owned-only provider.
- **In the CLI**, it's hidden unless you set `SPLE_ENABLE_FAKE_PROVIDER=1`. Then `--provider fake` works, and `fake` appears in help and `auth status`. It's never registered for end users ([ADR 0003 Amendment 2](docs/adr/0003-provider-interface-and-capabilities.md), #46).

```bash
SPLE_ENABLE_FAKE_PROVIDER=1 node dist/cli/cli.js auth login --provider fake
```

## Code style

- TypeScript `strict`, ES modules, imports with `.js` extensions.
- No provider SDKs: adapters use `fetch` through `src/core/http/client.ts`, which handles retries, token refresh, logging and redaction.
- **Core never branches on a provider ID.** Behavior that differs between providers is a capability (`src/core/provider/capabilities.ts`) or lives in the adapter.
- Errors are the closed set in `src/core/provider/errors.ts`. Each maps to an exit code ([ADR 0007](docs/adr/0007-cli-conventions.md) §4).
- Log through `createDebug('sple:<namespace>')` or the CLI logger, never `console.log`. Output goes through the redaction function ([docs/user/logging.md](docs/user/logging.md)).
- Comments explain *why*. Match the surrounding code.
