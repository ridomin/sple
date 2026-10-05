# Nullability and Empty Value Fixes

## Summary

This document outlines all fixes made to handle null and empty string values gracefully in Spotify API responses. The fixes ensure that the CLI never crashes with "Cannot read properties of null" errors and always provides reasonable defaults for missing or empty data.

## Issues Fixed

### 1. Null Items in Search Results (Critical)

**Problem:** Spotify's search API can return `null` values in result arrays for unavailable or deleted items. This caused a `TypeError: Cannot read properties of null (reading 'id')`.

**Location:** `src/providers/spotify/mappers.ts` - `mapSpotifySearchResults()`

**Fix:** Added null checks to skip null/undefined items for all search result types (tracks, albums, artists, playlists).

```typescript
// Before: would crash on null items
for (const track of validated.tracks.items) {
  results.push(mapSpotifySearchTrack(track))
}

// After: gracefully skips nulls
for (const track of validated.tracks.items) {
  if (!track) continue  // Skip null/undefined items
  results.push(mapSpotifySearchTrack(track))
}
```

**Tests:** `tests/providers/spotify/search.test.ts`
- `mapSpotifySearchResults: skips null items gracefully`
- `mapSpotifySearchResults: skips null items in all types`

---

### 2. Empty Playlist Names

**Problem:** Spotify can return playlists with empty string names. The validation `!obj.name` treated empty strings as invalid, causing a `ProviderError`.

**Locations:**
- `src/providers/spotify/schemas.ts` - `validateSpotifyPlaylist()` - Changed to only check type
- `src/providers/spotify/mappers.ts` - `mapSpotifyPlaylistToSummary()` and `mapSpotifySearchPlaylist()` - Added default name

**Fix:** 
```typescript
// Validation: Allow empty strings (still a valid string type)
if (typeof obj.name !== 'string') {  // Removed the || !obj.name check
  throw new ProviderError(...)
}

// Mapper: Provide default when empty
name: validated.name || '(untitled)',
```

**Tests:** `tests/providers/spotify/mappers.test.ts`
- `mapSpotifyPlaylistToSummary: handles empty playlist name with default value`

---

### 3. Empty Track Names and URIs (Defensive)

**Problem:** While less common, tracks could have empty names or URIs. Applied same pattern for consistency.

**Locations:**
- `src/providers/spotify/schemas.ts` - `validateSpotifyTrack()` - Loosened validation
- `src/providers/spotify/mappers.ts` - Track mapper and search track mapper - Added defaults

**Fixes:**
```typescript
// Track mapper defaults
title: validated.name || '(untitled)',
refs: { spotify: validated.uri || '(no uri)' },

// Search track mapper
name: track.name || '(untitled)',
```

**Tests:** `tests/providers/spotify/mappers.test.ts`
- `mapSpotifyTrackToCanonical: handles empty track name with default value`
- `mapSpotifyTrackToCanonical: handles empty track uri with default value`

---

### 4. Empty Album and Artist Names (Defensive)

**Problem:** Applied same defensive pattern to album and artist search results.

**Locations:**
- `src/providers/spotify/mappers.ts` - Album, artist, and playlist search mappers

**Fixes:**
```typescript
// Album
name: album.name || '(untitled)',

// Artist
name: artist.name || '(unnamed)',

// Playlist
name: playlist.name || '(untitled)',
```

**Tests:** `tests/providers/spotify/search.test.ts`
- `mapSpotifySearchResults: handles empty names in search results`

---

## Validation Changes Summary

### Stricter Validation (Reject Invalid Types)
- `id` fields: Must be non-empty strings (remain strict)
- `uri` fields: Must be strings (allows empty after fix)
- Object type checks: `owner`, `item`, etc. must be objects

### Relaxed Validation (Allow Empty Strings)
- `name` fields: Must be strings, but can be empty
- `uri` fields in tracks: Must be strings, but can be empty

### Handler Pattern
For all fields that can be empty, mappers provide sensible defaults:
- Track/Album/Playlist names: `'(untitled)'`
- Artists: `'(unnamed)'`
- URIs: `'(no uri)'`

---

## Test Results

```
Total tests: 630
Passed: 630
Failed: 0

New tests added: 7
- 2 null items in search tests
- 1 empty playlist name test
- 2 empty track tests
- 1 empty names in search results test
- 1 integration validation
```

All tests pass with no regressions.

---

## Commands Verified

All CLI commands tested and working:

```bash
# Search commands
sple search "hello" --type track
sple search "mola" --type playlist
sple search "thriller" --type album
sple search "adele" --type artist

# Playlist commands
sple playlist list --owned
sple playlist show <playlist-id>
sple playlist create <name>

# Export commands
sple export <playlist-id> -o file.csv
sple export --liked -o liked.csv

# Auth commands
sple auth status
```

---

## Future Improvements

1. Add similar defensive handling for other providers (YouTube Music, Amazon Music)
2. Consider stricter validation in validation layer vs. softer defaults in mapper layer
3. Log warnings when empty values are encountered (optional)
4. Document which fields can realistically be empty in Spotify API

---

## Files Changed

1. `src/providers/spotify/schemas.ts` - Validation changes
2. `src/providers/spotify/mappers.ts` - Default value handling
3. `tests/providers/spotify/mappers.test.ts` - New validation tests
4. `tests/providers/spotify/search.test.ts` - New search tests
