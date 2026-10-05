# Importing Playlists

`sple import` matches tracks from an exported canonical file against your target provider, produces a match report, and (after confirmation) creates a new private playlist with the matched tracks.

## Basic Usage

```bash
sple import <file> [--provider spotify|youtube-music] [--name "Playlist Name"]
```

### Example

```bash
# Import a Spotify export to YouTube Music
sple import my-playlist.json --provider youtube-music --name "My Music on YouTube"

# Import with a match report
sple import my-playlist.json --report import-report.txt
```

## How Matching Works

The matching engine uses a three-step strategy chain:

1. **Known Ref** (highest priority)
   - If the exported file already has a reference for the target provider, use it directly.
   - Example: if you exported a playlist, re-imported it to the same provider.
   - Confidence: 100%

2. **ISRC** (medium priority)
   - If both the source and target providers support ISRC (International Standard Recording Code), search by ISRC.
   - Spotify supports ISRC; YouTube Music does not. A track is only eligible if the file records an ISRC for it.
   - Confidence: 95% (very high but not perfect)

3. **Metadata** (lowest priority, most common)
   - Normalize the track title and artist name, then search on the target provider.
   - Score based on title match (50%), artist match (35%), and duration match (15%).
   - Confidence: variable (typically 40–95%)

The engine tries each applicable strategy in order and returns the first match. Matches below `--min-confidence` are reported as low-confidence.

## Options

### `--provider`
Target provider for import. Default: `spotify`.

### `--name`
Name for the new playlist. Default: original playlist name from the file.

### `--report`
Save a match report to the given file. Can be `.json` (machine-readable) or `.txt` (human-readable).

### `--min-confidence`
Minimum confidence score to automatically match a track (0–1). Below this threshold, matches are marked as "low-confidence", listed in the report for review, and **not added** to the playlist.

Default: `0.5` (50%)

### `--dry-run`
Show what would be imported without creating the playlist.

### `--yes`
Skip the confirmation prompt before creating the playlist.

## Match Report

After matching completes, `sple` prints a summary:

```
Match Report: My Playlist
Source: spotify → Target: youtube-music

Summary
-------
Total tracks:    100
Matched:         95 (95%)
Low confidence:  3 (3%)
Unmatched:       2 (2%)
Unsupported:     0 (0%)

Recommendations
---------------
• 2 tracks could not be matched. Check the match report for details.
```

### Low-Confidence Matches

If a match's confidence score falls below `--min-confidence`, it's marked as "low-confidence" and listed in the report:

```
Low-Confidence Matches
---------------------
15: Track Title → Slightly Different Title (42%)
42: Song Name (remix) → Song Name (78%)
```

Low-confidence matches are left out of the created playlist. To include them:

1. Check the match report for each low-confidence track.
2. If the suggested matches are correct, re-run with a lower `--min-confidence`.
3. Otherwise, edit the canonical file (JSON only) to add the correct track ref, then re-run import.

### Unmatched Tracks

Tracks that could not be matched at all are listed:

```
Unmatched Tracks
----------------
5: Very Obscure Local Artist Song
18: Unreleased Demo Track
```

Options:
- **Add the track manually** to the created playlist after import.
- **Edit the file** (JSON) to add known refs for these tracks, then re-run.
- **Accept the import** without these tracks.

## Creating the Playlist

After you confirm (or with `--yes`), `sple` creates a private playlist and adds the matched tracks in their original order.

- If the provider rejects some tracks, each one is listed with its error, followed by a summary such as `sple: added 98 of 100 tracks; 2 failed (see above)`. The command exits with code 1 (with `--json`, the last stderr line is a `PartialFailure` error).
- If adding tracks stops entirely (for example, the quota runs out), `sple` prints the created playlist's link or ID and exits with that error's code (5 for quota, 3 for authentication). The playlist may already contain some of the tracks.
- If the provider requires a permission you haven't granted, run `sple auth login` again.

## Known Limitations

- **YouTube Music:** No ISRC support. Matching relies on metadata only, which is less reliable for remixes and alternate versions.
- **Liked Songs:** Import does not target Liked/Saved Tracks; matches are intended for a new playlist.
- **Duplicate matches:** If two different source tracks match the same target track, the import will add both, resulting in duplicates.

## Resumable Imports

(Planned for v1.1)

Long imports (1,000+ tracks) can be interrupted and resumed. Progress is saved to a state file, allowing you to pause when hitting rate limits or quotas.
