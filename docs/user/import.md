# Importing Playlists

`sple import` matches tracks from an exported canonical file against your target provider and produces a match report.

> **Status:** matching and reporting are implemented. Creating the playlist on the target provider is not implemented yet; after confirmation `sple import` currently prints a placeholder message.

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
Minimum confidence score to automatically match a track (0–1). Below this threshold, matches are marked as "low-confidence" and listed in the report for review.

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

You can review these manually:

1. Check the match report for each low-confidence track.
2. If the suggested match is correct, you can proceed with import.
3. If it's wrong, edit the canonical file (JSON only) to add the correct track ref, then re-run import.

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

## Known Limitations

- **YouTube Music:** No ISRC support. Matching relies on metadata only, which is less reliable for remixes and alternate versions.
- **Liked Songs:** Import does not target Liked/Saved Tracks; matches are intended for a new playlist.
- **Duplicate matches:** If two different source tracks match the same target track, the import will add both, resulting in duplicates.

## Resumable Imports

(Planned for v1.1)

Long imports (1,000+ tracks) can be interrupted and resumed. Progress is saved to a state file, allowing you to pause when hitting rate limits or quotas.
