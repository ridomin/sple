# Jev match-judge spike (S8)

- **Date:** 2026-10-14 (research); evaluation not yet run
- **Status:** Research done; **evaluation pending** (needs the owner's `TYPESAFE_API_KEY`)
- **Related:** [ADR 0011](../adr/0011-jev-match-judge.md) (Proposed), [ADR 0009 Amendment 1 §4](../adr/0009-matching-strategy.md#amendment-1-spec-review-for-ports) (metadata score), [ADR 0002](../adr/0002-youtube-music-provider.md) (YouTube quota and policies), [requirements FR-MIG-2, NFR-9](../requirements.md)
- **Data handling:** results record counts and rates only. Labelled pairs (titles, artists, video IDs) stay in a local fixture outside the repo, and that fixture is deleted within 30 days (YouTube API Developer Policies III.E.4).

| Question | Status | Decision |
|---|---|---|
| Can Jev judge "same recording?" for a Spotify track and a YouTube hit? | Researched | Yes, in principle. It fits the entity-alignment pattern (see below) |
| Does it beat the ADR 0009 scorer on Spotify → YouTube? | **Not run** | Gate for accepting ADR 0011 |
| Shortlist size K, relaxed gate, duration tolerance D | **Not run** | Filled in from the evaluation |
| One fan-out call per track vs one call per pair | **Not run** | Filled in from the evaluation |

## Why

The metadata strategy ([ADR 0009 A1 §4](../adr/0009-matching-strategy.md#4-metadata-score)) scores word overlap on titles and artists plus a ±5 s duration check. On Spotify → YouTube it is weakest where YouTube data is noisy:

- `searchTracks` returns videos. Their titles look like `Artist - Song (Official Video)` and `Song (Lyrics)`, and the artist is guessed from the video title or the channel name (`src/providers/youtube-music/track-metadata.ts`).
- YouTube hits have no album and no ISRC, so the only signals are title, guessed artist and duration.
- Covers, live recordings, karaoke, sped-up and lyric re-uploads share most title words with the original. Live and remix words lower the score (A1 §3) but don't reject the hit (A1 §5, last test vector).

The scorer can't tell "same song, different recording" from "same recording", and it rejects correct hits whose artist parse failed (`a = 0`).

## What Jev is

[Jev](https://docs.typesafe.ai/introduction) is TypeSafe's hosted "System One" model. It does not generate text. You send a **state** (text or JSON) and a set of named, typed **questions**, and get typed answers back:

| Type | Answer | Use here |
|---|---|---|
| `noul` | `noul`: P(yes), 0–1. No `confidence` field; use \|2p−1\| if needed | Field checks ("same artist?") |
| `choice` | `choice`, `probabilities` (sum 1), `confidence`. Up to 255 options | Not used: Jev leans towards the first option (ordering bias) |
| `score` | `score` (fractional), `legend`, `probabilities` per level, `confidence`. 2–10 ordered levels | **The match decision**: different / variant / same recording |

- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`. The body is `{ model, state, questions }` and the response is `{ model, answers, usage: { input_tokens, output_tokens } }`. All questions in one call are evaluated in parallel ("speculative fan-out"), so extra questions add tokens but little latency.
- **Errors:** 401 bad key, 422 validation, 429 rate limit, 529 overloaded. Retry 429 and 529 with backoff.
- **Model:** `jev-latest` and `jev-preview` both point to `jev-1.13.0` today. Aliases move when a new release ships, and answers can change with them. Pin the versioned ID if thresholds are tuned against it, and log the response's `model` field.
- **Limits and price (jev-1.13.0):** 80 requests/s and 100K tokens/s ("can change without notice"). 64K tokens of context per request. **$0.042 per million input tokens; output tokens are free.**
- **JS SDK:** [`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript) 0.6.0. MIT licence, no runtime dependencies, Node ≥ 20, ESM and CJS with type declarations.
  - API: `new TypeSafeClient(config).systemOne({ state, questions })`, with the helpers `choice()`, `score()` and `noul()`. Answer types are inferred from the questions.
  - Config: `apiKey` (default `TYPESAFE_API_KEY`), `baseURL` (`TYPESAFE_BASE_URL`), `defaultModel` (`TYPESAFE_DEFAULT_MODEL`, default `jev-latest`), `timeout` (10 000 ms **per attempt**, with no total budget), `retry` (a partial `RetryPolicy`), `fetch` (injectable, which we can use for tests), `logger`, `logLevel`.
  - At `debug` level the SDK logs request **bodies** unredacted, so sple must never raise its log level.
  - Error classes: `AuthenticationError`, `RateLimitError`, `APITimeoutError`, `APIConnectionError`, `UnprocessableEntityError`, `InternalServerError`, and others, all under `TypeSafeError`.

### Known weak spots (Jev 1.13 "jaggedness" page) and how the design handles them

| Weakness | Design response |
|---|---|
| Jev "can't reliably judge whether two numeric values are close"; dates and durations are treated as text | Duration is compared **in code** and never asked of Jev |
| Choice leans towards the first option | One `score` question per candidate, not a Choice over the list |
| Irrelevant or noisy state lowers accuracy | Shortlist in code first. Send only title, artists, album and channel |
| English is the main training language | Evaluation set must include non-English titles; see protocol |
| Injected instructions in the input can change answers | Video titles are untrusted. Duration and artist checks in code bound the damage, and the worst case is a wrong match, which `minConfidence` and the report already surface |
| Score levels are weakly calibrated; use them only for threshold checks | Accept on the rounded level plus P(level 2), not on interpolated magnitudes |

### Closest TypeSafe recipes

- **[Knowledge-graph entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment)** has the same shape as our problem: two records (`entity_a`, `entity_b`) in one state and one 3-level `score`:
  - 0: different products;
  - 1: closely related, may or may not be the same (variant, special edition);
  - 2: same product.
  
  Noul side questions (`same_name`, `same_brewery`) are returned for explanation only, and the numeric field (ABV) is compared in code. The score is rounded to route: 0 → unlink, 1 → curator, 2 → merge. The cookbook reports no accuracy figures.
- **[Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe)**: BM25 shortlist, then one `noul` per (query, candidate) pair. Top-1 went from 5% to 18% and top-10 from 38% to 62%. The 1,200 calls used about 1.54M input tokens, roughly $0.06.

## Proposed request

One call per track. The state holds the source track and the shortlisted candidates. There is one `score` question per candidate, plus an optional `noul` per candidate on the artist for the report.

```json
{
  "model": "jev-1.13.0",
  "state": {
    "source": { "service": "Spotify", "title": "Hello", "artists": ["Adele"], "album": "25" },
    "candidates": {
      "c1": { "service": "YouTube", "title": "Adele - Hello (Official Music Video)", "artists": ["Adele"], "channel": "AdeleVEVO" },
      "c2": { "service": "YouTube", "title": "Hello - Adele (Live at the BBC)", "artists": ["Adele"], "channel": "BBC Music" },
      "c3": { "service": "YouTube", "title": "Adele - Hello (Cover by J.Fla)", "artists": ["J.Fla"], "channel": "JFlaMusic" }
    }
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
    },
    "c2": { "...": "same question, for c2" },
    "c3": { "...": "same question, for c3" }
  }
}
```

The durations (`durationMs`) are deliberately left out of the state. Code applies the duration check after Jev answers.

**Combining (ADR 0011 §3.5).** For each candidate, take the rounded score level and `p2 = probabilities[2]`.
- A candidate is eligible when its level is 2 and it passes the duration check. Its confidence is `p2`.
- A candidate that fails the duration check, or rounds to level 1, has its confidence capped at 0.45, so it is low-confidence at the default threshold. The exact rules and test vectors are in [ADR 0009 Amendment 3](../adr/0009-matching-strategy.md#amendment-3-jev-matcher-proposed-with-adr-0011).
- The best eligible candidate wins. Ties go to the earlier hit in the provider's order.

**Cost estimate.** About 150 tokens for the source plus about 150 per candidate (state and question). With K = 5 that is roughly 1K input tokens per track: **about $0.04 per 1,000 tracks**. Jev uses no YouTube quota, and the search call is the same one the metadata strategy already makes.

## Evaluation protocol (to run)

1. **Dataset.** Pick 150 Spotify tracks from one or two of the owner's playlists (`sple export`). The set should include at least 20 non-English titles, 15 tracks with live or remix versions in the catalogue, and 15 tracks whose artist name differs between services ("The Beatles" vs "Beatles", featured artists).
2. **Hits.** Run the YouTube `searchTracks` call once per track with `limit: 10`. That is 150 searches, about 2 days of the 100-searches-per-day bucket. Save each track's hits to a local fixture outside the repo (path under the config directory), so that every later step is offline for YouTube.
3. **Labels.** Hand-label every (track, hit) pair as `same`, `variant` or `different`. A track's correct answer is any `same` hit, or "none" if there isn't one.
4. **Runs.** All runs are offline against the fixture:
   - `basic`: today's `MetadataStrategy` scoring.
   - `jev-fanout`: K ∈ {3, 5, 8} × D ∈ {5, 10, 15} s, relaxed gate = `t > 0` (some title overlap) or `a > 0`.
   - `jev-pair`: the best fan-out setting, but one call per (track, candidate) pair.
   - Repeat the best Jev run once to check that answers are stable on the pinned model.
5. **Measures,** each at `minConfidence` 0.5 (the default) and 0.8:
   - correct accept: `matched` and labelled `same`;
   - **false accept**: `matched`, labelled `variant` or `different`, or the track has no `same` hit;
   - low-confidence rate;
   - unmatched-but-had-a-`same`-hit rate;
   - tokens and wall time.
6. **Pass bar for ADR 0011:** false accepts ≤ `basic` **and** correct accepts at least 10 points above `basic` at the default threshold. If it fails, ADR 0011 is Rejected and this doc records why.

## Results

_Not run yet._

| Run | K | D (s) | Correct accept | False accept | Low-conf | Missed `same` | Tokens | Time |
|---|---|---|---|---|---|---|---|---|
| basic | – | 5 | | | | | – | |

**Decision:** pending.

## Sources

- TypeSafe docs: [introduction](https://docs.typesafe.ai/introduction), [quick start](https://docs.typesafe.ai/introduction/quickstart), [API](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models), [confidence](https://docs.typesafe.ai/confidence), [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), [state](https://docs.typesafe.ai/concepts/state), [fan-out](https://docs.typesafe.ai/patterns/fan-out), [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring), [entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment), [re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe), [JS SDK](https://docs.typesafe.ai/sdk/javascript), [client config](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig), [legal](https://docs.typesafe.ai/legal). All read 2026-10-14.
- npm: `@typesafe-ai/sdk` 0.6.0 (MIT, no dependencies, `engines.node >=20`).
- [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.A.2.e, III.E.4.
