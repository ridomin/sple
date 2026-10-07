# ADR 0009: Matching Strategy for Import

- **Status:** Accepted (2026-10-05); amended 2026-10-07 (Amendment 1)
- **Date:** 2026-10-05
- **Deciders:** project owner, architect
- **Related:** FR-MIG-2 (matching strategies), FR-EXP-7 (import), ADR 0003 (provider interface)

## Context

M3 implements track matching for import (FR-EXP-7). Users export playlists from one provider and import them to another. The matcher must convert tracks from the source provider to track IDs on the target provider using various strategies (FR-MIG-2):

1. Known ref (cached or in file)
2. ISRC (International Standard Recording Code)
3. Metadata (normalized title + artist + duration)

The matcher runs locally without user intervention, then produces a report listing matched, low-confidence, and unmatched tracks.

## Decision

### Strategy Chain Pattern

Matching uses a **strategy chain** where each strategy is a plugin:

```
for each track:
  for each applicable strategy (in priority order):
    candidate = strategy.execute(track)
    if candidate found:
      return candidate
  if no strategy matched:
    mark as unmatched
```

Strategies implement the `MatchingStrategy` interface:

```typescript
interface MatchingStrategy {
  readonly name: string;
  readonly priority: number;  // 1 (highest) to 3 (lowest)
  isApplicable(request: MatchRequest): boolean;
  execute(request: MatchRequest, provider: Provider): Promise<MatchCandidate | null>;
}
```

### Three Strategies

**1. Known Ref Strategy** (priority 1, highest)
- Condition: Track has a known ref for the target provider (from cache or file)
- API calls: 0
- Confidence: 1.0 (100%)
- Rationale: No search needed; use what we know.

**2. ISRC Strategy** (priority 2, medium)
- Condition: Both source and target provider support ISRC; track has ISRC in file
- API calls: 1 (search by ISRC)
- Confidence: 0.95 (95%)
- Rationale: ISRC uniquely identifies a recording; very reliable.

**3. Metadata Strategy** (priority 3, lowest)
- Condition: Track has title and artist
- API calls: 1 (search by title + artist)
- Confidence: 0.4–1.0 (variable)
- Rationale: Most common path; subject to false positives and negatives.

### Metadata Scoring

Metadata confidence combines three signals:

- **Title similarity** (weight 50%): word-overlap after normalization
- **Artist similarity** (weight 35%): presence of query artists in candidates
- **Duration match** (weight 15%): within ±5 seconds

Normalization:
- Unicode NFD (decompose accents)
- Lowercase
- Remove common suffixes: `(feat. X)`, `(Remix)`, etc.

Threshold: the metadata strategy returns no candidate below 0.4. The engine additionally marks matches below `--min-confidence` (default 0.5) as low-confidence.

### Applicability Check

Each strategy declares which requests it can handle via `isApplicable()`. The engine skips inapplicable strategies:

- **Known Ref** is always applicable (but returns null if no known ref exists)
- **ISRC** is applicable only if the target provider supports ISRC search and the track has an ISRC
- **Metadata** is applicable if the track has a title

This avoids unnecessary API calls and keeps the report honest ("tried metadata, found nothing").

### Error Handling

Strategies **return null** to mean "no match found" and **throw only on fatal errors**:

- Transient errors (network, 5xx, quota) → return null (fall through)
- Unexpected errors → may throw; the engine catches them and continues with the next strategy, so one bad strategy cannot abort the run

A quota hit therefore does not corrupt the match state.

### No External Dependencies

Matching uses no fuzzy-matching or NLP libraries (like leven, fuzzy-wuzzy, or jaro-winkler). Simple word overlap is sufficient because:
- Provider search APIs already do the heavy lifting
- False positives (wrong match) are worse than false negatives (no match) for the user
- Keeping logic simple makes it testable and auditable

## Consequences

- **Modularity:** Adding a new strategy (e.g., YouTube-specific heuristic) is a matter of implementing and registering it.
- **Testability:** Each strategy is independent and can be tested in isolation with mocked provider responses.
- **Predictability:** Strategy order is fixed; no randomness in matching results.
- **Trade-off:** Metadata matching is conservative (high false-negative rate) to avoid false positives. Users will see "unmatched" more often than "wrong match".
- **Resumability:** Checkpointing progress (M3.1 feature) is simplified because strategies are stateless.

## Alternatives Considered

1. **Single unified search.** Send title + artist to provider search, take best result.
   - Rejected: doesn't use ISRC when available; no opportunity to verify with known refs.

2. **Fuzzy matching with Levenshtein distance.**
   - Rejected: adds external dependency; word overlap is sufficient given provider search results.

3. **Parallel strategies.** Run all applicable strategies concurrently, pick the best result.
   - Rejected: complicates quota tracking and error handling; sequential execution is clearer.

4. **ML-based confidence scoring** (train on user corrections).
   - Rejected: out of scope for M3; simple metadata scoring is a good baseline.

## Status

Accepted. Implemented in M3-5 to M3-6.

## Amendment 1 (spec review for ports)

- **Date:** 2026-10-07
- **Why:** pin the matching algorithm down so every implementation gives the same results for the same input, and record the review decisions: adapters own query syntax, fatal errors stop matching, and a fixed normalization that folds accents and punctuation (#30) and rejects candidates without title and artist overlap (#25). Differences in the TypeScript code are tracked in `docs/requirements.md` §12.

### 1. Engine

1. Tracks are matched one at a time, in `position` order. For each track the engine runs the applicable strategies in priority order and stops at the first that returns a candidate.
2. A candidate below `minConfidence` (default 0.5, `--min-confidence`) is `low-confidence`; otherwise `matched`. A track with no candidate is `unmatched`.
3. The file's `unsupportedItems` are appended as `unsupported` results (title = item `name` or `Unknown`, no artists, no refs).
4. **Errors:** `AuthRequiredError`, `QuotaExhaustedError` and `RateLimitError` (after HTTP retries, ADR 0010) stop the whole run and propagate with their exit code; no playlist is created. Any other error inside a strategy is recorded and the next strategy runs; if no strategy produces a candidate, the result is `unmatched` with `error` set to the last recorded message.

### 2. Strategies

Strategies call `provider.searchTracks` (ADR 0003 Amendment 2); core never builds provider query strings.

| # | Strategy | Applicable when | Call | Candidate |
|---|---|---|---|---|
| 1 | `known-ref` | always | none | `track.refs[target.id]` if present; `confidence: 1.0`; the ref is trusted without a lookup |
| 2 | `isrc` | `track.isrc` is a non-empty string **and** the target's `isrcSearchMode !== 'none'` (the source's ISRC support does not matter: the ISRC is already in the file) | `searchTracks({ kind: 'isrc', isrc }, { limit: 5 })` | first hit; `confidence: 0.95` |
| 3 | `metadata` | `track.title` is non-empty | `searchTracks({ kind: 'metadata', title, artists, album, durationMs }, { limit: 10 })` | best accepted hit by §4 |

The candidate is a `MatchCandidate` (`ref`, `track`, `confidence`, `strategy`).

### 3. Normalization

`normalizeText(s)`, applied in this order:

1. Unicode NFKD.
2. Remove every code point in General Category `M` (combining marks).
3. Lower-case (Unicode default case mapping, locale-independent).
4. Remove apostrophes: U+0027 `'`, U+2018 `‘`, U+2019 `’`, U+02BC `ʼ`.
5. Replace `&` with ` and `.
6. Replace every run of characters that are not Unicode letters (`L`) or numbers (`N`) with one space.
7. Trim.

`tokens(s)` is the **set** of space-separated words of `normalizeText(s)`.

`stripTitleDecorations(title)` runs before tokenizing a title:

1. **Bracketed segments:** for each `(…)` or `[…]` that has no nested brackets, if `normalizeText(content)` matches `VERSION` or `CREDIT_BRACKET`, remove the segment and the whitespace before it.
2. **Dash suffix:** while the title has the form `<head> <dash> <tail>` (dash = `-`, `–` U+2013 or `—` U+2014, surrounded by whitespace, split at the **last** dash) and `normalizeText(tail)` matches `VERSION` or `CREDIT_DASH`, replace the title with `<head>`.

```
VERSION        = ^(?:(?:\d{4} )?(?:digital |digitally )?(?:remaster|remastered)(?: \d{4})?(?: version)?|explicit|clean|mono|stereo|radio edit|single version|album version)$
CREDIT_BRACKET = ^(?:feat|ft|featuring|with) .+$
CREDIT_DASH    = ^(?:feat|ft|featuring) .+$
```

Words that change the recording (`live`, `remix`, `acoustic`, `instrumental`, `cover`, …) are deliberately kept, so a live version scores lower than the studio one.

`titleTokens(t) = tokens(stripTitleDecorations(t))`. Artists are not decoration-stripped.

### 4. Metadata score

For source track `s` and candidate hit `c`:

- **Title** `t = |T_s ∩ T_c| / max(|T_s|, |T_c|)` over `titleTokens`; 0 if either set is empty.
- **Artist** `a` = the fraction of the source's artists (those with non-empty `tokens`) for which some candidate artist `x` satisfies `tokens(artist) ⊆ tokens(x)` or `tokens(x) ⊆ tokens(artist)`; 0 if either list is empty.
- **Duration** is used only when both `durationMs` are numbers: `d = 1` if `|Δ| ≤ 5000` ms, else 0.
- `confidence = 0.5·t + 0.35·a + 0.15·d` when the duration is used, otherwise `(0.5·t + 0.35·a) / 0.85`. Computed in IEEE-754 double precision in this order; not rounded.
- **Accepted** only if `t ≥ 0.5`, `a > 0` and `confidence ≥ 0.4`. The best accepted hit wins; ties go to the earlier hit in the provider's order.

### 5. Test vectors

Implementations must reproduce these (confidence shown rounded to 4 decimals; compare with a tolerance of 1e-9).

| `normalizeText` input | Output |
|---|---|
| `Beyoncé` | `beyonce` |
| `Don’t Stop Me Now` | `dont stop me now` |
| `Simon & Garfunkel` | `simon and garfunkel` |
| `ＡＢＣ　Ｄｅｆ` (full-width) | `abc def` |
| `Hello,  World!` | `hello world` |
| `Mötley Crüe` | `motley crue` |

| Title | `titleTokens` (in first-seen order) |
|---|---|
| `Let It Be - Remastered 2009` | `let it be` |
| `Don’t Stop Me Now - 2011 Remaster` | `dont stop me now` |
| `Señorita (feat. Camila Cabello)` | `senorita` |
| `Old Town Road (with Billy Ray Cyrus) [Remix]` | `old town road remix` |
| `Hello (Live)` | `hello live` |
| `Song - With You` | `song with you` |
| `Track [Explicit] - Radio Edit` | `track` |
| `Bohemian Rhapsody - Remastered 2011 - Mono` | `bohemian rhapsody` |
| `Up & Up (feat. X) - Digitally Remastered` | `up and` (a set: `up` appears once) |

| Source (title / artists / ms) | Candidate (title / artists / ms) | t | a | confidence | accepted |
|---|---|---|---|---|---|
| Let It Be - Remastered 2009 / The Beatles / 243000 | Let It Be / The Beatles / 243026 | 1 | 1 | 1 | yes |
| Halo / Beyoncé / – | Halo / Beyonce / – | 1 | 1 | 1 | yes |
| Don’t Stop Me Now / Queen / 209000 | Don't Stop Me Now - 2011 Remaster / Queen / 216000 | 1 | 1 | 0.85 | yes |
| Señorita (feat. Camila Cabello) / Shawn Mendes, Camila Cabello / 190799 | Señorita / Shawn Mendes, Camila Cabello / 190800 | 1 | 1 | 1 | yes |
| Yesterday / The Beatles / 125000 | Hey Jude / The Beatles / 125000 | 0 | 1 | 0.5 | **no** (title) |
| Hallelujah / Leonard Cohen / 280000 | Hallelujah / Jeff Buckley / 280000 | 1 | 0 | 0.65 | **no** (artist) |
| The Boxer / Simon & Garfunkel / – | The Boxer / Simon and Garfunkel / – | 1 | 1 | 1 | yes |
| Hello (Live) / Adele / 300000 | Hello / Adele / 295500 | 0.5 | 1 | 0.75 | yes |
| Come Together / Beatles / – | Come Together / The Beatles / – | 1 | 1 | 1 | yes |
| Under Pressure / Queen, David Bowie / 248000 | Under Pressure / Queen / 260000 | 1 | 0.5 | 0.675 | yes |
| Smells Like Teen Spirit / Nirvana / 301000 | Smells Like Teen Spirit (Live) / Nirvana / 420000 | 0.8 | 1 | 0.75 | yes |

The last row is a known limit: a live version with a very different duration still passes the default threshold. Raise `--min-confidence` to 0.8 to exclude it.

### 6. Match report v1

```ts
export interface MatchReport {
  schemaVersion: 1
  importedAt: string                       // ISO 8601 UTC
  sourceFile: { path: string; provider: string; playlistName: string; trackCount: number }
  targetProvider: ProviderId
  targetPlaylistName: string               // --name or the file's playlist name
  minConfidence: number
  results: MatchResult[]                   // tracks in position order, then unsupported items
  summary: { total: number; matched: number; lowConfidence: number; unmatched: number; unsupported: number }
  recommendations: string[]
}

export interface MatchResult {
  position: number
  track: CanonicalTrack                    // the source track
  status: 'matched' | 'low-confidence' | 'unmatched' | 'unsupported'
  candidate?: MatchCandidate               // matched and low-confidence only
  confidence?: number                      // = candidate.confidence
  strategies: string[]                     // strategies tried, in order (ends with the one that matched)
  error?: string
}
```

`recommendations`, in this order, each only when its count is > 0:
- `<n> track(s) could not be matched. Check the match report for details.`
- `<n> track(s) have low confidence matches. Review and adjust if needed.`
- `<n> item(s) are not supported on the target provider and will be skipped.`

**Text report** (stdout in table/TSV mode, or `--report <file>` not ending in `.json`). Percentages are `round(100 · value / total)` with halves rounded up, and `0%` when `total` is 0:

```
Match Report: <playlistName>
Source: <source provider> → Target: <target provider>
Imported at: <importedAt>

Summary
-------
Total tracks:    <total>
Matched:         <n> (<p>%)
Low confidence:  <n> (<p>%)
Unmatched:       <n> (<p>%)
Unsupported:     <n> (<p>%)

Recommendations            (only if any)
---------------
• <recommendation>

Unmatched Tracks           (only if any; first 20, then "... and <k> more")
----------------
<position>: <title> — <artists joined with ", ">
   Error: <error>          (only if set)

Low-Confidence Matches     (only if any; first 10, then "... and <k> more")
---------------------
<position>: <title> → <candidate title> (<confidence as %>)
```

Each section ends with an empty line. The annotations in parentheses are not printed.
