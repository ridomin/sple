# Extending the Matching Engine

## Adding a New Strategy

Strategies are plugins in the matching engine. Each implements the `MatchingStrategy` interface (`src/core/matching/types.ts`). Tests use `node:test`.

### 1. Create a new strategy file

`src/core/matching/strategies/my-strategy.ts`:

```typescript
import type { MatchingStrategy, MatchRequest, MatchCandidate } from '../types.js';
import type { Provider } from '../../provider/provider.js';

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
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('MyStrategy', () => {
  const strategy = new MyStrategy();
  const request = { /* ... */ } as any;

  test('is applicable when condition is met', () => {
    assert.equal(strategy.isApplicable(request), true);
  });

  test('returns match when operation succeeds', async () => {
    const provider = {
      someOperation: async () => ({ ref: 'track:123', title: 'Track' })
    } as any;
    const result = await strategy.execute(request, provider);
    assert.ok(result);
    assert.ok(result.confidence > 0.5);
  });

  test('returns null on no match', async () => {
    const provider = { someOperation: async () => null } as any;
    assert.equal(await strategy.execute(request, provider), null);
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
- **Catch and swallow transient errors** (quota, rate limit) and return null to fall through to the next strategy.

Note: the current `MatchingEngine` catches any error thrown by a strategy and continues with the next strategy, so a thrown error never aborts matching; it results in the track being reported as unmatched if no later strategy succeeds.
