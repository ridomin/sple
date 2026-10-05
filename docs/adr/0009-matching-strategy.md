# ADR 0009: Matching Strategy for Import

- **Status:** Accepted (2026-10-05)
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
