# ADR 0011: OpenAI Decisions API as an opt-in judge for metadata matches

- **Status:** Proposed (2026-10-14). Accept only after the [S8 evaluation](../spikes/decisions-matching-spike.md#evaluation-protocol-to-run) meets its pass bar; otherwise Rejected.
- **Date:** 2026-10-14
- **Deciders:** project owner (user); architect (author)
- **Related:** FR-MIG-2, FR-MIG-3, NFR-1, NFR-9; ADR 0009 Amendments 1–2 (strategy chain, score, match cache); ADR 0003 §3 (`MatchCandidate`); ADR 0004 §1 (`.env`); ADR 0007 Amendments 4 and 6 (`import --resume`, `migrate`); ADR 0002 Amendment 5 (quota estimate); [spike S8](../spikes/decisions-matching-spike.md)

## Context

Spotify → YouTube relies on the `metadata` strategy (ADR 0009 A1 §2–4), because YouTube has no ISRC search. The strategy scores word overlap on titles and artists plus a ±5 s duration check. YouTube hits are videos:
- titles carry packaging (`(Official Video)`, `(Lyrics)`, `Artist - …`);
- the artist is guessed from the title or the channel;
- there is no album;
- covers, live, karaoke and sped-up uploads share most title words with the original.

The scorer can't tell "same song, different recording" from "same recording", and it rejects correct hits whose artist parse failed. ADR 0009 A1 §5 records one such limit: a live version passes at the default threshold.

OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`POST /v1/decisions`, model `gpt-6-luna`, public beta since 2026-10-06) answers typed questions about an input with probabilities: `predicate`, `choice` and `score`. It does not search: provider search still finds the candidates. TypeSafe's Jev offers the same kind of API but needs a separate subscription, and the owner already has an OpenAI account. The research, request shape, cost and unknowns are in [spike S8](../spikes/decisions-matching-spike.md).

## Decision

### 1. Opt-in

- `sple import` and `sple migrate` gain `--matcher basic|openai`, default `basic`. `basic` is the ADR 0009 chain, unchanged.
- `--matcher openai` requires `OPENAI_API_KEY` from the environment or `<configDir>/.env`. If the key is missing or empty, the command fails with a `UsageError` (exit 2) before any request.
- `SPLE_OPENAI_DECISIONS_MODEL` overrides the model (default `gpt-6-luna`). OpenAI publishes no dated snapshot, so the report records the model that answered (§5).
- `matcher` is saved in the run file's `options` (ADR 0007 Amendment 4, next to `minConfidence` and `cache`). `--resume` rejects `--matcher` like the other start-only flags and resumes with the saved value.

### 2. Placement in the chain

With `--matcher openai`, the `metadata` slot (ADR 0009 A2 §1, #4) runs `openai` instead. `known-ref`, `cache` and `isrc` are unchanged and still run first, so OpenAI is only asked about tracks that reach metadata search. The engine receives the Decisions client as an option next to `cache`; `MatchRequest` is unchanged.

### 3. Algorithm per track

1. **Search:** the same call as `metadata`: `searchTracks({ kind: 'metadata', title, artists, album, durationMs }, { limit: 10 })`. It uses no extra provider quota.
2. **Pre-score:** score every hit with ADR 0009 A1 §4 (`t`, `a`, `confidence`).
3. **Shortlist:**
   - Keep hits that pass the **relaxed gate** *G*, sort them by the A1 confidence (ties go to provider order), and keep the first *K*.
   - An empty shortlist gives `null`, and the track is unmatched as today.
4. **Ask OpenAI,** one `decisions.create` request per track:
   - `input` is a JSON string `{ source, candidates: { c1…cK } }`. Each record carries only `service`, `title`, `artists` and `album`.
   - There is one `score` question per candidate, `name` = the candidate key, with three levels: `different` = a different song; `version` = the same song but a different recording or version (live, remix, cover, acoustic, instrumental, karaoke, sped up or slowed, re-recorded); `same` = the same recording, where only the upload's packaging differs. The exact wording is in spike S8.
   - Durations are **not** sent; they are compared in code (step 5).
5. **Combine:** for candidate *i*, let `level = round(score)` and `p2` = the probability of the level whose `value` is 2. The duration check passes when either duration is missing or `|Δ| ≤ D` s.
   - `level = 2` and the duration check passes → eligible, `confidence = p2`.
   - `level = 2` and the duration check fails, or `level = 1` → eligible, `confidence = min(p2, 0.45)`. The cap keeps it below the default `minConfidence`, so it is reported as `low-confidence`.
   - `level = 0` → rejected.
   - The best eligible candidate by confidence wins; ties go to the earlier hit in the provider's order. If none is eligible, the result is `null` (unmatched).
6. **Constants** *K*, *D*, *G*, the 0.45 cap and the question wording are **provisional** and will be filled in from S8. The starting points are K = 5, D = 10 s, and G = `t > 0 || a > 0`. The exact rules and test vectors are in ADR 0009 Amendment 3.

### 4. Failures

The OpenAI judge is an improvement layer. A failure never stops a run or changes provider error handling:

- On any failure, the strategy returns the **`basic` metadata result** for that track (`strategy: 'metadata'`) and records `openai: <message>` in the result's `error`. That covers a network error, a timeout, any HTTP error after the SDK's retries, a `refusal` answer, or a missing answer.
- A 401 or 403, a 404 (the model isn't available to this account), or a 429 with `insufficient_quota` also turns OpenAI off for the rest of the run, because retrying can't fix them. One warning is printed the first time OpenAI fails.
- OpenAI errors are never mapped to `RateLimitError`, `QuotaExhaustedError` or `AuthRequiredError`, which ADR 0009 A1 §1.4 treats as run-stopping provider errors.

### 5. Results, cache and report

- `MatchCandidate.strategy` gains `'openai'`. A candidate chosen by OpenAI has `strategy: 'openai'`. A fallback after a failure keeps `'metadata'`.
- The match cache (ADR 0009 A2) stores `'openai'` entries the same way as `'metadata'` entries. The cache key does not depend on the matcher, so a cached `metadata` match is reused under `--matcher openai` and vice versa; `--no-cache` forces a fresh decision.
- The report's `strategies[]` lists `openai`, and the JSON report gains `matcher` and `decisionsModel` (the response's `model` field) at the top level.

### 6. Dependency and Node version

- Use the official [`openai`](https://www.npmjs.com/package/openai) SDK, `^7.30.0` (7.33.0 today; Apache-2.0, no runtime dependencies, all peer dependencies optional). It is the only runtime dependency the feature adds. Tests stub `client.decisions.create` (or inject `fetch`) and never call the network.
- sple configures it explicitly:
  - `apiKey`: from `OPENAI_API_KEY`.
  - `baseURL`: `https://api.openai.com/v1`.
  - `maxRetries`: 2.
  - `timeout`: 30 s per attempt, instead of the SDK's 10 minutes.
  - `logLevel`: `'warn'`, so `OPENAI_LOG=debug` can't print request bodies.
  - `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are honoured as the SDK reads them.
- The SDK requires **Node ≥ 22**, so sple's `engines.node` becomes `>=22.0.0`.
  - This matches CI, which already tests only 22.x and 24.x, and NFR-1 ("Node.js active LTS"). Node 20 reached end-of-life on 2026-04-30.
  - The bump applies whichever matcher is used, and it ships in the implementation PR.
- ADR 0009's "No External Dependencies" is about fuzzy-matching libraries in the scorer. The `basic` scorer and its A1 §5 test vectors stay exactly as they are.

## Alternatives considered

1. **TypeSafe Jev.** Same three question types, dated model IDs (`jev-1.13.0`), a published list of weak spots, and $0.042 per 1M input tokens. Its SDK works on Node 20. Rejected by the owner (2026-10-14) because it needs a separate subscription. If the Decisions API fails S8, it is the next candidate, and the spec in ADR 0009 Amendment 3 carries over almost unchanged.
2. **Calling `/v1/decisions` with `fetch`, without the SDK.** This would keep Node 20 and avoid the 23 MB package, but sple would have to maintain the retry, error and type code itself while the API is in beta. The owner accepted the Node 22 bump instead.
3. **One `choice` over all candidates (plus "none").** One question per track, but the answer may depend on option order. Rejected in favour of one independent question per candidate.
4. **OpenAI only for unmatched and low-confidence tracks.** Fewest calls, but it can't catch a confident wrong match (a live or cover video that scores high), which is the error users mind most.
5. **Replace the scorer.** Every import would then need the network and an OpenAI key, the A1 §5 vectors would no longer be deterministic, and ports would depend on a vendor.
6. **One request per (track, candidate) pair.** More requests and the same tokens. Kept as an S8 experiment.
7. **Responses API with Structured Outputs.** That returns generated JSON rather than probabilities over fixed answers, costs output tokens, and is slower per decision.

## Consequences

- With `--matcher basic`, nothing changes: no new requests, the same results, the same privacy statement. The only change everyone sees is the Node 22 minimum.
- With `--matcher openai`, each track that reaches metadata search makes one request. That is roughly 1K input tokens, or about $0.10 per 1,000 tracks at $0.10 per 1M input tokens, billed to the user's OpenAI account. YouTube quota is unchanged.
- Results depend on a model that can't be pinned. The report records `decisionsModel`, and S8 should be rerun when OpenAI announces a model or contract change. The API is in beta, so the request or response shape may change before GA; the SDK's major version is pinned with `^7`.
- `MatchCandidate.strategy`, the match-cache schema, the run file and the JSON report each gain one value or field. Ports must implement the combination rule (§3.5) exactly; the OpenAI answers themselves are mocked in tests.
- The npm package grows by about 23 MB unpacked (the `openai` SDK).

## Risks

| Risk | Mitigation |
|---|---|
| **Privacy.** Track metadata (the user's titles and artists, and YouTube result titles) goes to OpenAI. This contradicts today's PRIVACY.md and must be disclosed (YouTube Developer Policies III.A.2.e). | Opt-in only. No tokens, account IDs, provider refs or durations are sent. PRIVACY.md and NFR-9 are updated when the feature ships (below). OpenAI doesn't train on API data unless the organization opts in. `/v1/decisions` keeps abuse-monitoring logs for 30 days, and ZDR is available to eligible organizations. |
| **YouTube Policies III.E.4.h** ("must not … use API Data to create new or derived data or metrics") and III.E.3.b (sharing Authorized Data). | Search results are not the user's Authorized Data. The model's answer is used only to choose a match, the same way the `basic` score is, and is stored only as the match confidence under the existing 30-day cache rule. **Open: the owner should confirm this reading before acceptance.** |
| Calibration is unpublished. | S8 measures false accepts against hand labels and sets the cap. Nothing relies on the probabilities being calibrated beyond what S8 shows. |
| Lower accuracy on non-English titles. | S8 includes at least 20 non-English tracks. `basic` stays available. |
| Prompt injection through video titles. | Titles are untrusted data. The duration check runs in code, and a wrong match still shows its confidence and is listed in the report. |
| A beta API, an unpinned model, and changes to price or availability. | Failures fall back to `basic` (§4). The report records the model. The feature is opt-in. |

## Amendments to other ADRs

These amendments were written with this ADR and are also **Proposed**. They take effect together when this ADR is accepted.

| ADR | Amendment | What it adds |
|---|---|---|
| [0009](0009-matching-strategy.md#amendment-3-openai-decisions-matcher-proposed-with-adr-0011) | Amendment 3 | The `openai` strategy spec for ports: shortlist, request, combination rule, errors, cache, report and test vectors. Narrows "No External Dependencies" to the `basic` scorer |
| [0003](0003-provider-interface-and-capabilities.md#amendment-4-openai-decisions-matcher-proposed-with-adr-0011) | Amendment 4 | `'openai'` in `MatchCandidate.strategy` |
| [0004](0004-token-store-and-config.md#amendment-2-openai-decisions-matcher-proposed-with-adr-0011) | Amendment 2 | The `OPENAI_API_KEY` and `SPLE_OPENAI_DECISIONS_MODEL` variables; SDK settings fixed by sple |
| [0007](0007-cli-conventions.md#amendment-7---matcher-proposed-with-adr-0011) | Amendment 7 | `--matcher` usage, validation, the run-file option, stderr lines and help |
| [0002](0002-youtube-music-provider.md#amendment-6-youtube-data-and-the-openai-decisions-matcher-proposed-with-adr-0011) | Amendment 6 | What YouTube data is sent, the Developer Policies reading (the III.E.4.h question), quota unaffected |

## On acceptance

When S8 passes, in the PR that flips this ADR to Accepted:

1. Set the final K, D, gate, cap and question wording in ADR 0009 Amendment 3 (§2–4 and the §7 vectors), and mark the five amendments above Accepted.
2. **requirements.md:**
   - NFR-1 states the Node ≥ 22 minimum.
   - FR-MIG-2 mentions the optional OpenAI judge (ADR 0009 Amendment 3).
   - NFR-9's "no data is sent to any `sple` server" still holds, and the third-party disclosure is added next to it.
   - Spike S8 is marked resolved.

In the implementation PR:

3. Set `package.json` `engines.node` to `>=22.0.0` and add `openai` `^7.30.0`. Also update `.github/branch-protection.json`, which still lists `build (18.x)` and `build (20.x)` while `ci.yml` runs 22.x and 24.x.
4. **docs/PRIVACY.md** (YouTube Developer Policies III.A.2.e; it must ship with the feature). Replace "anyone other than the music services you connect" with wording that names this exception, and add roughly: "**Optional: OpenAI matching.** If you run `import` or `migrate` with `--matcher openai`, sple sends the title, artists and album of each track it needs to search for, together with the titles and artists of the search results, to OpenAI (`api.openai.com`) using your own OpenAI API key. Nothing else is sent: no tokens, account IDs, playlist names or durations. OpenAI does not train on API data unless your organization opts in, and keeps abuse-monitoring logs for up to 30 days; see OpenAI's data controls. Without `--matcher openai`, nothing is sent to OpenAI."
5. **docs/dev/matching-strategy.md:** this page is already stale (the old candidate shape, and its claim that strategies swallow quota errors). Rewrite it against ADR 0009 A1–A3.

If S8 fails, mark this ADR and the five amendments **Rejected**, with S8's numbers as the reason.

## Sources

- [Spike S8](../spikes/decisions-matching-spike.md) and the OpenAI documentation and SDK types it cites (read 2026-10-14).
- [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.A.2.e, III.E.3.b, III.E.4.
