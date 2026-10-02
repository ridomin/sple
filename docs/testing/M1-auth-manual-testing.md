# M1 Auth Manual Testing (FR-AUTH-1)

This checklist covers the three `sple auth login` modes introduced in M1-9 on
Linux, WSL, macOS, and Windows. It is not run in CI. Run it by hand before an
M1 release and fill in the results tables and the sign-off line.

> **Note:** The token exchange and `GET /me` arrive in M1-10. Until then, you can
> check the redirect handling (URL printed, browser behavior, listener on
> `127.0.0.1:<port>/callback`, pasted URL accepted). The tokens saved are still stubs.

## Modes under test

| Mode | Command | Listener | Browser | Redirect URI sent to `/authorize` |
|------|---------|----------|---------|------------------------------------|
| loopback (default) | `sple auth login` | yes, `127.0.0.1:<random port>` | opened via `open` | `http://127.0.0.1:<port>/callback` |
| no-browser | `sple auth login --no-browser` | yes | **not** opened | `http://127.0.0.1:<port>/callback` |
| manual | `sple auth login --manual` | **none** | **not** opened | `http://127.0.0.1/callback` (no port) |

In every mode, the authorization URL goes to **stderr** before sple waits. Stdout
gets only the final `Logged in to …` summary.

## Prerequisites

1. Node.js 20+ (`node --version`) and a clean build (`npm run build`).
2. `SPLE_SPOTIFY_CLIENT_ID` is set for a Spotify app in Development Mode. The test
   account must be on the app's user allow-list.
3. Exactly `http://127.0.0.1/callback` (no port) is registered as a redirect URI
   in the Spotify dashboard (FR-AUTH-1). Spotify's docs say a loopback URI
   registered without a port accepts any port in the authorization request, so
   the same entry covers loopback, `--no-browser`, and `--manual`. The M1-1 spike
   used a fixed registered port, so this dynamic-port behavior has **not** been
   checked live yet. If TC1 fails with `INVALID_CLIENT: Invalid redirect URI`,
   record it as a finding.
4. `localhost` must **not** be needed anywhere. Spotify rejects it.

## Test cases

### TC1: loopback (default)

1. Run `sple auth login --provider spotify`.
2. Expected:
   - stderr shows `Open this URL in your browser to authorize sple:` followed by an
     `https://accounts.spotify.com/authorize?...` URL.
   - The URL contains `redirect_uri=http%3A%2F%2F127.0.0.1%3A<port>%2Fcallback`,
     `code_challenge_method=S256`, and a `state`.
   - The default browser opens that URL.
3. Approve access. The browser shows "Authorization successful".
4. The CLI prints `Logged in to Spotify` and exits with code 0.

### TC2: loopback when the browser can't be opened

1. Linux: run with no browser available, for example
   `env -u DISPLAY -u WAYLAND_DISPLAY PATH=/usr/bin:/bin sple auth login` on a host
   without `xdg-open`. Other platforms: skip or simulate.
2. Expected: a `Warning: could not open a browser (...)` line on stderr. The
   command does **not** exit, and the listener keeps waiting.
3. Copy the printed URL into a browser on the same machine and approve. Login completes.

### TC3: --no-browser

1. Run `sple auth login --no-browser`.
2. Expected: the URL is printed to stderr, **no** browser opens, and
   `Waiting for authorization...` is shown.
3. Open the URL by hand in a browser **on the same machine** (it must reach
   `127.0.0.1:<port>`) and approve. Login completes with exit code 0.

### TC4: --manual

1. Run `sple auth login --manual`.
2. Expected: the URL is printed with `redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback`
   (no port). No browser opens and no listener is started.
3. Open the URL in any browser (this can be on another device), then approve.
4. The browser fails to load `http://127.0.0.1/callback?code=...&state=...`.
   Copy the full address-bar URL.
5. Paste it at the `Paste the redirect URL here:` prompt and press Enter. Login completes.
6. Negative checks:
   - Paste a URL with an edited `state`. Expect `Login failed: State mismatch in redirect URL` and exit code 1.
   - Press Ctrl-D (or Ctrl-Z, Enter on Windows) at the prompt. Expect
     `Login failed: No redirect URL received (stdin closed)`.
   - Pipe the URL in: `echo "<url>" | sple auth login --manual`. Expect it to work.
     The URL must come from the same run, so this check is mostly useful for scripting.

### TC5: listener hardening (loopback / no-browser)

While a loopback login is waiting (port shown in the URL):

| Request | Expected |
|---------|----------|
| `curl -i "http://127.0.0.1:<port>/callback?code=x&state=bad"` | `400 Invalid state`; login fails with `State validation failed` |
| `curl -i "http://127.0.0.1:<port>/other?code=x&state=..."` | `400 Invalid path`; login keeps waiting |
| `curl -i -H "Host: localhost:<port>" "http://127.0.0.1:<port>/callback?..."` | `400 Invalid host`; login keeps waiting |
| `curl -i "http://localhost:<port>/callback?..."` | connection refused (IPv6 `::1`) or `400 Invalid host`. The listener is bound to `127.0.0.1` only. |
| `ss -ltnp \| grep <port>` (Linux) / `lsof -iTCP:<port>` (macOS) | listening on `127.0.0.1:<port>` only, not `0.0.0.0` |

## Platform-specific browser behavior

The `open` package picks the launcher:

| Platform | Launcher | Notes |
|----------|----------|-------|
| Linux (desktop) | bundled `xdg-open` | Without `DISPLAY`/`WAYLAND_DISPLAY` (SSH, containers), opening usually fails. Expect the warning from TC2, then use `--no-browser` (same host) or `--manual`. |
| WSL 2 | Windows browser via PowerShell / `wslview` | The Windows browser reaches the WSL listener on `127.0.0.1:<port>` only if WSL localhost forwarding works (the default on WSL 2; check `localhostForwarding` in `.wslconfig`, and with `networkingMode=mirrored` it works). If the callback never arrives, use `--manual`. |
| macOS | `open` | Should just work. Safari may show a prompt the first time. |
| Windows | PowerShell `Start-Process` | `open` waits for PowerShell to exit (a few hundred ms) before it resolves. Windows Firewall should not prompt for a `127.0.0.1` listener. If it does, record it. |
| Headless / remote SSH | none | Use `--manual`. `--no-browser` works only if a browser on the same host can reach `127.0.0.1`. |

## Results

Mark each cell: PASS / FAIL (with notes) / N/A.

| Test | Linux | WSL | macOS | Windows |
|------|-------|-----|-------|---------|
| TC1 loopback | | | | |
| TC2 browser open failure | | | | |
| TC3 --no-browser | | | | |
| TC4 --manual | | | | |
| TC4 negative checks | | | | |
| TC5 listener hardening | | | | |

Notes / findings:

-

## Sign-off

| Platform | Date | Tester | OS version | Node version | Browser + version | sple commit |
|----------|------|--------|------------|--------------|-------------------|-------------|
| Linux | | | | | | |
| WSL | | | | | | |
| macOS | | | | | | |
| Windows | | | | | | |
