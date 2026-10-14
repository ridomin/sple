# ADR 0009: Matching Strategy for Import

- **Status:** Accepted (2026-10-05); amended 2026-10-07 (Amendment 1)
- **Date:** 2026-10-05
- **Deciders:** project owner, architect
- **Related:** FR-MIG-2 (matching strategies), FR-EXP-7 (import), ADR 0003 (provider interface), [ADR 0011](0011-jev-match-judge.md) (Proposed: opt-in Jev judge for metadata hits)

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

> Superseded by Amendment 1 §3–4: normalization folds accents, apostrophes and punctuation, keeps `remix`/`live`/…, and a hit is accepted only with title overlap ≥ 0.5 and some artist overlap.

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

> Superseded by Amendment 1 §1.4: auth, quota and rate-limit errors stop the run; other strategy errors are recorded and the next strategy runs.

Strategies **return null** to mean "no match found" and **throw only on fatal errors**:

- Transient errors (network, 5xx, quota) → return null (fall through)
- Unexpected errors → may throw; the engine catches them and continues with the next strategy, so one bad strategy cannot abort the run

A quota hit therefore does not corrupt the match state.

### No External Dependencies

> Narrowed by Amendment 3 (Proposed): this applies to the `basic` scorer. The opt-in `jev` matcher calls the TypeSafe API through its SDK.

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

## Amendment 2 (match cache, #94)

- **Date:** 2026-10-07
- **Why:** FR-MIG-2 lists "a known ref for the target provider, from the file **or the match cache**", but nothing stored matches, so every import searched again for every track. On YouTube that spends the 100-searches-per-day bucket (ADR 0002 §2.1.2) and a `--dry-run` followed by the real import cost twice.

### 1. Strategy order

| # | Strategy | Applicable when | Call | Candidate |
|---|---|---|---|---|
| 1 | `known-ref` | always | none | unchanged (§2) |
| 2 | `cache` | a match cache is in use (not with `--no-cache`) | none | the cached entry for the track (below), with its **stored** `confidence`, `strategy: 'cache'` |
| 3 | `isrc` | unchanged | unchanged | unchanged |
| 4 | `metadata` | unchanged | unchanged | unchanged |

`MatchCandidate.strategy` (ADR 0003 §3) gains `'cache'`. `minConfidence` is applied to a cached candidate as to any other, so a cached low-confidence match stays low-confidence unless the threshold is lowered.

### 2. File

`match-cache.json` in the config directory, next to `tokens.json` and `quota.json`, written like `quota.json` (temp file with mode `0600`, then rename):

```json
{
  "schemaVersion": 1,
  "targets": {
    "<target provider id>": {
      "<source provider id>|<source ref>": {
        "ref": "<target track ref>",
        "title": "…", "artists": ["…"], "durationMs": 201000,
        "confidence": 0.85,
        "strategy": "metadata",
        "fetchedAt": "2026-10-07T12:00:00.000Z"
      }
    }
  }
}
```

- **Keys:** one per entry of the source track's `refs` whose provider is not the target (a CSV may carry refs of several providers). A track with no such ref is never cached. A lookup tries the track's keys in `refs` order and takes the first fresh, well-formed entry.
- **Entry:** the candidate's ref, title, artists and duration (enough to print the report), its confidence and the strategy that found it (`isrc` or `metadata`). No source metadata is stored.
- **Missing, unparsable or other-version file:** an empty cache. A malformed entry is ignored.

### 3. Writing

- After each track whose candidate came from `isrc` or `metadata` (matched **or** low-confidence), the entry is written under every key of the track, and the file is saved at once, so a quota stop later in the run keeps the searches already spent.
- Unmatched tracks are not cached, so a later run searches for them again.
- `known-ref` and `cache` candidates are not written: the first is free anyway, and re-writing the second would extend its lifetime.
- `--dry-run` reads and writes the cache like a real import.

### 4. Expiry (30-day rule)

An entry is fresh while `now − fetchedAt < 30 days` (YouTube API Developer Policies III.E.4; ADR 0002 §4.1). The limit applies to every provider. Stale entries are ignored on read and removed whenever the file is written. Reusing an entry never extends it.

### 5. CLI

- `sple import --no-cache`: the run neither reads nor writes the cache.
- `sple auth logout --provider X` (and `--all`) deletes every entry that targets `X` or whose key starts with `X|`, whether or not tokens were stored. When any were deleted, `match_cache` is appended to the `Deleted:` line (ADR 0007 Amendment 3).
- Concurrent sple processes are not locked against; the last write wins.

## Amendment 3 (Jev matcher, Proposed with ADR 0011)

- **Date:** 2026-10-14
- **Status:** **Proposed.** It takes effect when [ADR 0011](0011-jev-match-judge.md) is Accepted, after spike S8 ([report](../spikes/jev-matching-spike.md)). Until then sple matches as Amendments 1–2 say, and nothing here is implemented.
- **Why:** On Spotify → YouTube, the metadata score can't tell a cover, live or lyric re-upload from the same recording, and it rejects correct hits whose artist was guessed wrongly. ADR 0011 adds an opt-in judge, TypeSafe's Jev model, that re-ranks the metadata search hits. This amendment is the spec ports implement. ADR 0011 has the reasons, the alternatives and the risks.

Constants marked † are provisional. S8 sets them, and this amendment is updated before it is accepted.

### 1. Matcher

A run has a `matcher`: `basic` (default) or `jev` (`--matcher`, ADR 0007 Amendment 7). With `basic`, the chain is A2 §1, unchanged. With `jev`, slot 4 runs `jev` instead of `metadata`:

| # | Strategy | Applicable when | Call | Candidate |
|---|---|---|---|---|
| 1–3 | `known-ref`, `cache`, `isrc` | unchanged | unchanged | unchanged |
| 4 | `jev` | `matcher` is `jev`, Jev is not switched off for the run (§5), and `track.title` is non-empty | the A1 §2 metadata search, then one Jev request when the shortlist is non-empty | §4 |

`MatchCandidate.strategy` gains `'jev'` (ADR 0003 Amendment 4).

### 2. Shortlist

1. Search exactly like `metadata`: `searchTracks({ kind: 'metadata', title, artists, album, durationMs }, { limit: 10 })`.
2. Score every hit with A1 §4, which gives `t`, `a` and `confidence`.
3. Keep the hits that pass the **relaxed gate** `t > 0 || a > 0`†. Sort them by A1 `confidence`, highest first; this sort is stable, so ties keep the provider's order. Keep the first `K = 5`† and number them `c1…cK` in that order.
4. An empty shortlist means no candidate (`null`), and no Jev request is made.

### 3. Jev request

One `POST https://api.typesafe.ai/v1/systemone` per track, through the TypeSafe SDK (ADR 0011 §6), with `model` = `SPLE_JEV_MODEL` or `jev-1.13.0`.

```json
{
  "model": "jev-1.13.0",
  "state": {
    "source":     { "service": "<source display name>", "title": "…", "artists": ["…"], "album": "…" },
    "candidates": { "c1": { "service": "<target display name>", "title": "…", "artists": ["…"], "album": "…" } }
  },
  "questions": {
    "c1": {
      "type": "score",
      "instructions": "How does candidate c1 relate to the source track as a recording? Ignore words that only describe the upload, such as 'Official Video', 'Lyrics', 'Audio', 'HD' or a channel suffix like 'VEVO' or '- Topic'.",
      "criteria": [
        "A different song.",
        "The same song but a different recording or version: live, remix, cover, acoustic, instrumental, karaoke, sped up or slowed, or re-recorded.",
        "The same recording as the source; only the upload's packaging differs."
      ]
    }
  }
}
```

- There is one question per shortlisted candidate, with the id equal to the candidate key. Every question uses the same instructions (with its own id) and the same criteria. The wording is provisional†.
- `album` is left out when it is absent. Durations, refs, ISRCs, tokens and account data are never sent.
- `service` is the provider's display name (`Spotify`, `YouTube Music`).

### 4. Combining (in code)

For each shortlisted candidate `ci`, read its answer's `score` and `probabilities`:

- `level = floor(score + 0.5)` (round half up), and `p2 = probabilities[2]`.
- **Duration check:** it passes when either `durationMs` is missing or `|Δ| ≤ D` with `D = 10000` ms†.
- `level = 2` and the check passes → eligible, `confidence = p2`.
- `level = 2` and the check fails, or `level = 1` → eligible, `confidence = min(p2, 0.45)`†. The cap keeps a variant or a duration mismatch below the default `minConfidence` (0.5), so it is reported as `low-confidence`. A user who lowers `--min-confidence` below the cap accepts variants on purpose, just as with `basic`.
- `level = 0` → rejected.
- The eligible candidate with the highest `confidence` wins, and ties go to the lower `i`. The result is `{ ref, track, confidence, strategy: 'jev' }`. If nothing is eligible, the result is `null`, and the track is `unmatched` (the `basic` score is not consulted).
- Confidence is a double and is not rounded. The engine applies `minConfidence` as in A1 §1.2.

### 5. Jev errors

Jev never stops a run, and its errors never take the A1 §1.4 path:

- On any Jev failure the strategy returns the **A1 `metadata` result for the same hits**, with `strategy: 'metadata'`. That covers no response, a timeout, HTTP 401, 422, 429 or 529 after the SDK's retries, or an answer missing a question or `probabilities[2]`. The track's `MatchResult.error` is set to `jev: <message>` even when the fallback matched.
- The first failure in a run prints one warning on stderr (ADR 0007 Amendment 7).
- After a **401**, `jev` is not applicable for the rest of the run, so slot 4 runs `metadata`.
- Jev errors are never `AuthRequiredError`, `QuotaExhaustedError` or `RateLimitError`, so a TypeSafe 429 can't be mistaken for a provider quota stop.

### 6. Cache and report

- **Cache (A2):** a `jev` candidate is written like an `isrc` or `metadata` one, and the entry's `strategy` may be `'jev'`. The key does not include the matcher. A fresh entry is reused by both matchers, and `--no-cache` forces a new decision.
- **Report (A1 §6):** `MatchReport` gains `matcher?: 'basic' | 'jev'` (absent means `basic`) and `jevModel?: string`, the `model` field of the first Jev response in the run. `strategies[]` lists `jev` when it ran.
- **Text report:** when `matcher` is `jev`, `Matcher: jev (<jevModel>)` follows the `Imported at` line. `jevModel` is `not called` when no Jev request was made.

### 7. Test vectors

These assume `minConfidence` 0.5 and the provisional constants. Each candidate passed the shortlist. "Score" and "p2" are Jev's answer, and the durations are in seconds.

| Shortlist (score / p2 / source s / candidate s) | Result |
|---|---|
| c1: 1.90 / 0.92 / 243 / 245 | `matched`, c1, 0.92 |
| c1: 1.20 / 0.30 / 243 / 243 | `low-confidence`, c1, 0.30 (level 1) |
| c1: 1.80 / 0.85 / 301 / 420 | `low-confidence`, c1, 0.45 (duration cap) |
| c1: 1.50 / 0.48 / – / 200 | `low-confidence`, c1, 0.48 (rounds to level 2, duration unknown) |
| c1: 0.40 / 0.05 / 200 / 200 | `unmatched`, `null` (level 0) |
| c1: 1.70 / 0.80 / 200 / 201; c2: 1.95 / 0.93 / 200 / 199 | `matched`, c2, 0.93 |
| c1: 1.90 / 0.90 / 200 / 200; c2: 1.90 / 0.90 / 200 / 200 | `matched`, c1, 0.90 (tie, lower i) |
| c1: 1.10 / 0.40 / 200 / 200; c2: 0.20 / 0.02 / 200 / 200 | `low-confidence`, c1, 0.40 |
| c1: 1.99 / 0.97 / 200 / 230 | `low-confidence`, c1, 0.45 (Δ 30 s > D) |
| request fails with 529 after retries; A1 accepts c2 at 0.85 | `matched`, c2, 0.85, `strategy: 'metadata'`, `error: 'jev: …'` |
