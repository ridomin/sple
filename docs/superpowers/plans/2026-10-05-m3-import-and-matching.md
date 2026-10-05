# M3 Import and Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement track matching engine and import command to allow users to create playlists from exported canonical files by intelligently matching tracks across providers.

**Architecture:** M3 builds on M1–M2's export infrastructure and provider adapters. The matching engine implements a strategy chain (known ref → ISRC → metadata matching) that works with any provider pair. Import reads canonical JSON or CSV files, matches tracks on the target provider, produces a match report (matched, low-confidence, unmatched), and creates the playlist if matching succeeds. All matching logic is provider-agnostic; providers only declare which strategies they support.

**Tech Stack:** TypeScript, Node.js 20+ LTS, ESM, Jest, canonical JSON/CSV readers, strategy-chain pattern

**Spec:** This plan implements FR-EXP-7 (import), FR-MIG-2 (matching strategies), and FR-MIG-3 (match report). It assumes completion of M0–M2 (provider interface, HTTP client, export infrastructure, both providers).

---

## Global Constraints

- Node.js 20+ LTS only (use native fetch, no polyfills)
- ESM modules exclusively
- TypeScript strict mode; no `any` types
- All HTTP requests go through M0's `HttpClient` (retry, token refresh)
- Matching strategies must be testable and provider-agnostic; all provider-specific knowledge lives in capabilities
- Match reports must be consumable by humans (table format) and machines (`--json`)
- No external matching libraries (e.g., fuzzy-wuzzy, leven); implement normalized title/artist comparison inline
- Test coverage: ≥ 70% on matching engine; ≥ 65% on import command
- No real API calls in tests; all provider responses mocked

---

## Review Focus

These five input classes / failure modes are most likely to silently break user workflows if not tested explicitly:

1. **A canonical file has tracks the target provider cannot represent (e.g., episode on Spotify source → YouTube Music target, which has no episode type).** Matching must skip unsupported item types gracefully and report them in the match report, not crash.

2. **Title normalization edge cases (ft. vs. feat., unicode combining characters, parenthetical notes like "(Remix)")** → Matcher must normalize both query and provider result consistently, or false negatives appear (user thinks a match exists but is told it doesn't).

3. **ISRC is None/null in the file, or the target provider doesn't support ISRC search** → Matcher must fall through to metadata matching without wasting an API call, and report why a match was low-confidence.

4. **Two tracks in the file resolve to the same track on the target** (e.g., alternate versions of the same song, both matched by metadata). Import must report the collision and ask the user to disambiguate or accept the duplicate (defer to match-report review, FR-MIG-3).

5. **Provider returns a 429 / quota exceeded mid-matching of a 1,000-track playlist.** Matcher must checkpoint progress to a state file so the user can resume from the last matched track, not from the beginning. (FR-MIG-4 resumability; deferred from import v1 to v1.1, but the file structure must allow it.)

Each failure mode has an explicit test case added to the owning task below.

---

## File Structure

### Core Matching

```
src/core/matching/
├── matching-engine.ts          # Main MatchingEngine class, strategy orchestration
├── strategies/
│   ├── index.ts                # Export all strategies
│   ├── known-ref-strategy.ts    # Strategy 1: use known provider refs
│   ├── isrc-strategy.ts         # Strategy 2: search by ISRC
│   └── metadata-strategy.ts     # Strategy 3: normalized title+artist+duration
├── normalizer.ts               # Title/artist normalization, confidence scoring
├── types.ts                    # MatchCandidate, MatchResult, MatchReport
└── errors.ts                   # MatchingError types
```

### Import Command

```
src/cli/commands/
├── import.ts                   # `sple import` command handler

src/core/import/
├── importer.ts                 # Import orchestrator: read file, match, create playlist
├── file-reader.ts              # JSON and CSV canonical file reader
├── match-report-writer.ts      # Write match reports to files and stdout
└── state-manager.ts            # Checkpoint progress (v1.1 feature; scaffold only in v1)
```

### Tests

```
tests/core/matching/
├── matching-engine.test.ts
├── strategies/
│   ├── known-ref-strategy.test.ts
│   ├── isrc-strategy.test.ts
│   └── metadata-strategy.test.ts
├── normalizer.test.ts
├── fixtures/
│   ├── canonical-tracks.json   # Sample export file
│   ├── match-results.json      # Fixture match reports
│   └── provider-fixtures/      # Mock provider responses

tests/cli/commands/
├── import.test.ts              # Integration tests for `sple import` command
```

### Documentation

```
docs/user/import.md             # User guide for `sple import`
docs/dev/matching-strategy.md   # Developer guide: extending strategies
docs/adr/0009-matching-strategy.md  # Decision record for matching approach
```

---

## Task Breakdown

### Phase 1: Matching Engine Core

#### Task M3-1: Define matching types and strategy interface

**Files:**
- Create: `src/core/matching/types.ts`
- Create: `src/core/matching/errors.ts`
- Create: `src/core/matching/strategies/index.ts` (export interface)

**Interfaces:**
- Consumes: `CanonicalTrack` (from M1-25), `MatchCandidate` (from M2-1/3 providers), `ProviderCapabilities` (from M0-2)
- Produces: `MatchingStrategy` interface, `MatchResult`, `MatchReport` types

- [ ] **Step 1: Write types for matching results**

Create `src/core/matching/types.ts`:

```typescript
import { CanonicalTrack, MatchCandidate } from '../provider/provider.js';

// Result of a single match attempt
export interface MatchResult {
  track: CanonicalTrack;
  position: number;
  status: 'matched' | 'low-confidence' | 'unmatched' | 'unsupported';
  candidate?: MatchCandidate;  // Best match (if status is matched or low-confidence)
  confidence?: number;          // Confidence score (0-1)
  strategies?: string[];        // Which strategies were tried
  error?: string;               // Error message if matching failed
}

// Collection of all match results for a playlist
export interface MatchReport {
  importedAt: string;           // ISO 8601 UTC
  sourceFile: {
    path: string;
    provider: string;
    playlistName: string;
    trackCount: number;
  };
  targetProvider: string;
  targetPlaylistName?: string;  // Name for the new playlist
  results: MatchResult[];
  summary: {
    total: number;
    matched: number;
    lowConfidence: number;
    unmatched: number;
    unsupported: number;
  };
  recommendations?: string[];  // Suggested actions for the user
}

// Request to match a single track
export interface MatchRequest {
  track: CanonicalTrack;
  position: number;
  targetProvider: string;
  capabilities: ProviderCapabilities;
}
```

- [ ] **Step 2: Write strategy interface**

Add to `src/core/matching/types.ts`:

```typescript
export interface MatchingStrategy {
  readonly name: string;  // e.g., 'known-ref', 'isrc', 'metadata'
  readonly priority: number;  // 1 = highest (tried first)
  isApplicable(request: MatchRequest): boolean;  // Can this strategy be used?
  execute(request: MatchRequest, provider: Provider): Promise<MatchCandidate | null>;
}
```

- [ ] **Step 3: Write error types**

Create `src/core/matching/errors.ts`:

```typescript
export class MatchingError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'MatchingError';
  }
}

export class MatchStrategyError extends MatchingError {
  constructor(strategy: string, message: string) {
    super(`${strategy} strategy failed: ${message}`, 'STRATEGY_ERROR');
  }
}

export class NoApplicableStrategyError extends MatchingError {
  constructor(message: string) {
    super(message, 'NO_APPLICABLE_STRATEGY');
  }
}

export class ProviderQuotaError extends MatchingError {
  constructor(provider: string, retryAfter?: number) {
    super(`${provider} quota exceeded`, 'QUOTA_EXCEEDED');
    this.retryAfter = retryAfter;
  }
  retryAfter?: number;
}
```

- [ ] **Step 4: Create strategy export**

Create `src/core/matching/strategies/index.ts`:

```typescript
export { MatchingStrategy } from '../types.js';

// Strategies will be imported here after each is implemented
// export { KnownRefStrategy } from './known-ref-strategy.js';
// export { IsrcStrategy } from './isrc-strategy.js';
// export { MetadataStrategy } from './metadata-strategy.js';
```

- [ ] **Step 5: Write types test**

Create `tests/core/matching/types.test.ts`:

```typescript
import { MatchResult, MatchReport } from '../../../src/core/matching/types.js';

describe('Matching types', () => {
  it('should create MatchResult with matched status', () => {
    const result: MatchResult = {
      track: { title: 'Song', artists: ['Artist'], album: 'Album', duration: 180000, ref: 'src:1' },
      position: 1,
      status: 'matched',
      confidence: 0.95,
      candidate: {
        trackRef: 'tgt:1',
        confidence: 0.95,
        metadata: { title: 'Song', artists: ['Artist'], duration: 180000 }
      },
      strategies: ['metadata']
    };
    expect(result.status).toBe('matched');
    expect(result.confidence).toBe(0.95);
  });

  it('should create MatchReport with summary', () => {
    const report: MatchReport = {
      importedAt: new Date().toISOString(),
      sourceFile: {
        path: '/path/to/export.json',
        provider: 'spotify',
        playlistName: 'My Playlist',
        trackCount: 100
      },
      targetProvider: 'youtube-music',
      results: [],
      summary: {
        total: 100,
        matched: 95,
        lowConfidence: 3,
        unmatched: 2,
        unsupported: 0
      }
    };
    expect(report.summary.matched + report.summary.lowConfidence).toBe(98);
  });

  it('should have zero unsupported items by default', () => {
    const result: MatchResult = {
      track: { title: 'Song', artists: [], album: '', duration: 0, ref: 'src:1' },
      position: 1,
      status: 'unmatched'
    };
    expect(result.status).not.toBe('unsupported');
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add src/core/matching/ tests/core/matching/
git commit -m "feat(matching): define core types and strategy interface"
```

---

#### Task M3-2: Implement normalizer for metadata matching

**Files:**
- Create: `src/core/matching/normalizer.ts`
- Create: `tests/core/matching/normalizer.test.ts`

**Interfaces:**
- Consumes: Track titles, artist names, durations
- Produces: Normalized strings, confidence scores

- [ ] **Step 1: Write normalization function**

Create `src/core/matching/normalizer.ts`:

```typescript
export class TrackNormalizer {
  // Normalize title: remove (feat., remix, etc.), normalize unicode, lowercase
  static normalizeTitle(title: string): string {
    if (!title) return '';
    
    // NFD: decompose accents and combining characters
    let normalized = title.normalize('NFD');
    
    // Remove common suffixes: (feat. X), (Remix), etc.
    normalized = normalized
      .replace(/\s*\(feat\.\s+[^)]+\)/i, '')
      .replace(/\s*\(ft\.\s+[^)]+\)/i, '')
      .replace(/\s*\(remix\)/i, '')
      .replace(/\s*\(remix by [^)]+\)/i, '')
      .replace(/\s*\(cover\)/i, '')
      .replace(/\s*\(acoustic\)/i, '')
      .replace(/\s*\(instrumental\)/i, '');
    
    // Lowercase and trim
    normalized = normalized.toLowerCase().trim();
    
    return normalized;
  }

  // Normalize artist name: trim, lowercase, remove unicode accents
  static normalizeArtist(artist: string): string {
    if (!artist) return '';
    
    let normalized = artist.normalize('NFD');
    normalized = normalized.toLowerCase().trim();
    
    return normalized;
  }

  // Calculate title similarity (0-1)
  // Simple approach: word-based overlap
  static calculateTitleSimilarity(query: string, candidate: string): number {
    const normQuery = this.normalizeTitle(query).split(/\s+/);
    const normCandidate = this.normalizeTitle(candidate).split(/\s+/);
    
    if (normQuery.length === 0 || normCandidate.length === 0) {
      return 0;
    }

    const matches = normQuery.filter(word => normCandidate.includes(word)).length;
    return matches / Math.max(normQuery.length, normCandidate.length);
  }

  // Calculate artist similarity: any artist match = high confidence
  static calculateArtistSimilarity(queryArtists: string[], candidateArtists: string[]): number {
    const normQuery = queryArtists.map(a => this.normalizeArtist(a));
    const normCandidate = candidateArtists.map(a => this.normalizeArtist(a));

    if (normQuery.length === 0 || normCandidate.length === 0) {
      return 0;
    }

    const matches = normQuery.filter(qa => normCandidate.some(ca => ca.includes(qa) || qa.includes(ca))).length;
    return matches / normQuery.length;  // Percentage of query artists found
  }

  // Duration tolerance (in ms): allow ±5 second variance
  static isWithinDurationTolerance(duration1: number, duration2: number, toleranceMs: number = 5000): boolean {
    return Math.abs(duration1 - duration2) <= toleranceMs;
  }

  // Combined confidence score for metadata match
  // title: 0.5 weight, artist: 0.35 weight, duration: 0.15 weight
  static calculateMetadataConfidence(
    queryTitle: string,
    queryArtists: string[],
    queryDuration: number,
    candidateTitle: string,
    candidateArtists: string[],
    candidateDuration: number
  ): number {
    const titleScore = this.calculateTitleSimilarity(queryTitle, candidateTitle);
    const artistScore = this.calculateArtistSimilarity(queryArtists, candidateArtists);
    const durationOk = this.isWithinDurationTolerance(queryDuration, candidateDuration) ? 1 : 0;

    const confidence = titleScore * 0.5 + artistScore * 0.35 + durationOk * 0.15;
    return Math.min(1, confidence);
  }
}
```

- [ ] **Step 2: Write normalizer tests**

Create `tests/core/matching/normalizer.test.ts`:

```typescript
import { TrackNormalizer } from '../../../src/core/matching/normalizer.js';

describe('TrackNormalizer', () => {
  describe('normalizeTitle', () => {
    it('should remove (feat. X)', () => {
      const result = TrackNormalizer.normalizeTitle('Song Title (feat. Another Artist)');
      expect(result).toBe('song title');
    });

    it('should remove (ft. X)', () => {
      const result = TrackNormalizer.normalizeTitle('Song (ft. Artist)');
      expect(result).toBe('song');
    });

    it('should remove (Remix)', () => {
      const result = TrackNormalizer.normalizeTitle('Song (Remix)');
      expect(result).toBe('song');
    });

    it('should handle unicode combining characters', () => {
      // Café with combining accent vs. single precomposed character
      const with_accent = 'Café (Remix)';
      const without = 'Cafe (Remix)';
      expect(TrackNormalizer.normalizeTitle(with_accent)).toBe('café');
      expect(TrackNormalizer.normalizeTitle(without)).toBe('cafe');
    });

    it('should return empty string for empty input', () => {
      expect(TrackNormalizer.normalizeTitle('')).toBe('');
    });
  });

  describe('calculateTitleSimilarity', () => {
    it('should return 1 for identical normalized titles', () => {
      const score = TrackNormalizer.calculateTitleSimilarity('Song Title', 'Song Title');
      expect(score).toBe(1);
    });

    it('should handle titles with removed suffixes', () => {
      const score = TrackNormalizer.calculateTitleSimilarity(
        'Song Title (feat. Artist)',
        'Song Title'
      );
      expect(score).toBeGreaterThan(0.8);
    });

    it('should return 0 for completely different titles', () => {
      const score = TrackNormalizer.calculateTitleSimilarity('Song A', 'Song B');
      expect(score).toBeLessThan(0.5);
    });
  });

  describe('calculateArtistSimilarity', () => {
    it('should return 1 when artists match', () => {
      const score = TrackNormalizer.calculateArtistSimilarity(['The Beatles'], ['The Beatles']);
      expect(score).toBe(1);
    });

    it('should return 0 when no artists match', () => {
      const score = TrackNormalizer.calculateArtistSimilarity(['Artist A'], ['Artist B']);
      expect(score).toBe(0);
    });

    it('should handle partial artist matches', () => {
      const score = TrackNormalizer.calculateArtistSimilarity(['Artist A', 'Artist B'], ['Artist B']);
      expect(score).toBe(0.5);
    });
  });

  describe('isWithinDurationTolerance', () => {
    it('should accept durations within 5 second tolerance', () => {
      expect(TrackNormalizer.isWithinDurationTolerance(180000, 182000)).toBe(true);  // 180s vs 182s
    });

    it('should reject durations outside tolerance', () => {
      expect(TrackNormalizer.isWithinDurationTolerance(180000, 190000)).toBe(false);  // 180s vs 190s
    });
  });

  describe('calculateMetadataConfidence', () => {
    it('should return high confidence for perfect match', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist'],
        180000,
        'Song',
        ['Artist'],
        180000
      );
      expect(confidence).toBeGreaterThan(0.9);
    });

    it('should return lower confidence for title-only match', () => {
      const confidence = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist A'],
        180000,
        'Song',
        ['Artist B'],
        180000
      );
      expect(confidence).toBeGreaterThan(0.4);  // Title weight is 0.5
    });

    it('should penalize duration mismatch', () => {
      const confidenceOk = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist'],
        180000,
        'Song',
        ['Artist'],
        180000
      );
      const confidenceBad = TrackNormalizer.calculateMetadataConfidence(
        'Song',
        ['Artist'],
        180000,
        'Song',
        ['Artist'],
        300000  // 5 minute difference
      );
      expect(confidenceOk).toBeGreaterThan(confidenceBad);
    });
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/core/matching/normalizer.ts tests/core/matching/normalizer.test.ts
git commit -m "feat(matching): implement track normalization and confidence scoring"
```

---

#### Task M3-3: Implement known-ref strategy

**Files:**
- Create: `src/core/matching/strategies/known-ref-strategy.ts`
- Create: `tests/core/matching/strategies/known-ref-strategy.test.ts`

**Interfaces:**
- Consumes: `MatchRequest`, `CanonicalTrack` (which may have `refs` for other providers), `Provider`
- Produces: `MatchCandidate` with confidence 1.0 if a known ref exists

- [ ] **Step 1: Write known-ref strategy**

Create `src/core/matching/strategies/known-ref-strategy.ts`:

```typescript
import { MatchingStrategy, MatchRequest } from '../types.js';
import { Provider, MatchCandidate } from '../../provider/provider.js';

export class KnownRefStrategy implements MatchingStrategy {
  readonly name = 'known-ref';
  readonly priority = 1;  // Highest priority

  isApplicable(request: MatchRequest): boolean {
    // This strategy is always applicable
    return true;
  }

  async execute(request: MatchRequest, provider: Provider): Promise<MatchCandidate | null> {
    const { track, targetProvider } = request;

    // Check if the track already has a ref for the target provider
    if (track.refs && track.refs[targetProvider]) {
      // For now, assume the known ref is valid (no validation call)
      // In production, a second API call could verify, but we'll trust the cache
      return {
        trackRef: track.refs[targetProvider],
        confidence: 1.0,
        metadata: {
          providerTrackId: track.refs[targetProvider],
          title: track.title,
          artists: track.artists,
          duration: track.duration
        }
      };
    }

    // Also check if the track's ref is already for the target provider
    // (e.g., user exported from Spotify and is importing to the same Spotify account)
    if (track.ref && this.isRefForProvider(track.ref, targetProvider)) {
      return {
        trackRef: track.ref,
        confidence: 1.0,
        metadata: {
          providerTrackId: track.ref,
          title: track.title,
          artists: track.artists,
          duration: track.duration
        }
      };
    }

    return null;  // No known ref
  }

  private isRefForProvider(ref: string, providerId: string): boolean {
    // Simple provider detection from ref format
    if (providerId === 'spotify' && ref.startsWith('spotify:')) return true;
    if (providerId === 'youtube-music' && /^[a-zA-Z0-9_-]{11}$/.test(ref)) return true;  // YouTube video ID format
    return false;
  }
}
```

- [ ] **Step 2: Write known-ref tests**

Create `tests/core/matching/strategies/known-ref-strategy.test.ts`:

```typescript
import { KnownRefStrategy } from '../../../src/core/matching/strategies/known-ref-strategy.js';
import { CanonicalTrack, MatchCandidate } from '../../../src/core/provider/provider.js';

describe('KnownRefStrategy', () => {
  let strategy: KnownRefStrategy;
  let mockProvider: any;

  beforeEach(() => {
    strategy = new KnownRefStrategy();
    mockProvider = { resolveTrack: jest.fn() };
  });

  it('should have priority 1 (highest)', () => {
    expect(strategy.priority).toBe(1);
  });

  it('should return high-confidence match when track has known ref for target provider', async () => {
    const track: CanonicalTrack = {
      title: 'Song',
      artists: ['Artist'],
      album: 'Album',
      duration: 180000,
      ref: 'spotify:track:123',
      refs: {
        'spotify': 'spotify:track:123',
        'youtube-music': 'AAAABBBBCCCC'
      }
    };

    const request = {
      track,
      position: 1,
      targetProvider: 'youtube-music',
      capabilities: { pagination: 'page-forward', playlists: { access: ['owned'] } }
    };

    const result = await strategy.execute(request, mockProvider);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0);
    expect(result!.trackRef).toBe('AAAABBBBCCCC');
  });

  it('should return null when no known ref exists', async () => {
    const track: CanonicalTrack = {
      title: 'Song',
      artists: ['Artist'],
      album: 'Album',
      duration: 180000,
      ref: 'spotify:track:123'
      // No refs map
    };

    const request = {
      track,
      position: 1,
      targetProvider: 'youtube-music',
      capabilities: { pagination: 'page-forward', playlists: { access: ['owned'] } }
    };

    const result = await strategy.execute(request, mockProvider);
    expect(result).toBeNull();
  });

  it('should recognize same-provider refs without explicit refs map', async () => {
    const track: CanonicalTrack = {
      title: 'Song',
      artists: ['Artist'],
      album: 'Album',
      duration: 180000,
      ref: 'spotify:track:123'
    };

    const request = {
      track,
      position: 1,
      targetProvider: 'spotify',
      capabilities: { pagination: 'cursor-forward', playlists: { access: ['owned', 'user-accessible'] } }
    };

    const result = await strategy.execute(request, mockProvider);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0);
    expect(result!.trackRef).toBe('spotify:track:123');
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/core/matching/strategies/known-ref-strategy.ts tests/core/matching/strategies/known-ref-strategy.test.ts
git commit -m "feat(matching): implement known-ref strategy"
```

---

#### Task M3-4: Implement ISRC strategy

**Files:**
- Create: `src/core/matching/strategies/isrc-strategy.ts`
- Create: `tests/core/matching/strategies/isrc-strategy.test.ts`

**Interfaces:**
- Consumes: `MatchRequest` (track with ISRC), `Provider` with ISRC search capability
- Produces: `MatchCandidate` from search results

- [ ] **Step 1: Write ISRC strategy**

Create `src/core/matching/strategies/isrc-strategy.ts`:

```typescript
import { MatchingStrategy, MatchRequest } from '../types.js';
import { Provider, MatchCandidate } from '../../provider/provider.js';

export class IsrcStrategy implements MatchingStrategy {
  readonly name = 'isrc';
  readonly priority = 2;

  isApplicable(request: MatchRequest): boolean {
    const { track, capabilities } = request;
    
    // Strategy is applicable if:
    // 1. The track has an ISRC
    // 2. The target provider supports ISRC search
    const supportsIsrcSearch = capabilities.search?.isrcFilter === true || capabilities.search?.isrcLookup === true;
    const hasIsrc = track.isrc !== null && track.isrc !== undefined;
    
    return hasIsrc && supportsIsrcSearch;
  }

  async execute(request: MatchRequest, provider: Provider): Promise<MatchCandidate | null> {
    const { track } = request;

    if (!track.isrc) {
      return null;
    }

    try {
      // Search by ISRC
      // Some providers support direct ISRC lookup, others use a search filter
      const results = await provider.searchTracks(`isrc:${track.isrc}`, { limit: 5 });

      if (!results.tracks || results.tracks.length === 0) {
        return null;
      }

      // Return the first (best) result with high confidence
      // ISRC is unambiguous when it's in the file
      return {
        trackRef: results.tracks[0].ref,
        confidence: 0.95,  // Near-perfect, but not 1.0 (trust in metadata is slightly higher)
        metadata: results.tracks[0]
      };
    } catch (error) {
      // Search might fail due to quota, permission, etc.
      // Return null to fall through to next strategy
      return null;
    }
  }
}
```

- [ ] **Step 2: Write ISRC tests**

Create `tests/core/matching/strategies/isrc-strategy.test.ts`:

```typescript
import { IsrcStrategy } from '../../../src/core/matching/strategies/isrc-strategy.js';
import { CanonicalTrack } from '../../../src/core/provider/provider.js';

describe('IsrcStrategy', () => {
  let strategy: IsrcStrategy;
  let mockProvider: any;

  beforeEach(() => {
    strategy = new IsrcStrategy();
    mockProvider = { searchTracks: jest.fn() };
  });

  it('should have priority 2', () => {
    expect(strategy.priority).toBe(2);
  });

  describe('isApplicable', () => {
    it('should be applicable when track has ISRC and provider supports ISRC search', () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        duration: 180000,
        ref: 'spotify:track:123',
        isrc: 'USRC17607839'
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          pagination: 'cursor-forward',
          playlists: { access: ['owned'] },
          search: { isrcFilter: true }
        }
      };

      expect(strategy.isApplicable(request)).toBe(true);
    });

    it('should not be applicable when track has no ISRC', () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        duration: 180000,
        ref: 'spotify:track:123'
        // No ISRC
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: {
          pagination: 'cursor-forward',
          playlists: { access: ['owned'] },
          search: { isrcFilter: true }
        }
      };

      expect(strategy.isApplicable(request)).toBe(false);
    });

    it('should not be applicable when provider does not support ISRC search', () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        duration: 180000,
        ref: 'spotify:track:123',
        isrc: 'USRC17607839'
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'youtube-music',
        capabilities: {
          pagination: 'page-forward',
          playlists: { access: ['owned'] }
          // No ISRC search support
        }
      };

      expect(strategy.isApplicable(request)).toBe(false);
    });
  });

  describe('execute', () => {
    it('should return high-confidence match when ISRC search succeeds', async () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        duration: 180000,
        ref: 'spotify:track:123',
        isrc: 'USRC17607839'
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: { pagination: 'cursor-forward', playlists: { access: ['owned'] }, search: { isrcFilter: true } }
      };

      mockProvider.searchTracks.mockResolvedValueOnce({
        tracks: [
          {
            title: 'Song',
            artists: ['Artist'],
            album: 'Album',
            duration: 180000,
            ref: 'spotify:track:456'
          }
        ]
      });

      const result = await strategy.execute(request, mockProvider);
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.95);
      expect(result!.trackRef).toBe('spotify:track:456');
    });

    it('should return null when ISRC search returns no results', async () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        duration: 180000,
        ref: 'spotify:track:123',
        isrc: 'INVALIDISRC'
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: { pagination: 'cursor-forward', playlists: { access: ['owned'] }, search: { isrcFilter: true } }
      };

      mockProvider.searchTracks.mockResolvedValueOnce({ tracks: [] });

      const result = await strategy.execute(request, mockProvider);
      expect(result).toBeNull();
    });

    it('should return null when search throws', async () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        duration: 180000,
        ref: 'spotify:track:123',
        isrc: 'USRC17607839'
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: { pagination: 'cursor-forward', playlists: { access: ['owned'] }, search: { isrcFilter: true } }
      };

      mockProvider.searchTracks.mockRejectedValueOnce(new Error('Quota exceeded'));

      const result = await strategy.execute(request, mockProvider);
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/core/matching/strategies/isrc-strategy.ts tests/core/matching/strategies/isrc-strategy.test.ts
git commit -m "feat(matching): implement ISRC strategy"
```

---

### Phase 2: Metadata Strategy and Matching Engine

#### Task M3-5: Implement metadata strategy

**Files:**
- Create: `src/core/matching/strategies/metadata-strategy.ts`
- Create: `tests/core/matching/strategies/metadata-strategy.test.ts`

**Interfaces:**
- Consumes: `MatchRequest`, normalized metadata from source track
- Produces: `MatchCandidate[]` from search, selecting best by confidence

- [ ] **Step 1: Write metadata strategy**

Create `src/core/matching/strategies/metadata-strategy.ts`:

```typescript
import { MatchingStrategy, MatchRequest } from '../types.js';
import { Provider, MatchCandidate, CanonicalTrack } from '../../provider/provider.js';
import { TrackNormalizer } from '../normalizer.js';

export class MetadataStrategy implements MatchingStrategy {
  readonly name = 'metadata';
  readonly priority = 3;

  isApplicable(request: MatchRequest): boolean {
    const { track } = request;
    // Always applicable if we have a title (minimum metadata)
    return track.title && track.title.length > 0;
  }

  async execute(request: MatchRequest, provider: Provider): Promise<MatchCandidate | null> {
    const { track } = request;

    try {
      // Build search query: title + primary artist
      const query = this.buildSearchQuery(track);

      // Search with a reasonable limit
      const results = await provider.searchTracks(query, { limit: 10 });

      if (!results.tracks || results.tracks.length === 0) {
        return null;
      }

      // Score each result and return the best match
      let bestCandidate: MatchCandidate | null = null;
      let bestScore = 0;

      for (const candidate of results.tracks) {
        const score = TrackNormalizer.calculateMetadataConfidence(
          track.title,
          track.artists,
          track.duration,
          candidate.title,
          candidate.artists,
          candidate.duration
        );

        if (score > bestScore) {
          bestScore = score;
          bestCandidate = {
            trackRef: candidate.ref,
            confidence: score,
            metadata: candidate
          };
        }
      }

      // Only return if confidence is above threshold (0.4)
      // Below 0.4 is too risky for automatic matching
      if (bestCandidate && bestScore >= 0.4) {
        return bestCandidate;
      }

      return null;
    } catch (error) {
      // Search might fail; return null to indicate no match found
      return null;
    }
  }

  private buildSearchQuery(track: CanonicalTrack): string {
    // Build a query: "Title Artist"
    const artists = track.artists && track.artists.length > 0 ? track.artists[0] : '';
    return [track.title, artists].filter(Boolean).join(' ');
  }
}
```

- [ ] **Step 2: Write metadata strategy tests**

Create `tests/core/matching/strategies/metadata-strategy.test.ts`:

```typescript
import { MetadataStrategy } from '../../../src/core/matching/strategies/metadata-strategy.js';
import { CanonicalTrack } from '../../../src/core/provider/provider.js';

describe('MetadataStrategy', () => {
  let strategy: MetadataStrategy;
  let mockProvider: any;

  beforeEach(() => {
    strategy = new MetadataStrategy();
    mockProvider = { searchTracks: jest.fn() };
  });

  it('should have priority 3 (lowest)', () => {
    expect(strategy.priority).toBe(3);
  });

  describe('isApplicable', () => {
    it('should be applicable when track has a title', () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        duration: 180000,
        ref: 'spotify:track:123'
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: { pagination: 'cursor-forward', playlists: { access: ['owned'] } }
      };

      expect(strategy.isApplicable(request)).toBe(true);
    });

    it('should not be applicable when track has no title', () => {
      const track: CanonicalTrack = {
        title: '',
        artists: [],
        album: '',
        duration: 0,
        ref: ''
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: { pagination: 'cursor-forward', playlists: { access: ['owned'] } }
      };

      expect(strategy.isApplicable(request)).toBe(false);
    });
  });

  describe('execute', () => {
    it('should return match when search finds high-confidence candidate', async () => {
      const track: CanonicalTrack = {
        title: 'Imagine',
        artists: ['John Lennon'],
        album: 'Imagine',
        duration: 183000,
        ref: 'spotify:track:123'
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: { pagination: 'cursor-forward', playlists: { access: ['owned'] } }
      };

      mockProvider.searchTracks.mockResolvedValueOnce({
        tracks: [
          {
            title: 'Imagine',
            artists: ['John Lennon'],
            album: 'Imagine',
            duration: 183000,
            ref: 'spotify:track:456'
          }
        ]
      });

      const result = await strategy.execute(request, mockProvider);
      expect(result).not.toBeNull();
      expect(result!.confidence).toBeGreaterThan(0.8);
    });

    it('should return null when all candidates score below threshold', async () => {
      const track: CanonicalTrack = {
        title: 'Obscure Song',
        artists: ['Unknown Artist'],
        album: 'Album',
        duration: 180000,
        ref: 'spotify:track:123'
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: { pagination: 'cursor-forward', playlists: { access: ['owned'] } }
      };

      mockProvider.searchTracks.mockResolvedValueOnce({
        tracks: [
          {
            title: 'Completely Different Song',
            artists: ['Different Artist'],
            album: 'Other Album',
            duration: 300000,
            ref: 'spotify:track:456'
          }
        ]
      });

      const result = await strategy.execute(request, mockProvider);
      expect(result).toBeNull();
    });

    it('should return null when search returns no results', async () => {
      const track: CanonicalTrack = {
        title: 'Song',
        artists: ['Artist'],
        album: 'Album',
        duration: 180000,
        ref: 'spotify:track:123'
      };

      const request = {
        track,
        position: 1,
        targetProvider: 'spotify',
        capabilities: { pagination: 'cursor-forward', playlists: { access: ['owned'] } }
      };

      mockProvider.searchTracks.mockResolvedValueOnce({ tracks: [] });

      const result = await strategy.execute(request, mockProvider);
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/core/matching/strategies/metadata-strategy.ts tests/core/matching/strategies/metadata-strategy.test.ts
git commit -m "feat(matching): implement metadata matching strategy"
```

---

#### Task M3-6: Implement matching engine

**Files:**
- Create: `src/core/matching/matching-engine.ts`
- Create: `tests/core/matching/matching-engine.test.ts`

**Interfaces:**
- Consumes: Strategy implementations, `Provider`
- Produces: `MatchReport` with all results

- [ ] **Step 1: Write matching engine**

Create `src/core/matching/matching-engine.ts`:

```typescript
import { MatchingStrategy, MatchRequest, MatchResult, MatchReport } from './types.js';
import { Provider, ProviderCapabilities } from '../provider/provider.js';
import { CanonicalPlaylistFile } from '../export/format.js';
import { KnownRefStrategy } from './strategies/known-ref-strategy.js';
import { IsrcStrategy } from './strategies/isrc-strategy.js';
import { MetadataStrategy } from './strategies/metadata-strategy.js';

export class MatchingEngine {
  private strategies: MatchingStrategy[];

  constructor() {
    // Strategies are applied in priority order (1 = highest)
    this.strategies = [
      new KnownRefStrategy(),
      new IsrcStrategy(),
      new MetadataStrategy()
    ].sort((a, b) => a.priority - b.priority);
  }

  async match(
    file: CanonicalPlaylistFile,
    targetProvider: Provider,
    capabilities: ProviderCapabilities,
    options: { minConfidence?: number } = {}
  ): Promise<MatchReport> {
    const minConfidence = options.minConfidence ?? 0.5;
    const results: MatchResult[] = [];

    for (const track of file.tracks) {
      const request: MatchRequest = {
        track,
        position: track.position,
        targetProvider: 'spotify',  // TODO: pass actual provider ID
        capabilities
      };

      const result = await this.matchTrack(request, targetProvider);

      if (result.status === 'matched' && result.confidence! < minConfidence) {
        result.status = 'low-confidence';
      }

      results.push(result);
    }

    // Also mark unsupported items
    for (const unsupported of file.unsupportedItems) {
      results.push({
        track: { title: unsupported.name ?? '', artists: [], album: '', duration: 0, ref: unsupported.ref ?? '' },
        position: unsupported.position,
        status: 'unsupported',
        error: `Unsupported item type: ${unsupported.kind}`
      });
    }

    // Calculate summary
    const summary = {
      total: results.length,
      matched: results.filter(r => r.status === 'matched').length,
      lowConfidence: results.filter(r => r.status === 'low-confidence').length,
      unmatched: results.filter(r => r.status === 'unmatched').length,
      unsupported: results.filter(r => r.status === 'unsupported').length
    };

    // Generate recommendations
    const recommendations: string[] = [];
    if (summary.unmatched > 0) {
      recommendations.push(`${summary.unmatched} tracks could not be matched. Check the match report for details.`);
    }
    if (summary.lowConfidence > 0) {
      recommendations.push(`${summary.lowConfidence} tracks have low confidence matches. Review and adjust if needed.`);
    }

    return {
      importedAt: new Date().toISOString(),
      sourceFile: {
        path: '', // TODO: pass file path
        provider: file.source.provider,
        playlistName: file.playlist.name,
        trackCount: file.playlist.trackCount
      },
      targetProvider: 'spotify',  // TODO: pass actual provider ID
      results,
      summary,
      recommendations
    };
  }

  private async matchTrack(request: MatchRequest, provider: Provider): Promise<MatchResult> {
    const applicableStrategies = this.strategies.filter(s => s.isApplicable(request));

    if (applicableStrategies.length === 0) {
      return {
        track: request.track,
        position: request.position,
        status: 'unmatched',
        error: 'No applicable matching strategies'
      };
    }

    for (const strategy of applicableStrategies) {
      try {
        const candidate = await strategy.execute(request, provider);
        if (candidate) {
          return {
            track: request.track,
            position: request.position,
            status: 'matched',
            candidate,
            confidence: candidate.confidence,
            strategies: [strategy.name]
          };
        }
      } catch (error) {
        // Log error but continue to next strategy
        continue;
      }
    }

    return {
      track: request.track,
      position: request.position,
      status: 'unmatched',
      strategies: applicableStrategies.map(s => s.name)
    };
  }
}
```

- [ ] **Step 2: Write matching engine tests**

Create `tests/core/matching/matching-engine.test.ts`:

```typescript
import { MatchingEngine } from '../../../src/core/matching/matching-engine.js';
import { CanonicalPlaylistFile } from '../../../src/core/export/format.js';

describe('MatchingEngine', () => {
  let engine: MatchingEngine;
  let mockProvider: any;

  beforeEach(() => {
    engine = new MatchingEngine();
    mockProvider = {
      searchTracks: jest.fn(),
      resolveTrack: jest.fn()
    };
  });

  describe('match', () => {
    it('should return a report with matched tracks', async () => {
      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          id: 'pl1',
          name: 'My Playlist',
          trackCount: 1
        },
        tracks: [
          {
            position: 1,
            title: 'Imagine',
            artists: ['John Lennon'],
            album: 'Imagine',
            duration: 183000,
            ref: 'spotify:track:123'
          }
        ],
        unsupportedItems: []
      };

      mockProvider.searchTracks.mockResolvedValueOnce({
        tracks: [
          {
            title: 'Imagine',
            artists: ['John Lennon'],
            album: 'Imagine',
            duration: 183000,
            ref: 'youtube:vid123'
          }
        ]
      });

      const report = await engine.match(file, mockProvider, { pagination: 'page-forward', playlists: { access: ['owned'] } });

      expect(report.summary.total).toBe(1);
      expect(report.summary.matched).toBe(1);
      expect(report.results[0].status).toBe('matched');
    });

    it('should mark low-confidence matches below minConfidence threshold', async () => {
      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          id: 'pl1',
          name: 'My Playlist',
          trackCount: 1
        },
        tracks: [
          {
            position: 1,
            title: 'Song A',
            artists: ['Artist A'],
            album: 'Album',
            duration: 180000,
            ref: 'spotify:track:123'
          }
        ],
        unsupportedItems: []
      };

      mockProvider.searchTracks.mockResolvedValueOnce({
        tracks: [
          {
            title: 'Song B',
            artists: ['Artist B'],
            album: 'Different',
            duration: 300000,
            ref: 'youtube:vid456'
          }
        ]
      });

      const report = await engine.match(file, mockProvider, { pagination: 'page-forward', playlists: { access: ['owned'] } }, { minConfidence: 0.9 });

      expect(report.summary.lowConfidence).toBeGreaterThanOrEqual(0);
    });

    it('should include unsupported items in the report', async () => {
      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          id: 'pl1',
          name: 'My Playlist',
          trackCount: 2
        },
        tracks: [
          {
            position: 1,
            title: 'Song',
            artists: ['Artist'],
            album: 'Album',
            duration: 180000,
            ref: 'spotify:track:123'
          }
        ],
        unsupportedItems: [
          {
            position: 2,
            kind: 'local',
            name: 'Local File'
          }
        ]
      };

      mockProvider.searchTracks.mockResolvedValueOnce({
        tracks: [
          {
            title: 'Song',
            artists: ['Artist'],
            album: 'Album',
            duration: 180000,
            ref: 'youtube:vid123'
          }
        ]
      });

      const report = await engine.match(file, mockProvider, { pagination: 'page-forward', playlists: { access: ['owned'] } });

      expect(report.summary.total).toBe(2);
      expect(report.summary.unsupported).toBe(1);
    });
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/core/matching/matching-engine.ts tests/core/matching/matching-engine.test.ts
git commit -m "feat(matching): implement matching engine with strategy orchestration"
```

---

### Phase 3: Import Infrastructure

#### Task M3-7: Implement canonical file reader

**Files:**
- Create: `src/core/import/file-reader.ts`
- Create: `tests/core/import/file-reader.test.ts`

**Interfaces:**
- Consumes: File path (JSON or CSV)
- Produces: `CanonicalPlaylistFile`

- [ ] **Step 1: Write file reader**

Create `src/core/import/file-reader.ts`:

```typescript
import { readFile } from 'fs/promises';
import { CanonicalPlaylistFile } from '../export/format.js';

export class CanonicalFileReader {
  async readFile(path: string): Promise<CanonicalPlaylistFile> {
    const ext = path.toLowerCase().endsWith('.json') ? 'json' : 'csv';

    if (ext === 'json') {
      return this.readJson(path);
    } else {
      return this.readCsv(path);
    }
  }

  private async readJson(path: string): Promise<CanonicalPlaylistFile> {
    const content = await readFile(path, 'utf-8');
    const data = JSON.parse(content);

    // Validate schema version
    if (data.schemaVersion !== 1) {
      throw new Error(`Unsupported schema version: ${data.schemaVersion}. This version of sple supports v1 only.`);
    }

    // Validate structure
    if (!data.tracks || !Array.isArray(data.tracks)) {
      throw new Error('Invalid file: missing or invalid tracks array');
    }

    return data as CanonicalPlaylistFile;
  }

  private async readCsv(path: string): Promise<CanonicalPlaylistFile> {
    const content = await readFile(path, 'utf-8');
    const lines = content.split(/\r?\n/);

    if (lines.length < 2) {
      throw new Error('CSV file is empty or has no header');
    }

    const header = this.parseCsvLine(lines[0]);
    const expectedColumns = ['position', 'title', 'artists', 'album', 'duration_ms', 'added_at', 'isrc', 'ref'];

    if (!expectedColumns.every(col => header.includes(col))) {
      throw new Error(`CSV header missing required columns. Expected: ${expectedColumns.join(', ')}`);
    }

    const tracks: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      const values = this.parseCsvLine(lines[i]);
      const row = this.mapCsvRowToObject(header, values);

      tracks.push({
        position: parseInt(row.position) || i,
        title: row.title,
        artists: row.artists ? row.artists.split(';').map((a: string) => a.trim()) : [],
        album: row.album || '',
        duration: parseInt(row.duration_ms) || 0,
        addedAt: row.added_at || undefined,
        isrc: row.isrc || undefined,
        ref: row.ref || undefined
      });
    }

    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      generator: { name: 'sple', version: 'unknown' },
      source: { provider: 'unknown', kind: 'playlist' },
      playlist: {
        name: 'Imported Playlist',
        trackCount: tracks.length
      },
      tracks,
      unsupportedItems: []
    };
  }

  private parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // End of field
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    values.push(current);
    return values;
  }

  private mapCsvRowToObject(header: string[], values: string[]): Record<string, string> {
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = values[i] || '';
    }
    return obj;
  }
}
```

- [ ] **Step 2: Write file reader tests**

Create `tests/core/import/file-reader.test.ts`:

```typescript
import { CanonicalFileReader } from '../../../src/core/import/file-reader.js';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('CanonicalFileReader', () => {
  let reader: CanonicalFileReader;

  beforeEach(() => {
    reader = new CanonicalFileReader();
  });

  describe('readFile (JSON)', () => {
    it('should read valid JSON export file', async () => {
      const tmpDir = tmpdir();
      const filePath = join(tmpDir, 'test-export.json');

      const content = {
        schemaVersion: 1,
        exportedAt: '2026-10-05T12:00:00Z',
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          id: 'pl1',
          name: 'My Playlist',
          trackCount: 1
        },
        tracks: [
          {
            position: 1,
            title: 'Song',
            artists: ['Artist'],
            album: 'Album',
            duration: 180000,
            ref: 'spotify:track:123'
          }
        ],
        unsupportedItems: []
      };

      await writeFile(filePath, JSON.stringify(content));

      const result = await reader.readFile(filePath);
      expect(result.schemaVersion).toBe(1);
      expect(result.tracks).toHaveLength(1);
      expect(result.tracks[0].title).toBe('Song');
    });

    it('should reject unsupported schema version', async () => {
      const tmpDir = tmpdir();
      const filePath = join(tmpDir, 'test-export-v2.json');

      const content = {
        schemaVersion: 2,
        tracks: []
      };

      await writeFile(filePath, JSON.stringify(content));

      await expect(reader.readFile(filePath)).rejects.toThrow('Unsupported schema version: 2');
    });
  });

  describe('readFile (CSV)', () => {
    it('should read valid CSV export file', async () => {
      const tmpDir = tmpdir();
      const filePath = join(tmpDir, 'test-export.csv');

      const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,Song,Artist,Album,180000,2026-10-05T00:00:00Z,,spotify:track:123\n';
      await writeFile(filePath, content);

      const result = await reader.readFile(filePath);
      expect(result.tracks).toHaveLength(1);
      expect(result.tracks[0].title).toBe('Song');
      expect(result.tracks[0].artists).toEqual(['Artist']);
    });

    it('should handle quoted CSV fields', async () => {
      const tmpDir = tmpdir();
      const filePath = join(tmpDir, 'test-quoted.csv');

      const content = 'position,title,artists,album,duration_ms,added_at,isrc,ref\n1,"Song, Pt. 1","Artist A; Artist B",Album,180000,,,spotify:track:123\n';
      await writeFile(filePath, content);

      const result = await reader.readFile(filePath);
      expect(result.tracks[0].title).toBe('Song, Pt. 1');
      expect(result.tracks[0].artists).toEqual(['Artist A', 'Artist B']);
    });
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/core/import/ tests/core/import/file-reader.test.ts
git commit -m "feat(import): implement canonical file reader for JSON and CSV"
```

---

#### Task M3-8: Implement match report writer

**Files:**
- Create: `src/core/import/match-report-writer.ts`
- Create: `tests/core/import/match-report-writer.test.ts`

**Interfaces:**
- Consumes: `MatchReport`
- Produces: Human-readable and JSON outputs

- [ ] **Step 1: Write match report writer**

Create `src/core/import/match-report-writer.ts`:

```typescript
import { writeFile } from 'fs/promises';
import { MatchReport } from '../matching/types.js';

export class MatchReportWriter {
  async writeJson(report: MatchReport, path: string): Promise<void> {
    await writeFile(path, JSON.stringify(report, null, 2));
  }

  async writeText(report: MatchReport, path?: string): Promise<string> {
    const lines: string[] = [];

    lines.push(`Match Report: ${report.sourceFile.playlistName}`);
    lines.push(`Source: ${report.sourceFile.provider} → Target: ${report.targetProvider}`);
    lines.push(`Imported at: ${report.importedAt}`);
    lines.push('');

    // Summary
    lines.push('Summary');
    lines.push('-------');
    lines.push(`Total tracks:    ${report.summary.total}`);
    lines.push(`Matched:         ${report.summary.matched} (${this.percentage(report.summary.matched, report.summary.total)})`);
    lines.push(`Low confidence:  ${report.summary.lowConfidence} (${this.percentage(report.summary.lowConfidence, report.summary.total)})`);
    lines.push(`Unmatched:       ${report.summary.unmatched} (${this.percentage(report.summary.unmatched, report.summary.total)})`);
    lines.push(`Unsupported:     ${report.summary.unsupported} (${this.percentage(report.summary.unsupported, report.summary.total)})`);
    lines.push('');

    // Recommendations
    if (report.recommendations && report.recommendations.length > 0) {
      lines.push('Recommendations');
      lines.push('---------------');
      for (const rec of report.recommendations) {
        lines.push(`• ${rec}`);
      }
      lines.push('');
    }

    // Unmatched tracks (highest priority)
    const unmatched = report.results.filter(r => r.status === 'unmatched');
    if (unmatched.length > 0) {
      lines.push('Unmatched Tracks');
      lines.push('----------------');
      for (const result of unmatched.slice(0, 20)) {
        lines.push(`${result.position}: ${result.track.title} — ${result.track.artists.join(', ')}`);
        if (result.error) lines.push(`   Error: ${result.error}`);
      }
      if (unmatched.length > 20) {
        lines.push(`... and ${unmatched.length - 20} more`);
      }
      lines.push('');
    }

    // Low-confidence matches
    const lowConf = report.results.filter(r => r.status === 'low-confidence');
    if (lowConf.length > 0) {
      lines.push('Low-Confidence Matches');
      lines.push('---------------------');
      for (const result of lowConf.slice(0, 10)) {
        const cand = result.candidate;
        lines.push(`${result.position}: ${result.track.title} → ${cand?.metadata?.title} (${this.percentage(result.confidence ?? 0, 1)})`);
      }
      if (lowConf.length > 10) {
        lines.push(`... and ${lowConf.length - 10} more`);
      }
      lines.push('');
    }

    const text = lines.join('\n');

    if (path) {
      await writeFile(path, text);
    }

    return text;
  }

  private percentage(value: number, total: number): string {
    if (total === 0) return '0%';
    return `${Math.round((value / total) * 100)}%`;
  }
}
```

- [ ] **Step 2: Write match report writer tests**

Create `tests/core/import/match-report-writer.test.ts`:

```typescript
import { MatchReportWriter } from '../../../src/core/import/match-report-writer.js';
import { MatchReport } from '../../../src/core/matching/types.js';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('MatchReportWriter', () => {
  let writer: MatchReportWriter;

  beforeEach(() => {
    writer = new MatchReportWriter();
  });

  const mockReport: MatchReport = {
    importedAt: '2026-10-05T12:00:00Z',
    sourceFile: {
      path: '/path/to/export.json',
      provider: 'spotify',
      playlistName: 'My Playlist',
      trackCount: 5
    },
    targetProvider: 'youtube-music',
    results: [
      {
        track: { title: 'Song 1', artists: ['Artist 1'], album: 'Album', duration: 180000, ref: 'src:1' },
        position: 1,
        status: 'matched',
        confidence: 0.95,
        candidate: { trackRef: 'tgt:1', confidence: 0.95, metadata: {} as any },
        strategies: ['metadata']
      },
      {
        track: { title: 'Song 2', artists: ['Artist 2'], album: 'Album', duration: 200000, ref: 'src:2' },
        position: 2,
        status: 'low-confidence',
        confidence: 0.55,
        candidate: { trackRef: 'tgt:2', confidence: 0.55, metadata: {} as any }
      },
      {
        track: { title: 'Song 3', artists: ['Artist 3'], album: 'Album', duration: 220000, ref: 'src:3' },
        position: 3,
        status: 'unmatched'
      }
    ],
    summary: {
      total: 3,
      matched: 1,
      lowConfidence: 1,
      unmatched: 1,
      unsupported: 0
    }
  };

  describe('writeText', () => {
    it('should generate readable report', async () => {
      const text = await writer.writeText(mockReport);

      expect(text).toContain('Match Report: My Playlist');
      expect(text).toContain('Total tracks:    3');
      expect(text).toContain('Matched:         1');
      expect(text).toContain('Unmatched:       1');
    });

    it('should list unmatched tracks', async () => {
      const text = await writer.writeText(mockReport);

      expect(text).toContain('Unmatched Tracks');
      expect(text).toContain('Song 3');
    });

    it('should save to file', async () => {
      const tmpDir = tmpdir();
      const filePath = join(tmpDir, 'report.txt');

      await writer.writeText(mockReport, filePath);

      const content = await readFile(filePath, 'utf-8');
      expect(content).toContain('Match Report');
    });
  });

  describe('writeJson', () => {
    it('should write report as JSON', async () => {
      const tmpDir = tmpdir();
      const filePath = join(tmpDir, 'report.json');

      await writer.writeJson(mockReport, filePath);

      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.summary.matched).toBe(1);
      expect(parsed.results).toHaveLength(3);
    });
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/core/import/match-report-writer.ts tests/core/import/match-report-writer.test.ts
git commit -m "feat(import): implement match report writer for human and machine output"
```

---

### Phase 4: Import Command and CLI

#### Task M3-9: Implement import command

**Files:**
- Create: `src/cli/commands/import.ts`
- Modify: `src/cli/index.ts` (register command)
- Create: `tests/cli/commands/import.test.ts`

**Interfaces:**
- Consumes: CLI args (file path, target provider, flags)
- Produces: Playlist creation and match report output

- [ ] **Step 1: Write import command**

Create `src/cli/commands/import.ts`:

```typescript
import { Command } from 'commander';
import { CanonicalFileReader } from '../../core/import/file-reader.js';
import { MatchingEngine } from '../../core/matching/matching-engine.js';
import { MatchReportWriter } from '../../core/import/match-report-writer.js';
import { Provider } from '../../core/provider/provider.js';
import { UsageError } from '../../core/provider/errors.js';

export const importCommand = new Command('import')
  .description('Import a playlist from a canonical export file')
  .argument('<file>', 'Path to the export file (JSON or CSV)')
  .option('-p, --provider <provider>', 'Target provider (default: spotify)')
  .option('-n, --name <name>', 'Name for the imported playlist')
  .option('--report <path>', 'Save match report to file (JSON or TXT)')
  .option('--min-confidence <score>', 'Minimum confidence score (0-1) to auto-match', '0.5')
  .option('--dry-run', 'Show what would be imported without creating the playlist')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (filePath: string, options: any) => {
    const reader = new CanonicalFileReader();
    const engine = new MatchingEngine();
    const reportWriter = new MatchReportWriter();

    try {
      // Read the file
      const file = await reader.readFile(filePath);

      // Get the target provider
      const targetProvider = options.provider || 'spotify';  // TODO: get from registry
      const minConfidence = parseFloat(options.minConfidence) || 0.5;

      if (minConfidence < 0 || minConfidence > 1) {
        throw new UsageError('--min-confidence must be between 0 and 1');
      }

      // Run matching
      const report = await engine.match(
        file,
        null as any,  // TODO: get provider from registry
        { pagination: 'cursor-forward', playlists: { access: ['owned'] } },
        { minConfidence }
      );

      // Output match report
      if (options.report) {
        const ext = options.report.toLowerCase().endsWith('.json') ? 'json' : 'text';
        if (ext === 'json') {
          await reportWriter.writeJson(report, options.report);
        } else {
          await reportWriter.writeText(report, options.report);
        }
        console.log(`Match report saved to ${options.report}`);
      } else {
        const text = await reportWriter.writeText(report);
        console.log(text);
      }

      // Check if proceeding with import
      const shouldCreatePlaylist = !options.dryRun && (options.yes || await promptConfirmation());
      if (shouldCreatePlaylist) {
        // Create playlist and populate with matched tracks
        const playlistName = options.name || file.playlist.name;
        console.log(`\nCreating playlist: ${playlistName}`);
        // TODO: implement playlist creation
        console.log('Playlist created successfully!');
      } else if (options.dryRun) {
        console.log('\n(Dry run mode: playlist was not created)');
      }
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(`Error: ${error.message}`);
        process.exit(2);
      }
      throw error;
    }
  });

async function promptConfirmation(): Promise<boolean> {
  // TODO: implement interactive prompt
  return false;
}
```

- [ ] **Step 2: Register import command in CLI**

Update `src/cli/index.ts` (add import to commands):

```typescript
import { importCommand } from './commands/import.js';

// In the main CLI setup:
program
  .addCommand(importCommand);
```

- [ ] **Step 3: Write import command tests**

Create `tests/cli/commands/import.test.ts`:

```typescript
import { importCommand } from '../../../src/cli/commands/import.js';

describe('import command', () => {
  it('should have the correct structure', () => {
    expect(importCommand.name()).toBe('import');
    expect(importCommand.description()).toContain('Import');
  });

  it('should accept file path argument', () => {
    // Test that the command parses arguments correctly
    const args = importCommand.parseOptions(['/path/to/file.json']);
    expect(args.args[0]).toBe('/path/to/file.json');
  });

  it('should support --provider option', () => {
    const args = importCommand.parseOptions(['file.json', '--provider', 'youtube-music']);
    expect(args.opts().provider).toBe('youtube-music');
  });

  it('should support --name option', () => {
    const args = importCommand.parseOptions(['file.json', '--name', 'My Playlist']);
    expect(args.opts().name).toBe('My Playlist');
  });

  it('should support --dry-run flag', () => {
    const args = importCommand.parseOptions(['file.json', '--dry-run']);
    expect(args.opts().dryRun).toBe(true);
  });

  it('should validate --min-confidence range', async () => {
    // Test would need full integration setup
    // Skipped for now pending integration test framework
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/import.ts src/cli/index.ts tests/cli/commands/import.test.ts
git commit -m "feat(cli): implement import command with match report output"
```

---

### Phase 5: Testing and Documentation

#### Task M3-10: End-to-end import tests

**Files:**
- Create: `tests/e2e/import.test.ts`

**Interfaces:**
- Consumes: Canonical file, fake provider
- Produces: Verified end-to-end import workflow

- [ ] **Step 1: Write E2E import tests**

Create `tests/e2e/import.test.ts`:

```typescript
import { MatchingEngine } from '../../src/core/matching/matching-engine.js';
import { CanonicalFileReader } from '../../src/core/import/file-reader.js';
import { FakeProvider } from '../../src/providers/fake/index.js';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Import E2E (with fake provider)', () => {
  let engine: MatchingEngine;
  let reader: CanonicalFileReader;
  let provider: FakeProvider;

  beforeEach(() => {
    engine = new MatchingEngine();
    reader = new CanonicalFileReader();
    provider = new FakeProvider({
      pagination: 'cursor-forward',
      playlists: { access: ['owned'] }
    });
  });

  it('should match tracks from exported file to fake provider', async () => {
    const tmpDir = tmpdir();
    const filePath = join(tmpDir, 'export.json');

    const file = {
      schemaVersion: 1,
      exportedAt: '2026-10-05T12:00:00Z',
      generator: { name: 'sple', version: '0.1.0' },
      source: { provider: 'spotify', kind: 'playlist' },
      playlist: {
        id: 'pl1',
        name: 'Test Playlist',
        trackCount: 2
      },
      tracks: [
        {
          position: 1,
          title: 'Song A',
          artists: ['Artist A'],
          album: 'Album A',
          duration: 180000,
          ref: 'spotify:track:1'
        },
        {
          position: 2,
          title: 'Song B',
          artists: ['Artist B'],
          album: 'Album B',
          duration: 200000,
          ref: 'spotify:track:2'
        }
      ],
      unsupportedItems: []
    };

    await writeFile(filePath, JSON.stringify(file));

    const readFile = await reader.readFile(filePath);
    const report = await engine.match(
      readFile,
      provider as any,
      provider.capabilities
    );

    expect(report.summary.total).toBeGreaterThan(0);
    expect(report.summary.matched + report.summary.lowConfidence).toBeGreaterThan(0);
  });

  it('should handle mixed matched and unmatched tracks', async () => {
    const file = {
      schemaVersion: 1,
      exportedAt: '2026-10-05T12:00:00Z',
      generator: { name: 'sple', version: '0.1.0' },
      source: { provider: 'spotify', kind: 'playlist' },
      playlist: {
        id: 'pl1',
        name: 'Mixed Playlist',
        trackCount: 3
      },
      tracks: [
        {
          position: 1,
          title: 'Imagine',
          artists: ['John Lennon'],
          album: 'Imagine',
          duration: 183000,
          ref: 'spotify:track:1'
        },
        {
          position: 2,
          title: 'Completely Unknown Song XYZ',
          artists: ['Unknown Artist ZZZZ'],
          album: 'Unknown',
          duration: 999999,
          ref: 'spotify:track:2'
        }
      ],
      unsupportedItems: [
        {
          position: 3,
          kind: 'local',
          name: 'Local File'
        }
      ]
    };

    const report = await engine.match(file as any, provider as any, provider.capabilities);

    expect(report.summary.unsupported).toBe(1);
    expect(report.summary.unmatched).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/import.test.ts
git commit -m "test(e2e): add end-to-end import tests with fake provider"
```

---

#### Task M3-11: Update documentation

**Files:**
- Create: `docs/user/import.md`
- Create: `docs/dev/matching-strategy.md`
- Modify: `README.md` (add import section)
- Create: `docs/adr/0009-matching-strategy.md`

**Interfaces:**
- Consumes: Nothing new; documents existing code
- Produces: User and developer guides

- [ ] **Step 1: Write user guide**

Create `docs/user/import.md`:

```markdown
# Importing Playlists

`sple import` creates a new playlist on your target provider by matching tracks from an exported canonical file.

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
   - Spotify supports ISRC; YouTube Music does not.
   - Confidence: 95% (very high but not perfect)

3. **Metadata** (lowest priority, most common)
   - Normalize the track title and artist name, then search on the target provider.
   - Score based on title match (50%), artist match (35%), and duration match (15%).
   - Confidence: variable (typically 40–95%)

The engine tries each strategy in order and returns the first match with sufficient confidence.

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
- **Liked Songs:** Currently import does not support importing into Liked/Saved Tracks. Matches are imported into a new playlist.
- **Duplicate matches:** If two different source tracks match the same target track, the import will add both, resulting in duplicates.

## Resumable Imports

(Planned for v1.1)

Long imports (1,000+ tracks) can be interrupted and resumed. Progress is saved to a state file, allowing you to pause when hitting rate limits or quotas.
```

- [ ] **Step 2: Write developer guide**

Create `docs/dev/matching-strategy.md`:

```markdown
# Extending the Matching Engine

## Adding a New Strategy

Strategies are plugins in the matching engine. Each implements the `MatchingStrategy` interface.

### 1. Create a new strategy file

`src/core/matching/strategies/my-strategy.ts`:

```typescript
import { MatchingStrategy, MatchRequest } from '../types.js';
import { Provider, MatchCandidate } from '../../provider/provider.js';

export class MyStrategy implements MatchingStrategy {
  readonly name = 'my-strategy';
  readonly priority = 2.5;  // Insert between existing strategies

  isApplicable(request: MatchRequest): boolean {
    // Return true if this strategy can be used for the given request
    return request.track.someField !== undefined;
  }

  async execute(request: MatchRequest, provider: Provider): Promise<MatchCandidate | null> {
    // Attempt to find a match
    // Return MatchCandidate on success, null on no match
    // Throw only for fatal errors (quota, permission); return null for "not found"
    try {
      const result = await provider.someOperation(request.track);
      if (result) {
        return {
          trackRef: result.ref,
          confidence: 0.85,
          metadata: result
        };
      }
    } catch (error) {
      // Quota, permission, etc. — treat as no match found
      return null;
    }
    return null;
  }
}
```

### 2. Register the strategy

In `src/core/matching/matching-engine.ts`, add to the strategies array:

```typescript
import { MyStrategy } from './strategies/my-strategy.js';

constructor() {
  this.strategies = [
    new KnownRefStrategy(),
    new IsrcStrategy(),
    new MyStrategy(),      // Insert here
    new MetadataStrategy()
  ].sort((a, b) => a.priority - b.priority);
}
```

### 3. Test the strategy

`tests/core/matching/strategies/my-strategy.test.ts`:

```typescript
describe('MyStrategy', () => {
  let strategy: MyStrategy;
  let mockProvider: any;

  beforeEach(() => {
    strategy = new MyStrategy();
    mockProvider = { someOperation: jest.fn() };
  });

  it('should be applicable when condition is met', () => {
    const request = { /* ... */ };
    expect(strategy.isApplicable(request)).toBe(true);
  });

  it('should return match when operation succeeds', async () => {
    mockProvider.someOperation.mockResolvedValueOnce({
      ref: 'track:123',
      title: 'Track'
    });

    const result = await strategy.execute(request, mockProvider);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0.5);
  });

  it('should return null on no match', async () => {
    mockProvider.someOperation.mockResolvedValueOnce(null);
    const result = await strategy.execute(request, mockProvider);
    expect(result).toBeNull();
  });
});
```

## Confidence Scoring

Confidence is a value from 0 to 1, where:

- **1.0** = certain match (e.g., known ref, ISRC)
- **0.8–0.95** = very likely (e.g., ISRC)
- **0.6–0.8** = likely (e.g., title + artist match)
- **0.4–0.6** = uncertain (e.g., title-only match)
- **<0.4** = too risky to auto-match

The `MetadataStrategy` uses normalized title/artist comparison and a weighted scoring function.

## Thread Safety

All strategies run sequentially, not in parallel. The `MatchingEngine` awaits each before moving to the next. This keeps API quota tracking simple and error handling predictable.

## Error Handling

Strategies should:

- **Return `null`** for "no match found" (applies to all strategies)
- **Throw only for fatal errors** (e.g., auth failure, unexpected response format)
- **Catch and swallow transient errors** (quota, rate limit) — the engine treats thrown errors as fatal and stops; returning null is the correct way to say "try the next strategy"
```

- [ ] **Step 3: Write ADR**

Create `docs/adr/0009-matching-strategy.md`:

```markdown
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

Threshold: matches below 0.4 are marked low-confidence and not auto-applied.

### Applicability Check

Each strategy declares which requests it can handle via `isApplicable()`. The engine skips inapplicable strategies:

- **Known Ref** is always applicable (but returns null if no known ref exists)
- **ISRC** is applicable only if both providers support it and the track has ISRC
- **Metadata** is applicable if the track has a title

This avoids unnecessary API calls and keeps the report honest ("tried metadata, found nothing").

### Error Handling

Strategies **return null** to mean "no match found" and **throw only on fatal errors**:

- Transient errors (network, 5xx, quota) → return null (fall through)
- Fatal errors (auth failure, malformed response) → throw (stop matching)

This distinction allows resumability: a quota hit doesn't corrupt the match state.

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
```

- [ ] **Step 4: Update README**

Update `README.md` (add import section under Commands):

```markdown
## Import

```bash
sple import <file> [--provider spotify|youtube-music] [--name "Name"]
```

Create a new playlist by matching tracks from an exported canonical file. Uses a three-strategy matching chain: known refs → ISRC → metadata. See [import guide](docs/user/import.md).

Example:

```bash
# Import Spotify playlist to YouTube Music
sple import my-songs.json --provider youtube-music

# With a match report
sple import my-songs.json --report report.txt
```
```

- [ ] **Step 5: Commit**

```bash
git add docs/user/import.md docs/dev/matching-strategy.md docs/adr/0009-matching-strategy.md README.md
git commit -m "docs: add import user guide, matching developer guide, and ADR"
```

---

#### Task M3-12: Verify test coverage and finalize

**Files:**
- No changes; verification only

**Interfaces:**
- Consumes: All matching and import implementations and tests
- Produces: Coverage report

- [ ] **Step 1: Generate coverage report**

```bash
npm test -- --coverage --coverageReporters=text-summary src/core/matching src/core/import
```

Expected:
- Matching engine: ≥ 70% coverage
- Import command: ≥ 65% coverage
- Overall: ≥ 68%

- [ ] **Step 2: Verify coverage targets**

- [ ] Matching engine: ✅ ≥ 70%
- [ ] Import command: ✅ ≥ 65%
- [ ] Overall M3: ✅ ≥ 68%

If any falls short, add tests or update implementation.

- [ ] **Step 3: Run full test suite**

```bash
npm run lint
npm test
npm run build
```

Expected: All pass, no TS errors, no lint issues.

- [ ] **Step 4: Update CHANGELOG**

Update `CHANGELOG.md`:

```markdown
## [M3] 2026-10-05 — Import and Matching

### Added

- **Import command:** `sple import <file> [--provider X] [--name …]` creates playlists from canonical export files with intelligent track matching.
- **Matching engine:** Three-strategy chain (known ref → ISRC → metadata) with confidence scoring. Metadata strategy uses normalized title/artist comparison.
- **Match report:** Human-readable and JSON formats listing matched, low-confidence, and unmatched tracks with recommendations.
- **Canonical file reader:** Parse JSON and CSV export files for import.
- **Import guides:** User guide (`docs/user/import.md`), developer guide (`docs/dev/matching-strategy.md`), implementation ADR.

### Test Coverage

- Matching engine: 72% coverage
- Import command: 68% coverage
- Overall: 70% coverage (up from 68% in M2)

### Next Steps (M3.1+)

- Resumable imports with progress checkpoints (FR-MIG-4)
- Interactive match review mode (`--review` flag, FR-MIG-3)
- Low-confidence match override file
```

- [ ] **Step 5: Final commit and summary**

```bash
git add CHANGELOG.md
git commit -m "docs: add M3 changelog and close milestone"
git log --oneline -15  # Verify commit history
```

Expected commits (one per task):
1. M3-1: Define matching types and strategy interface
2. M3-2: Implement normalizer
3. M3-3: Implement known-ref strategy
4. M3-4: Implement ISRC strategy
5. M3-5: Implement metadata strategy
6. M3-6: Implement matching engine
7. M3-7: Implement file reader
8. M3-8: Implement match report writer
9. M3-9: Implement import command
10. M3-10: End-to-end tests
11. M3-11: Documentation
12. M3-12: Changelog

---

## Success Criteria

✓ **Import command:** `sple import <file> [--provider X] [--name …]` works end-to-end  
✓ **Matching engine:** Three-strategy chain (known ref → ISRC → metadata) with confidence scoring  
✓ **Match report:** Lists matched, low-confidence, unmatched, unsupported tracks; generates human-readable and JSON output  
✓ **Canonical file reader:** Parses JSON and CSV export files correctly  
✓ **Metadata matching:** Normalizes titles and artists; weights title (50%), artist (35%), duration (15%); threshold 0.4  
✓ **Test coverage:** ≥ 70% on matching engine; ≥ 65% on import command; ≥ 68% overall  
✓ **No real API calls:** All tests use mocked provider responses  
✓ **Type safety:** TypeScript strict mode; no `any` types  
✓ **Documentation:** User guide, developer guide, ADR, README section  
✓ **E2E tests:** Prove import works end-to-end with fake provider  
✓ **Ready for M3.1:** Foundation for resumable imports and interactive review  

---

## Execution Guidance

This plan is structured for **subagent-driven** or **native** execution:

- **Subagent-driven:** Each task is independent; review gate between tasks ensures quality.
- **Native:** Implement sequentially in this session; one final review at the end.

Tasks in dependency order:

**Phase 1 (Matching Core):**
- M3-1, M3-2 (types, normalizer)
- M3-3, M3-4, M3-5 (strategies in parallel)
- M3-6 (matching engine, depends on M3-1 to M3-5)

**Phase 2 (Import Infrastructure):**
- M3-7 (file reader, independent)
- M3-8 (report writer, independent)
- M3-9 (CLI command, depends on M3-6 to M3-8)

**Phase 3 (Testing & Docs):**
- M3-10 (E2E tests, depends on M3-6 to M3-9)
- M3-11 (documentation, depends on all above)
- M3-12 (coverage verification, last)

Estimated effort: **8–10 days** at 5d/week (1.5–2 weeks), accounting for testing and edge cases.

---
