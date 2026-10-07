# sple privacy policy

- **Last updated:** 2026-10-07
- **Applies to:** the `sple` command-line tool, including its use of YouTube API Services and the Spotify Web API.

sple runs on your computer. It has no server, no account system and no telemetry. Nothing you do with sple is sent to the sple project or to anyone other than the music services you connect.

## YouTube API Services

sple uses **YouTube API Services** (the YouTube Data API v3). By using sple with YouTube Music you agree to the [YouTube Terms of Service](https://www.youtube.com/t/terms). Google's handling of your data is described in the [Google Privacy Policy](https://policies.google.com/privacy).

You connect sple through **your own** Google Cloud project and OAuth client ([setup guide](user/youtube-music-setup.md)). Requests go directly from your computer to Google.

### What sple accesses

With the permissions you grant at login (`youtube` and `userinfo.profile`), sple reads and changes only what the command you run needs:

| Data | When |
|---|---|
| Your Google account ID and name | At login, to show who is logged in |
| Your channel ID | To tell your playlists from other people's |
| Your playlists and their items | `playlist list`, `playlist show`, `export`, `migrate` |
| Your YouTube Music liked songs (the "Liked Music" playlist) | `export --liked`, `migrate --liked` |
| Video titles, channels and durations | Search and track matching (`import`, `migrate`) |
| Playlists you ask sple to create, fill or delete | `playlist create`, `playlist remove`, `import`, `migrate` |

sple never accesses your email, watch history, subscriptions, comments or uploads, and it never plays or downloads audio or video.

### What sple stores, and where

Everything is stored in sple's config directory on your computer (`~/.config/sple` on Linux, `~/Library/Application Support/sple` on macOS, `%APPDATA%\sple` on Windows):

| File | Contents | Kept until |
|---|---|---|
| `tokens.json` (mode 0600) | OAuth access and refresh tokens, the granted scopes, your account ID and name, token expiry times | `sple auth logout`, or the next login replaces it |
| `quota.json` (mode 0600) | Counts of today's YouTube API calls per quota bucket. No YouTube content. | Replaced each day |
| `match-cache.json` (mode 0600) | Matches that `sple import` or `sple migrate` found by searching: for each source track ref, the matched track's ID, title, artists and duration, the match confidence, and when it was found | Each entry for **30 days** after it was found; `sple auth logout` deletes the entries for that provider |
| `runs/<id>.json` (mode 0600) | Progress of an unfinished `sple import` or `sple migrate`: a copy of the source playlists, the match results so far, the created playlists' IDs, and how many tracks were added | Deleted when the run finishes or you decline an import; otherwise at most **30 days**. `sple auth logout` deletes the runs that involve that provider |
| `.env` | Your OAuth client ID and secret, which you entered yourself | You delete it |

sple keeps **no other YouTube data**. Match-cache entries are never refreshed: an entry older than 30 days is ignored and removed the next time the file is written. `sple import --no-cache` neither reads nor writes the cache.

### Export files

Files you create with `sple export` (or `--report`) are **your own data**, created at your request and saved where you choose. They are outside sple's retention: sple does not track, refresh or delete them, and logging out doesn't touch them. Delete them yourself when you no longer want them.

### Revoking access and deleting data

- `sple auth logout --provider youtube-music` revokes sple's token at Google, deletes `tokens.json`'s YouTube entry, and deletes the match-cache entries and unfinished imports and migrations that involve YouTube. It reports whether Google confirmed the revocation.
- You can also remove access at any time from your Google account's [third-party connections page](https://myaccount.google.com/connections), or by deleting the OAuth client in your Google Cloud project.
- To delete everything sple stored, delete its config directory.

Revoking access through Google doesn't delete local files. Run `sple auth logout` or delete the config directory as well.

## Spotify

For Spotify, sple stores the same kind of token entry in `tokens.json` and accesses only what your commands need: profile ID and name, playlists, saved tracks, and the playlists you create or change. Spotify has no revocation endpoint. `sple auth logout --provider spotify` deletes the local tokens, and you can remove access on your [Spotify account's Apps page](https://www.spotify.com/account/apps/). See [Spotify's Privacy Policy](https://www.spotify.com/legal/privacy-policy/).

## Logs

`--verbose`, `--debug` and `DEBUG=sple:*` write diagnostic lines to your terminal only. Tokens and secrets are redacted, and request and response bodies are never logged.

## Changes and contact

Changes to this policy are made in the sple repository and listed in its history. Questions or concerns: open an issue at <https://github.com/ridomin/sple/issues>.
