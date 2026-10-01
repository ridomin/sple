# M0-9 Auth Manual Testing Guide

This guide documents how to test the auth commands end-to-end after implementation. All auth flows are implemented using OAuth 2.0 with PKCE (RFC 7636).

## Prerequisites

Before running any tests:

1. **Node.js 20+ LTS** is installed
   ```bash
   node --version
   ```

2. **Build succeeds without errors**
   ```bash
   npm run build
   ```
   If you see TypeScript errors or missing modules, fix them before proceeding.

3. **Environment variables are set**
   
   Copy `.env.example` to your config directory and fill in client IDs:
   ```bash
   cp .env.example ~/.config/sple/.env
   ```
   
   At minimum, set one of:
   - `SPLE_SPOTIFY_CLIENT_ID`: Get from https://developer.spotify.com/dashboard (requires Premium account)
   - `SPLE_YOUTUBE_MUSIC_CLIENT_ID` and `SPLE_GOOGLE_CLIENT_SECRET`: Get from https://console.cloud.google.com
   
   For testing with a mock provider:
   ```bash
   export SPLE_FAKE_CLIENT_ID=test-client-id
   ```

4. **Token file location**
   
   After login, tokens are stored at:
   - Linux: `~/.config/sple/tokens.json`
   - macOS: `~/Library/Application Support/sple/tokens.json`
   - Windows: `%APPDATA%\sple\tokens.json`
   
   File permissions are `0600` (readable/writable by owner only).

## Test Cases

### Test Case 1: Loopback Mode (Default)

**Purpose:** Verify OAuth flow with automatic browser redirect on loopback.

**Prerequisites:**
- Provider client ID configured in `.env`
- A browser available on the machine

**Steps:**

1. Start the login flow:
   ```bash
   npm run dev -- auth login --provider spotify
   ```

2. **Expected output:**
   ```
   Opened authorization URL in browser: http://127.0.0.1:XXXXX/authorize?...
   Waiting for authorization redirect...
   ```
   (Or similar message from your terminal's browser opener)

3. **Manual verification:**
   - [ ] Browser automatically opens (or terminal shows the URL to copy-paste)
   - [ ] Authorization page appears for the provider
   - [ ] After clicking "Authorize", browser redirects to `http://127.0.0.1:XXXXX/callback`
   - [ ] Redirect page may show "Callback received" or similar message
   - [ ] Terminal shows success message:
     ```
     Logged in to Spotify
     User: [username or email]
     Scopes: [comma-separated list]
     Token expires: [ISO 8601 timestamp or omitted if no expiry]
     ```

4. **Verify token storage:**
   ```bash
   cat ~/.config/sple/tokens.json | jq '.providers.spotify'
   ```
   Should show stored token with fields: `accessToken`, `refreshToken` (if available), `expiresAt`, `scopes`, `userId`, `grantedAt`.

5. **Exit code:**
   ```bash
   echo $?
   ```
   Should be `0`.

---

### Test Case 2: No-Browser Mode

**Purpose:** Verify OAuth flow when browser cannot be opened automatically (e.g., SSH, headless).

**Prerequisites:**
- Provider client ID configured
- Same machine or remote SSH session

**Steps:**

1. Start login with `--no-browser`:
   ```bash
   npm run dev -- auth login --provider spotify --no-browser
   ```

2. **Expected output:**
   ```
   Open this URL in your browser:
   http://127.0.0.1:XXXXX/authorize?client_id=...&redirect_uri=...&state=...&code_challenge=...
   Waiting for authorization redirect...
   ```

3. **Manual verification:**
   - [ ] No browser opens automatically
   - [ ] Terminal displays the full authorization URL
   - [ ] Copy the URL and paste it into a browser on **any machine**
   - [ ] Complete authorization on the provider
   - [ ] Browser is redirected to `http://127.0.0.1:XXXXX/callback?code=...&state=...`
   - [ ] Redirect fails to load (since loopback is not accessible from that machine)

4. **Capture the redirect URL:**
   
   The redirect URL will appear in the browser's address bar or history. It looks like:
   ```
   http://127.0.0.1:XXXXX/callback?code=AUTH_CODE&state=STATE_VALUE
   ```

5. **Paste into terminal:**
   
   If you're in manual mode (see Test Case 3), paste the full redirect URL. For no-browser mode, the terminal should automatically catch it from **local** browser redirects only.

6. **Expected output after successful redirect:**
   ```
   Logged in to Spotify
   User: [username]
   Scopes: [list]
   Token expires: [timestamp or omitted]
   ```

7. **Exit code:**
   ```bash
   echo $?
   ```
   Should be `0`.

---

### Test Case 3: Manual Mode

**Purpose:** Verify OAuth flow for headless environments where even a loopback server cannot receive callbacks (e.g., strict firewalls, WSL without network).

**Prerequisites:**
- Provider client ID configured
- Access to a browser on a different machine or network

**Steps:**

1. Start login with `--manual`:
   ```bash
   npm run dev -- auth login --provider spotify --manual
   ```

2. **Expected output:**
   ```
   Open this URL in your browser:
   http://account.provider.com/authorize?client_id=...&redirect_uri=http://127.0.0.1/callback&state=...
   
   After authorization, you will be redirected to a URL that fails to load.
   Paste the full URL from your browser here:
   ```

3. **Manual verification:**
   - [ ] No browser opens
   - [ ] Authorization URL is displayed
   - [ ] Copy URL and open it in any browser
   - [ ] Complete authorization on the provider
   - [ ] Browser is redirected (e.g., to `http://127.0.0.1/callback?code=...&state=...`)
   - [ ] Page fails to load (expected; no loopback server is listening)

4. **Paste the redirect URL:**
   
   Copy the full redirect URL from the browser address bar and paste it into the terminal prompt:
   ```
   Paste redirect URL: http://127.0.0.1/callback?code=AUTH_CODE&state=STATE_VALUE
   ```

5. **Expected output after paste:**
   ```
   Logged in to Spotify
   User: [username]
   Scopes: [list]
   Token expires: [timestamp or omitted]
   ```

6. **Exit code:**
   ```bash
   echo $?
   ```
   Should be `0`.

---

### Test Case 4: Status Command

**Purpose:** Verify that status shows logged-in user, scopes, and token expiry.

**Prerequisites:**
- User is already logged in (from Test Case 1, 2, or 3)

**Steps:**

1. Check status:
   ```bash
   npm run dev -- auth status --provider spotify
   ```

2. **Expected output:**
   ```
   User: [Display Name or User ID]
   Scopes: playlist-read-private, playlist-read-collaborative, playlist-modify-public
   Token expires: 2026-10-01T18:30:00Z
   ```
   
   (Scopes and expiry vary by provider; some providers may omit expiry if tokens don't expire.)

3. **Manual verification:**
   - [ ] User information matches the account you logged in with
   - [ ] Scopes listed are appropriate for the provider
   - [ ] Token expiry (if shown) is a valid ISO 8601 timestamp in the future

4. **Token expiry warning:**
   
   If token expires in less than 5 minutes, you should see:
   ```
   User: [username]
   Scopes: [list]
   Token expires: 2026-10-01T18:35:00Z
   ⚠️ Token expires in less than 5 minutes
   ```

5. **Exit code:**
   ```bash
   echo $?
   ```
   Should be `0`.

---

### Test Case 5: Logout Command

**Purpose:** Verify that logout revokes and deletes stored tokens.

**Prerequisites:**
- User is already logged in (from a previous test)

**Steps:**

1. Check tokens exist:
   ```bash
   cat ~/.config/sple/tokens.json | jq '.providers.spotify.accounts[0].accessToken' | head -c 20
   ```
   Should show a non-empty token (first 20 chars as a sample).

2. Logout:
   ```bash
   npm run dev -- auth logout --provider spotify
   ```

3. **Expected output:**
   ```
   Revoked access with Spotify
   ```
   Or:
   ```
   Logged out from Spotify
   Deleted: match cache, migration state
   ```
   (The exact message depends on whether the provider supports revocation.)

4. **Verify token is deleted:**
   ```bash
   cat ~/.config/sple/tokens.json | jq '.providers.spotify'
   ```
   Should return `null` or an empty object (no accounts).

5. **Exit code:**
   ```bash
   echo $?
   ```
   Should be `0`.

6. **Verify status now fails:**
   ```bash
   npm run dev -- auth status --provider spotify
   ```
   
   Should output:
   ```
   Not logged in to Spotify
   ```
   And exit with code `3` (AUTH_REQUIRED).

---

### Test Case 6: Error Cases

#### Test Case 6a: Not Logged In

**Purpose:** Verify appropriate error when user is not logged in.

**Prerequisites:**
- User is logged out (from Test Case 5 or never logged in)

**Steps:**

1. Try to check status without logging in:
   ```bash
   npm run dev -- auth status --provider spotify
   echo "Exit code: $?"
   ```

2. **Expected output:**
   ```
   Not logged in to Spotify
   Exit code: 3
   ```

3. **Manual verification:**
   - [ ] Error message is clear and actionable
   - [ ] Exit code is `3` (AUTH_REQUIRED)

---

#### Test Case 6b: Unknown Provider

**Purpose:** Verify appropriate error for unsupported providers.

**Steps:**

1. Try to login with an unknown provider:
   ```bash
   npm run dev -- auth login --provider unknown-provider
   echo "Exit code: $?"
   ```

2. **Expected output:**
   ```
   Unknown provider: unknown-provider
   Exit code: 2
   ```

3. **Manual verification:**
   - [ ] Error message clearly states the provider is unknown
   - [ ] Exit code is `2` (USAGE_ERROR)
   - [ ] Message suggests valid providers (if available)

---

#### Test Case 6c: Invalid Flag Combination

**Purpose:** Verify that `--no-browser` and `--manual` cannot be used together.

**Steps:**

1. Try to use both flags:
   ```bash
   npm run dev -- auth login --provider spotify --no-browser --manual
   echo "Exit code: $?"
   ```

2. **Expected output:**
   ```
   --no-browser and --manual cannot be used together
   Exit code: 2
   ```

3. **Manual verification:**
   - [ ] Error prevents the conflicting combination
   - [ ] Exit code is `2` (USAGE_ERROR)

---

#### Test Case 6d: Invalid Subcommand

**Purpose:** Verify that invalid subcommands are rejected.

**Steps:**

1. Try an unknown subcommand:
   ```bash
   npm run dev -- auth invalid-command
   echo "Exit code: $?"
   ```

2. **Expected output:**
   ```
   Unknown auth subcommand: invalid-command. Usage: sple auth <login|status|logout> ...
   Exit code: 2
   ```

3. **Manual verification:**
   - [ ] Error message is helpful and shows usage
   - [ ] Exit code is `2` (USAGE_ERROR)

---

#### Test Case 6e: Flags on Status/Logout

**Purpose:** Verify that `--no-browser` and `--manual` are rejected on status and logout.

**Steps:**

1. Try `--no-browser` on status:
   ```bash
   npm run dev -- auth status --provider spotify --no-browser
   echo "Exit code: $?"
   ```

2. **Expected output:**
   ```
   --no-browser and --manual only apply to "auth login"
   Exit code: 2
   ```

3. **Manual verification:**
   - [ ] Error prevents invalid flag usage
   - [ ] Exit code is `2` (USAGE_ERROR)

---

### Test Case 7: Multi-Provider

**Purpose:** Verify that multiple providers can be logged in simultaneously with separate tokens.

**Prerequisites:**
- At least two provider client IDs configured (e.g., Spotify and YouTube Music)

**Steps:**

1. Login to first provider:
   ```bash
   npm run dev -- auth login --provider spotify
   ```
   Complete the flow (from Test Case 1, 2, or 3).

2. **Verify login:**
   ```bash
   npm run dev -- auth status --provider spotify
   echo "Exit code: $?"
   ```
   Should show user info and exit with code `0`.

3. Login to second provider:
   ```bash
   npm run dev -- auth login --provider youtube-music
   ```
   Complete the flow.

4. **Verify second login:**
   ```bash
   npm run dev -- auth status --provider youtube-music
   echo "Exit code: $?"
   ```
   Should show user info for YouTube and exit with code `0`.

5. **Verify both tokens coexist:**
   ```bash
   cat ~/.config/sple/tokens.json | jq '.providers | keys'
   ```
   Should show:
   ```
   ["spotify", "youtube-music"]
   ```

6. **Verify first provider still works:**
   ```bash
   npm run dev -- auth status --provider spotify
   ```
   Should still show the first user's info (not affected by second login).

7. **Logout from first provider only:**
   ```bash
   npm run dev -- auth logout --provider spotify
   ```

8. **Verify first provider is logged out:**
   ```bash
   npm run dev -- auth status --provider spotify
   echo "Exit code: $?"
   ```
   Should output "Not logged in to Spotify" and exit with code `3`.

9. **Verify second provider still logged in:**
   ```bash
   npm run dev -- auth status --provider youtube-music
   ```
   Should still show YouTube user info.

10. **Manual verification:**
    - [ ] Both providers can be logged in simultaneously
    - [ ] Tokens are stored separately
    - [ ] Logging out one does not affect the other
    - [ ] All status checks return correct user info

---

### Test Case 8: Logout with `--all` Flag (Task 5)

**Purpose:** Verify that `--all` flag logs out from all providers at once.

**Prerequisites:**
- User is logged in to at least two providers (from Test Case 7)

**Steps:**

1. Verify both providers are logged in:
   ```bash
   npm run dev -- auth status --provider spotify
   npm run dev -- auth status --provider youtube-music
   ```
   Both should succeed.

2. Logout from all:
   ```bash
   npm run dev -- auth logout --all
   echo "Exit code: $?"
   ```

3. **Expected output:**
   ```
   Revoked access with Spotify
   Revoked access with YouTube Music
   ```
   Or similar logout messages for each provider.

4. **Verify all providers are logged out:**
   ```bash
   npm run dev -- auth status --provider spotify
   npm run dev -- auth status --provider youtube-music
   ```
   Both should fail with "Not logged in" and exit code `3`.

5. **Verify tokens file:**
   ```bash
   cat ~/.config/sple/tokens.json | jq '.providers'
   ```
   Should be empty (`{}` or no accounts for any provider).

6. **Manual verification:**
   - [ ] `--all` logs out from all providers
   - [ ] Exit code is `0`
   - [ ] All providers report "Not logged in" after logout

---

## Manual Verification Checklist

Use this checklist to track your testing progress:

- [ ] **Test Case 1: Loopback Mode**
  - [ ] Browser opens automatically
  - [ ] Authorization succeeds
  - [ ] Token is stored
  - [ ] Exit code is 0

- [ ] **Test Case 2: No-Browser Mode**
  - [ ] URL is displayed without opening browser
  - [ ] Authorization succeeds when pasted into browser
  - [ ] Token is stored
  - [ ] Exit code is 0

- [ ] **Test Case 3: Manual Mode**
  - [ ] URL is displayed
  - [ ] User can paste redirect URL manually
  - [ ] Token is stored
  - [ ] Exit code is 0

- [ ] **Test Case 4: Status Command**
  - [ ] User info is displayed
  - [ ] Scopes are listed
  - [ ] Token expiry is shown (if applicable)
  - [ ] Exit code is 0

- [ ] **Test Case 5: Logout Command**
  - [ ] Logout succeeds
  - [ ] Token is deleted from file
  - [ ] Status command fails after logout
  - [ ] Exit code is 0

- [ ] **Test Case 6a: Not Logged In Error**
  - [ ] Error message is clear
  - [ ] Exit code is 3

- [ ] **Test Case 6b: Unknown Provider Error**
  - [ ] Error message is clear
  - [ ] Exit code is 2

- [ ] **Test Case 6c: Invalid Flag Combination Error**
  - [ ] Error message is clear
  - [ ] Exit code is 2

- [ ] **Test Case 6d: Invalid Subcommand Error**
  - [ ] Error message is helpful
  - [ ] Exit code is 2

- [ ] **Test Case 6e: Flags on Status/Logout Error**
  - [ ] Error message is clear
  - [ ] Exit code is 2

- [ ] **Test Case 7: Multi-Provider**
  - [ ] Both providers can be logged in
  - [ ] Tokens are stored separately
  - [ ] Logout one does not affect the other
  - [ ] Status works correctly for each

- [ ] **Test Case 8: Logout with `--all`**
  - [ ] All providers are logged out
  - [ ] Tokens are deleted
  - [ ] Exit code is 0

## Troubleshooting

### Browser does not open in loopback mode

- **Windows/WSL:** Check that you have a browser available. Set `WSL_BROWSER` if needed.
- **SSH:** Use `--no-browser` instead.
- **Headless:** Use `--manual` instead.

### Token file not created or not readable

- **File location:** Verify tokens are at the correct path for your OS (see Prerequisites).
- **File permissions:** Check that `tokens.json` is readable by your user (`0600` on POSIX).
- **Config directory:** Ensure `~/.config/sple/` exists and is writable.

### Authorization fails with "Invalid Client ID"

- Verify that your client ID is correct in `.env`.
- Ensure the redirect URI is registered with the provider as `http://127.0.0.1/callback` (no port).

### Authorization fails with "Premium subscription required" (Spotify)

- Spotify requires the app owner to have a Premium account.
- Switch to a Premium account or use a different provider for testing.

### Status shows "Token expires in less than 5 minutes"

- Refresh the token by running `auth login` again.
- Or, wait for automatic refresh if the provider supports it.

### Exit codes are not as expected

- Run with `SPLE_DEBUG=true` to see detailed error logs:
  ```bash
  SPLE_DEBUG=true npm run dev -- auth status --provider spotify
  ```

---

## Notes for Developers

- All auth commands support `--provider` flag. Without it, the default provider from `SPLE_DEFAULT_PROVIDER` env var or config is used.
- Tokens are stored in the user's config directory and protected by OS-level file permissions.
- PKCE (Proof Key for Code Exchange) is always used for security, even though it's most critical for public clients (desktop apps).
- OAuth tokens are refreshed automatically by the provider adapter when they expire.
- For Spotify: Client secret is not stored or used (public client flow).
- For YouTube Music: Client secret is stored in `config.json` (Desktop app flow allows this).
