# Importing playlists

`sple import` reads a playlist file, matches each track on the target provider, prints a match report, and, after you confirm, creates a new **private** playlist with the matched tracks. The full contract is [ADR 0007](../adr/0007-cli-conventions.md) A9.

```
sple import <file> [--name <name>] [--report <path>] [--min-confidence <0..1>] [--no-cache] [--dry-run] [--yes]
sple import --resume <runId|last> [--report <path>] [--yes]
```

The target is the global `--provider` (default `spotify`, or `SPLE_DEFAULT_PROVIDER`). There are no short flags.

```bash
# Copy a Spotify playlist to YouTube Music
sple export "Road trip" -o road-trip.json
sple import road-trip.json --provider youtube-music

# See the matches first, keep a JSON report, change nothing
sple import road-trip.json --provider youtube-music --dry-run --report report.json

# Non-interactive (scripts, CI): --yes is required when stdin is not a terminal
sple import road-trip.json --provider youtube-music --name "Road trip (YT)" --yes
```

## Input files

The format is chosen by extension (case-insensitive): `.json` or `.csv`. Anything else, or a file that can't be read, exits with code 2 (`Failed to read file: <reason>`). Details are in [ADR 0008](../adr/0008-canonical-playlist-file.md) Amendment 1.

- **JSON:** the canonical v1 file written by `sple export` ([schema](../../schemas/canonical-playlist.v1.schema.json)). It records the source provider and each track's refs, so re-importing into a provider the file already has refs for needs no searching.
- **CSV:** the eight `sple export --format csv` columns, `position,title,artists,album,duration_ms,added_at,isrc,ref`, in any order. Extra columns are ignored, and a UTF-8 BOM from spreadsheet apps is fine. The playlist name defaults to the file name.
  - **Source inference:** sple works out which provider the `ref` column belongs to, using the one provider that recognizes every non-empty ref. If none or several do, it prints `sple: warning: could not tell which provider the CSV refs belong to; matching by metadata only`.

## How matching works

Tracks are matched one at a time, in order. For each track, the first strategy that finds a candidate wins ([ADR 0009](../adr/0009-matching-strategy.md)):

| # | Strategy | When | Confidence |
|---|---|---|---|
| 1 | **Known ref** | The file already has a ref for the target provider | 100%, no request |
| 2 | **Match cache** | An earlier import (or dry run) in the last 30 days found this track by searching | The confidence it had then, no request |
| 3 | **ISRC** | The track has an ISRC and the target can search by ISRC (Spotify can, YouTube can't) | 95% |
| 4 | **Metadata** | The track has a title | 50% title + 35% artist + 15% duration (within 5 s) |

A metadata candidate counts only if at least half the title words match and at least one artist matches. Titles are compared after normalization: case, accents, typographic punctuation, `feat.` credits, and tags such as `Remastered 2009` or `Radio Edit` are ignored. Tags that change the recording, such as `Live` or `Remix`, are kept.

On YouTube Music, matching searches only the Music category and prefers official "Artist - Topic" uploads, so you get the song rather than a music video.

### The match cache

Every match found by searching (ISRC or metadata, including low-confidence ones) is saved in `match-cache.json` in sple's config directory, keyed by the source track. The next import of the same track on the same target reuses it without a request. So a `--dry-run` followed by the real import searches only once, and re-running an interrupted YouTube import doesn't spend the daily searches again. Entries expire after 30 days ([privacy policy](../PRIVACY.md)). Unmatched tracks aren't cached, so they're searched for again next time. `--no-cache` turns the cache off for one run, for example to look for better matches.

Candidates below `--min-confidence` (default `0.5`) are **low-confidence**: they're reported but not added. Authentication errors (exit 3) and quota or rate-limit errors (exit 5) stop the whole import before anything is created.

## Quota estimate (YouTube)

For a provider with a daily quota, sple prints what the import will need before it sends anything:

```
Quota estimate for youtube-music: units up to 6170 (9976 of 10000 left today); search up to 120 (96 of 100 left today)
That needs about 2 days of quota. sple stops when today's quota runs out (it resets at 2026-10-08T07:00:00.000Z) and prints how to resume.
Start anyway? (y/n):
```

- **Upper bound:** the numbers assume every track needs a search (unless the file or the [match cache](#the-match-cache) already has a match) and every track gets added.
- **Question:** it's asked only when the import needs more than what's left today. `--yes` skips it, and a dry run prints the estimate without asking (a dry run counts searches only).
- **Over several days:** start the import, let it stop at the quota, and [resume](#resuming-an-interrupted-import) it after the reset.
- **`--json`:** the output's `estimate` field holds the same numbers.

## What gets printed

On a terminal (and in TSV mode) stdout gets the text report:

```
Match Report: Road trip
Source: spotify → Target: youtube-music
Imported at: 2026-10-07T10:00:00.000Z

Summary
-------
Total tracks:    100
Matched:         95 (95%)
Low confidence:  3 (3%)
Unmatched:       2 (2%)
Unsupported:     0 (0%)

Recommendations
---------------
• 2 track(s) could not be matched. Check the match report for details.
• 3 track(s) have low confidence matches. Review and adjust if needed.

Unmatched Tracks
----------------
5: Very Obscure Song — Local Artist
18: Unreleased Demo — Someone

Low-Confidence Matches
---------------------
15: Track Title → Slightly Different Title (42%)
```

stderr gets `95/100 tracks ready to import (95%)` and, if any were skipped, `3 low-confidence match(es) skipped (below --min-confidence 0.5)`. Then it asks:

```
Create playlist "Road trip" with 95 matched track(s)? (y/n):
```

Answering anything but `y` prints `Aborted; nothing was changed.` and exits 1. After creating the playlist:

```
Created private playlist "Road trip" (PLxxxx) https://www.youtube.com/playlist?list=PLxxxx with 95 of 95 tracks
```

| Option | Effect |
|---|---|
| `--name <name>` | Playlist name (default: the file's playlist name) |
| `--report <path>` | Also write the report: JSON ([match report v1](../adr/0009-matching-strategy.md), §6 of Amendment 1) when the path ends in `.json`, text otherwise. Overwrites an existing file. |
| `--min-confidence <0..1>` | Threshold for adding a match (default `0.5`) |
| `--no-cache` | Neither reuse nor store matches in the match cache |
| `--dry-run` | Match and report only. Prints `[dry-run] Would create private playlist "<name>" with <n> tracks`. |
| `--yes` | Don't ask. **Required** when stdin isn't a terminal (unless `--dry-run`); otherwise sple exits 2 before any request. |
| `--json` | stdout gets one `ImportOutput` document instead of the report: `{ dryRun, report, playlist?, added, failed }` |
| `--quiet` | stdout gets only the created playlist's ID (nothing on a dry run) |

## When something goes wrong

- **Some tracks fail to add:** each one is printed as `sple: failed to add <ref>: <error>`, then `sple: added 93 of 95 tracks; 2 failed (see above)`, and sple exits 1. With `--json`, stdout still gets the `ImportOutput` and stderr ends with a `PartialFailure` error.
- **Adding stops entirely** (quota, authentication): `sple: playlist <url or id> was created, but adding tracks failed`, then the resume command, and the exit code is the error's (5 for quota, 3 for authentication). The playlist holds the tracks added so far; [resume](#resuming-an-interrupted-import) to add the rest.
- **YouTube quota:** adding a track costs 50 of the 10,000 daily units, and a metadata search uses one of 100 daily searches, so YouTube imports are limited to roughly 100 new tracks a day. sple stops with exit code 5 before going over, says when the quota resets (midnight Pacific Time), and prints the command that continues the import the next day. See [the YouTube setup guide](youtube-music-setup.md#quota).
- **Missing permission:** run `sple auth login --provider <provider>` again.

## Resuming an interrupted import

sple saves an import's progress as it goes, in `runs/<runId>.json` in its config directory: after every matched track, as soon as the playlist exists, and after every batch of added tracks. If the import stops (quota, rate limit, expired login, Ctrl-C, crash), stderr says how to continue:

```
sple: import stopped; resume with: sple import --resume 20261007-3fa9c1
sple: Quota exhausted: units (resets at 2026-10-08T07:00:00.000Z)
```

Run that command, after the quota resets if the stop was a quota stop:

```bash
sple import --resume 20261007-3fa9c1
```

- **Nothing is repeated:** tracks already matched aren't searched again, the playlist isn't created twice, and tracks already added aren't added again. If sple was killed between adding a track and saving, it checks the playlist's track count once and skips that track.
- **Uses the original settings:** the run keeps its target provider, `--name`, `--min-confidence` and cache setting, and a copy of the source playlist, so the file doesn't need to be there any more. Those flags (and `--dry-run`) can't be given with `--resume`.
- **Confirmation:** a run that stopped before the playlist was created asks again (or needs `--yes`); one that was already adding tracks just continues.
- **No ID?** After Ctrl-C or a crash sple can't print one. `sple import --resume last` continues the most recent unfinished import.
- **Unknown or old ID:** `No unfinished import '<id>'` lists the imports that can still be resumed. A run expires 30 days after it started. `sple auth logout` deletes the runs that involve that provider.
- **Cleanup:** a finished or declined import deletes its run file. A dry run never creates one.

## Improving matches

- Lower `--min-confidence` if the low-confidence suggestions are right.
- Add a `refs` entry for the target provider to a track in the JSON file. The known-ref strategy then uses it as is.
- Unmatched tracks can be added by hand after the import.

## Limitations

- **YouTube Music has no ISRC search,** so it matches by metadata only. That's less reliable for remixes and alternate versions.
- **Duplicates:** if two source tracks match the same target track, both are added.
- **Liked Songs** can be exported (`sple export --liked`), but import always creates a playlist. It never adds likes.
