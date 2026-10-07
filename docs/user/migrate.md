# Migrating playlists

`sple migrate` copies playlists, or your Liked Songs, from one provider to another in one step. For each source it reads the tracks, matches them on the target, and creates a new **private** playlist with the matched tracks. It's the same matching as [`sple import`](import.md), without the intermediate file. The full contract is [ADR 0007](../adr/0007-cli-conventions.md) Amendment 6.

```
sple migrate --from <provider> --to <provider> (<playlist>… | --all) [--liked] [--name <name>]
             [--min-confidence <0..1>] [--report <dir>] [--no-cache] [--dry-run] [--yes]
sple migrate --resume <runId|last> [--report <dir>] [--yes]
```

```bash
# See what would happen first: matches every track, creates nothing
sple migrate --from spotify --to youtube-music "Road trip" "Chill" --dry-run

# Liked Songs become a private playlist "Liked Songs (from Spotify)"
sple migrate --from spotify --to youtube-music --liked

# Everything, with one JSON match report per playlist
sple migrate --from spotify --to youtube-music --all --liked --report reports/
```

Log in to both providers first (`sple auth login --provider spotify`, `sple auth login --provider youtube-music`).

## What to migrate

| Argument | Sources |
|---|---|
| `<playlist>…` | Each playlist by ID, URI, URL or exact name, as in `export`. An ambiguous name stops the command; a playlist that can't be found or read is skipped with a warning. |
| `--all` | Every playlist in your library. Playlists whose tracks the provider won't return (for example, other people's playlists on Spotify) are skipped with a warning. |
| `--liked` | Your Liked Songs, as a playlist named `Liked Songs (from <Source>)`. sple never writes likes. Can be combined with playlists or `--all`. |

`--name` renames the target playlist, but only when there's a single source.

## What happens

1. Every source is read before anything is sent to the target.
2. sple prints a plan and, for YouTube, a [quota estimate](import.md#quota-estimate-youtube) for all sources together:
   ```
   Migrating 3 playlists (412 tracks) from spotify to youtube-music
   Quota estimate for youtube-music: units up to 21162 (10000 of 10000 left today); search up to 412 (100 of 100 left today)
   That needs about 5 days of quota. sple stops when today's quota runs out (it resets at 2026-10-08T07:00:00.000Z) and prints how to resume.
   Create 3 private playlists on YouTube Music? (y/n):
   ```
   One answer covers the whole migration. `--yes` skips the question, and it's required when stdin isn't a terminal.
3. The playlists are processed one at a time: match (with a progress line), create the private playlist, add the matched tracks. Low-confidence and unmatched tracks are left out, as in `import`. Use `--min-confidence` to change the threshold, and `--report <dir>` to see what was left out.
4. One line per playlist as it finishes:
   ```
   "Road trip" → "Road trip" (PLxxxx) https://www.youtube.com/playlist?list=PLxxxx: added 95 of 95 matched tracks (3 low-confidence, 2 unmatched)
   ```

`--dry-run` stops after matching: it prints `[dry-run] … would add …` lines and creates nothing. Searches still cost YouTube quota, but they're [cached](import.md#the-match-cache), so the real migration afterwards doesn't repeat them.

## Over several days (YouTube)

With the default YouTube quota, about 100 new tracks a day can be searched and added. A larger migration stops when the quota runs out:

```
sple: migrate stopped; resume with: sple migrate --resume 20261007-3fa9c1
sple: Quota exhausted: search (resets at 2026-10-08T07:00:00.000Z)
```

Run the command after the reset, once a day, until it finishes (`sple migrate --resume last` also works). Finished playlists aren't touched again, tracks already matched aren't searched again, and nothing is added twice. See [Resuming an interrupted import](import.md#resuming-an-interrupted-import) for how that's guaranteed. A run can be resumed for 30 days.

## Output and exit codes

- `--quiet` prints only the created playlist IDs, and `--json` prints one `MigrateOutput` document at the end (sources, match summaries, created playlists, skipped sources, quota estimate).
- **Exit codes:**
  - **0:** everything was migrated.
  - **1:** some tracks couldn't be added (each is listed).
  - **2, 3, 4 or 5:** a usage, auth, not-found or quota problem. A source that was skipped also sets one of these.
- **Report files:** `--report <dir>` writes `01-road-trip.json`, `02-chill.json`, … in the [match report format](../adr/0009-matching-strategy.md).
