# ADR 0011: Jev as an opt-in judge for metadata matches

- **Status:** Proposed (2026-10-14). Accept only after the [S8 evaluation](../spikes/jev-matching-spike.md#evaluation-protocol-to-run) meets its pass bar; otherwise Rejected.
- **Date:** 2026-10-14
- **Deciders:** project owner (user); architect (author)
- **Related:** FR-MIG-2, FR-MIG-3, NFR-9; ADR 0009 Amendments 1–2 (strategy chain, score, match cache); ADR 0003 §3 (`MatchCandidate`); ADR 0004 §1 (`.env`); ADR 0007 Amendments 4 and 6 (`import --resume`, `migrate`); ADR 0002 Amendment 5 (quota estimate); [spike S8](../spikes/jev-matching-spike.md)

## Context

Spotify → YouTube relies on the `metadata` strategy (ADR 0009 A1 §2–4), because YouTube has no ISRC search. The strategy scores word overlap on titles and artists plus a ±5 s duration check. YouTube hits are videos:
- titles carry packaging (`(Official Video)`, `(Lyrics)`, `Artist - …`);
- the artist is guessed from the title or the channel;
- there is no album;
- covers, live, karaoke and sped-up uploads share most title words with the original.

The scorer can't tell "same song, different recording" from "same recording", and it rejects correct hits whose artist parse failed. ADR 0009 A1 §5 records one such limit: a live version passes at the default threshold.

[Jev](https://docs.typesafe.ai/introduction) (TypeSafe, model `jev-1.13.0`) is a hosted model that answers typed questions about a JSON state with calibrated probabilities. It does not search: provider search still finds the candidates. Its entity-alignment recipe has the same shape as this problem (two records, a 3-level "different / variant / same" score). The research, request shape, cost and the model's known weak spots are in [spike S8](../spikes/jev-matching-spike.md).

## Decision

### 1. Opt-in

- `sple import` and `sple migrate` gain `--matcher basic|jev`, default `basic`. `basic` is the ADR 0009 chain, unchanged.
- `--matcher jev` requires an API key: `TYPESAFE_API_KEY` from the environment or `<configDir>/.env`. If the key is missing or empty, the command fails with a `UsageError` (exit 2) before any request.
- `SPLE_JEV_MODEL` overrides the pinned model (default `jev-1.13.0`). sple never uses the moving aliases `jev-latest` or `jev-preview` by default.
- `matcher` is saved in the run file's `options` (ADR 0007 Amendment 4, next to `minConfidence` and `cache`). `--resume` rejects `--matcher` like the other start-only flags and resumes with the saved value.

### 2. Placement in the chain

With `--matcher jev`, the `metadata` slot (ADR 0009 A2 §1, #4) runs `jev` instead. `known-ref`, `cache` and `isrc` are unchanged and still run first, so Jev is only asked about tracks that reach metadata search. The engine receives the Jev client as an option next to `cache`; `MatchRequest` is unchanged.

### 3. Algorithm per track

1. **Search:** the same call as `metadata`: `searchTracks({ kind: 'metadata', title, artists, album, durationMs }, { limit: 10 })`. It uses no extra provider quota.
2. **Pre-score:** score every hit with ADR 0009 A1 §4 (`t`, `a`, `confidence`).
3. **Shortlist:**
   - Keep hits that pass the **relaxed gate** *G*, sort them by the A1 confidence (ties go to provider order), and keep the first *K*.
   - An empty shortlist gives `null`, and the track is unmatched as today.
4. **Ask Jev,** one request per track:
   - The state is `{ source, candidates: { c1…cK } }`. Each record carries only `title`, `artists` and `album`, plus `channel` when the adapter supplies it.
   - There is one `score` question per candidate, with three levels: 0 = a different song; 1 = the same song but a different recording or version (live, remix, cover, acoustic, instrumental, karaoke, sped up or slowed, re-recorded); 2 = the same recording, where only the upload's packaging differs. The exact wording is in spike S8.
   - Durations are **not** sent; they are compared in code (step 5).
5. **Combine:** for candidate *i*, let `level = round(score)` and `p2 = probabilities[2]`. The duration check passes when either duration is missing or `|Δ| ≤ D` s.
   - `level = 2` and the duration check passes → eligible, `confidence = p2`.
   - `level = 2` and the duration check fails, or `level = 1` → eligible, `confidence = min(p2, 0.45)`. The cap keeps it below the default `minConfidence`, so it is reported as `low-confidence`.
   - `level = 0` → rejected.
   - The best eligible candidate by confidence wins; ties go to the earlier hit in the provider's order. If none is eligible, the result is `null` (unmatched).
6. **Constants** *K*, *D*, *G*, the 0.45 cap and the question wording are **provisional** and will be filled in from S8. The starting points are K = 5, D = 10 s, and G = `t > 0 || a > 0`. The exact rules and test vectors are in ADR 0009 Amendment 3.

### 4. Failures

Jev is an improvement layer. A Jev failure never stops a run or changes provider error handling:

- On any Jev error, the strategy returns the **`basic` metadata result** for that track (`strategy: 'metadata'`) and records `jev: <message>` in the result's `error`. That covers network errors, timeouts, 401, 422, and 429/529 after the SDK's retries.
- A 401 also turns Jev off for the rest of the run. One warning is printed the first time Jev fails.
- Jev errors are never mapped to `RateLimitError`, `QuotaExhaustedError` or `AuthRequiredError`, which ADR 0009 A1 §1.4 treats as run-stopping provider errors.
- SDK retries are capped at 2 with the SDK's 10 s per-attempt timeout. The SDK's `logLevel` is fixed at `warn`, because at `debug` it logs request bodies unredacted.

### 5. Results, cache and report

- `MatchCandidate.strategy` gains `'jev'`. A Jev-chosen candidate has `strategy: 'jev'`. A fallback after a Jev error keeps `'metadata'`.
- The match cache (ADR 0009 A2) stores `'jev'` entries the same way as `'metadata'` entries. The cache key does not depend on the matcher, so a cached `metadata` match is reused under `--matcher jev` and vice versa; `--no-cache` forces a fresh decision.
- The report's `strategies[]` lists `jev`, and the JSON report gains `matcher` and `jevModel` (the response's `model` field) at the top level.

### 6. Dependency

Use the official SDK `@typesafe-ai/sdk`, pinned to an exact version (0.6.0 today: MIT licence, no runtime dependencies, Node ≥ 20). Tests inject `fetch` and never call the network. ADR 0009's "No External Dependencies" is about fuzzy-matching libraries in the scorer, and the `basic` scorer and its A1 §5 test vectors stay exactly as they are.

## Alternatives considered

1. **One `choice` over all candidates (plus "none").** One question per track, but Jev leans towards the first option, and the answer can change when the options are reordered (Jev 1.13 jaggedness). Rejected in favour of one independent question per candidate.
2. **Jev only for unmatched and low-confidence tracks.** Fewest calls, but it can't catch a confident wrong match (a live or cover video that scores high), which is the error users mind most.
3. **Replace the scorer with Jev.** Every import would then need the network and a TypeSafe key, the A1 §5 vectors would no longer be deterministic, and ports would depend on a vendor.
4. **One call per (track, candidate) pair**, as in the entity-alignment recipe. More requests and the same tokens. Kept as an S8 experiment; adopted only if it is clearly more accurate than one call per track.
5. **A general LLM with a "return JSON" prompt.** Untyped output, no calibrated probabilities, and higher cost per decision.

## Consequences

- With `--matcher basic`, nothing changes: no new requests, the same results, the same privacy statement.
- With `--matcher jev`, each track that reaches metadata search makes one TypeSafe request. That is roughly 1K input tokens, or about $0.04 per 1,000 tracks at $0.042 per million tokens. YouTube quota is unchanged.
- Results under `jev` depend on the pinned model. A model upgrade is a deliberate change: rerun S8 and update `SPLE_JEV_MODEL`'s default.
- `MatchCandidate.strategy`, the match-cache schema, the run file and the JSON report each gain one value or field. Ports must implement the combination rule (§3.5) exactly; the Jev answers themselves are mocked in tests.

## Risks

| Risk | Mitigation |
|---|---|
| **Privacy.** Track metadata (the user's titles and artists, and YouTube result titles and channels) goes to TypeSafe. This contradicts today's PRIVACY.md and must be disclosed (YouTube Developer Policies III.A.2.e). | Opt-in only. No tokens, account IDs or provider refs are sent. PRIVACY.md and NFR-9 are updated on acceptance (below). TypeSafe states it does not train on user data; retention is under its DPA, and zero data retention is enterprise-only. |
| **YouTube Policies III.E.4.h** ("must not … use API Data to create new or derived data or metrics") and III.E.3.b (sharing Authorized Data). | Search results are not the user's Authorized Data. Jev's answer is used only to choose a match, the same way the `basic` score is, and is stored only as the match confidence under the existing 30-day cache rule. **Open: the owner should confirm this reading before acceptance.** |
| Lower accuracy on non-English titles. | S8 includes at least 20 non-English tracks. `basic` stays available. |
| Prompt injection through video titles. | Video titles are untrusted data. The duration check runs in code, and a wrong match still shows its confidence and is listed in the report. |
| Model drift and the vendor being unavailable or changing price. | Pinned model ID. Failures fall back to `basic` (§4). The feature is opt-in. |

## Amendments to other ADRs

These amendments were written with this ADR and are also **Proposed**. They take effect together when this ADR is accepted.

| ADR | Amendment | What it adds |
|---|---|---|
| [0009](0009-matching-strategy.md#amendment-3-jev-matcher-proposed-with-adr-0011) | Amendment 3 | The `jev` strategy spec for ports: shortlist, request, combination rule, errors, cache, report and test vectors. Narrows "No External Dependencies" to the `basic` scorer |
| [0003](0003-provider-interface-and-capabilities.md#amendment-4-jev-matcher-proposed-with-adr-0011) | Amendment 4 | `'jev'` in `MatchCandidate.strategy`; `TrackHit.channel` deferred to S8 |
| [0004](0004-token-store-and-config.md#amendment-2-jev-matcher-proposed-with-adr-0011) | Amendment 2 | The `TYPESAFE_API_KEY` and `SPLE_JEV_MODEL` variables; SDK settings fixed by sple |
| [0007](0007-cli-conventions.md#amendment-7---matcher-proposed-with-adr-0011) | Amendment 7 | `--matcher` usage, validation, the run-file option, stderr lines and help |
| [0002](0002-youtube-music-provider.md#amendment-6-youtube-data-and-the-jev-matcher-proposed-with-adr-0011) | Amendment 6 | What YouTube data is sent, the Developer Policies reading (the III.E.4.h question), quota unaffected |

## On acceptance

When S8 passes, in the PR that flips this ADR to Accepted:

1. Set the final K, D, gate, cap and question wording in ADR 0009 Amendment 3 (§2–4 and the §7 vectors), and mark the five amendments above Accepted.
2. **docs/PRIVACY.md** (YouTube Developer Policies III.A.2.e; it must ship with the feature). Replace "anyone other than the music services you connect" with wording that names this exception, and add roughly: "**Optional: Jev matching.** If you run `import` or `migrate` with `--matcher jev`, sple sends the title, artists and album of each track it needs to search for, together with the titles and artists of the search results, to TypeSafe (`api.typesafe.ai`) using your own TypeSafe API key. Nothing else is sent: no tokens, account IDs, playlist names or durations. See TypeSafe's privacy policy and DPA. Without `--matcher jev`, nothing is sent to TypeSafe."
3. **requirements.md:** FR-MIG-2 mentions the optional Jev judge (ADR 0009 Amendment 3). NFR-9's "no data is sent to any `sple` server" still holds, and the third-party disclosure is added next to it. Spike S8 is marked resolved.
4. **docs/dev/matching-strategy.md:** this page is already stale (the old candidate shape, and its claim that strategies swallow quota errors). Rewrite it against ADR 0009 A1–A3.

If S8 fails, mark this ADR and the five amendments **Rejected**, with S8's numbers as the reason.

## Sources

- [Spike S8](../spikes/jev-matching-spike.md) and the TypeSafe documentation it cites (read 2026-10-14).
- [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.A.2.e, III.E.3.b, III.E.4.
