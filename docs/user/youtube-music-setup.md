# Set up YouTube Music

sple talks to YouTube Music through the official YouTube Data API v3 ([ADR 0002](../adr/0002-youtube-music-provider.md)). Each user brings their own Google OAuth client, so quota and consent belong to your own Google Cloud project.

## 1. Create the Google OAuth client

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (any name, for example `sple`).
2. Under **APIs & Services → Library**, enable **YouTube Data API v3**.
3. Open **Google Auth Platform** (the OAuth consent screen):
   - **Branding:** an app name and your email are enough.
   - **Audience:** choose **External**. While the app is in **Testing**, add your own Google account under **Test users**.
   - **Data access:** add the scopes `https://www.googleapis.com/auth/youtube` and `https://www.googleapis.com/auth/userinfo.profile`.
4. Under **Clients**, create an OAuth client of type **Desktop app**. Copy its client ID and client secret.

A Desktop client accepts any loopback redirect (`http://127.0.0.1:<port>`), so you don't need to configure redirect URIs. Google treats a Desktop client's secret as non-confidential, and sple stores it so it can refresh tokens.

## 2. Configure sple

Add both values to the `.env` file in sple's config directory (`~/.config/sple/.env` on Linux; see the README for macOS and Windows):

```bash
SPLE_YOUTUBE_MUSIC_CLIENT_ID=123456789-abc.apps.googleusercontent.com
SPLE_GOOGLE_CLIENT_SECRET=your-client-secret
```

## 3. Log in

```bash
sple auth login --provider youtube-music
```

Google's consent screen shows **a checkbox for each permission**. Tick **"Manage your YouTube account"**. If you leave it unticked, login still succeeds but prints a warning, and YouTube commands fail with `Missing scope 'https://www.googleapis.com/auth/youtube'`. To fix it, run the login again and tick the box.

While the app is unverified, Google also shows a "Google hasn't verified this app" screen. Choose **Continue**: it's your own app.

## 4. Avoid logging in again every week

While your OAuth app's publishing status is **Testing**, Google expires its refresh tokens **7 days** after login. `sple auth status` shows the date:

```
YouTube Music (youtube-music): logged in
  ...
  Refresh token expires: 2026-10-14T10:05:15.153Z
```

After that date, commands fail with:

```
sple: YouTube Music authorization expired or was revoked (Google expires refresh tokens after 7 days while the OAuth app is in Testing status); run "sple auth login --provider youtube-music"
```

To stop this, open **Google Auth Platform → Audience** and choose **Publish app** to switch the status to **In production**. Then log in once more. For personal use (fewer than 100 users) you don't need Google's verification: you'll keep seeing the unverified-app screen at login, but the refresh token no longer expires after 7 days. The `Refresh token expires` line then disappears from `auth status`.

## Quota

The default quota is 10,000 units per day, plus 100 searches per day, and it resets at midnight Pacific Time. Reads cost 1 unit per page. Creating a playlist or adding one track costs 50 units each. When the quota is used up, sple exits with code 5.

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `Missing YouTube Music client ID` | `SPLE_YOUTUBE_MUSIC_CLIENT_ID` is not set | Step 2 |
| `Missing scope 'https://www.googleapis.com/auth/youtube'` | The YouTube checkbox was not ticked at consent | Log in again and tick it (step 3) |
| `YouTube Music authorization expired or was revoked …` | Testing-status refresh token expired after 7 days, or access was removed in your Google account | Log in again; publish the app (step 4) |
| `Access blocked: … has not completed the Google verification process` | Your account is not a test user of a Testing app | Add it under **Audience → Test users**, or publish the app |
| `Quota exhausted: units` | Daily quota used up | Wait until midnight Pacific Time |

To remove sple's access, run `sple auth logout --provider youtube-music`. It revokes the token at Google and deletes it locally.
