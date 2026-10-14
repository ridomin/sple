# ADR 0011: A local decision model as an opt-in judge for metadata matches

- **Status:** Proposed (2026-10-14). Accept only after the [S8 evaluation](../spikes/local-judge-spike.md#evaluation-protocol-to-run) meets its pass bar; otherwise Rejected.
- **Date:** 2026-10-14
- **Deciders:** project owner (user); architect (author)
- **Related:** FR-MIG-2, FR-MIG-3, NFR-1, NFR-9; ADR 0009 Amendments 1–2 (strategy chain, score, match cache); ADR 0003 §3 (`MatchCandidate`); ADR 0004 §1 (`.env`); ADR 0007 Amendments 4 and 6 (`import --resume`, `migrate`); ADR 0002 Amendment 5 (quota estimate); [spike S8](../spikes/local-judge-spike.md)

## Context

Spotify → YouTube relies on the `metadata` strategy (ADR 0009 A1 §2–4), because YouTube has no ISRC search. The strategy scores word overlap on titles and artists plus a ±5 s duration check. YouTube hits are videos:
- titles carry packaging (`(Official Video)`, `(Lyrics)`, `Artist - …`);
- the artist is guessed from the title or the channel;
- there is no album;
- covers, live, karaoke and sped-up uploads share most title words with the original.

The scorer can't tell "same song, different recording" from "same recording", and it rejects correct hits whose artist parse failed. ADR 0009 A1 §5 records one such limit: a live version passes at the default threshold.

"Decision" models answer a typed question about an input with a probability for each answer instead of generated text. Two hosted ones were considered first: TypeSafe's Jev, which needs a subscription, and OpenAI's Decisions API, which needs an API key the owner doesn't have. Both were dropped. The owner runs a Jev-style model locally in [LM Studio](https://lmstudio.ai) instead. Spike S8 showed that LM Studio's OpenAI-compatible `/v1/responses` endpoint returns token log-probabilities, so a lettered multiple-choice question yields a probability per option. In smoke tests, one choice among YouTube's top three hits made no wrong picks, while one rating per candidate did poorly. The details are in [spike S8](../spikes/local-judge-spike.md).

## Decision

### 1. Opt-in

- `sple import` and `sple migrate` gain `--matcher basic|local`, default `basic`. `basic` is the ADR 0009 chain, unchanged.
- `--matcher local` requires `SPLE_LOCAL_JUDGE_MODEL`, from the environment or `<configDir>/.env`: the model ID as the server lists it (for example `jevk5`). If it is missing or empty, the command fails with a `UsageError` (exit 2) before any request.
- `SPLE_LOCAL_JUDGE_URL` is the server's OpenAI-compatible base URL. The default, `http://localhost:1234/v1`, is LM Studio's.
- `matcher` is saved in the run file's `options` (ADR 0007 Amendment 4, next to `minConfidence` and `cache`). `--resume` rejects `--matcher` like the other start-only flags and resumes with the saved value.

### 2. Placement in the chain

With `--matcher local`, the `metadata` slot (ADR 0009 A2 §1, #4) runs `local` instead. `known-ref`, `cache` and `isrc` are unchanged and still run first, so the judge is only asked about tracks that reach metadata search. `MatchRequest` is unchanged; the engine receives the judge client as an option next to `cache`.

### 3. Algorithm per track

1. **Search:** the same call as `metadata`, `searchTracks({ kind: 'metadata', title, artists, album, durationMs }, { limit: 10 })`. It uses no extra provider quota.
2. **Shortlist:** the first *K* hits in the provider's order. No hits means `null`, and the track is unmatched as today.
3. **Ask:** one request per track. The source track is the state, and there is one lettered option per shortlisted hit plus "None of these is the same recording.". The answer is one letter. Durations are **not** sent.
4. **Read:** each option's probability comes from the first output token's top log-probabilities. If the letters carry less than half of the probability mass, that is a failure (§4).
5. **Combine:**
   - Unless "none" has probability 0.5 or more, the most probable hit wins (ties go to the earlier letter). Its confidence is 1 − p(none): the chance that some shortlisted hit is the right recording. Several uploads of one recording split the probability between them, so a single hit's own probability is too low a measure (S8).
   - If the winner fails the duration check (|Δ| > *D*; a missing duration passes), its confidence is capped at 0.45, which makes it low-confidence at the default threshold.
   - If "none" wins, the strategy returns the A1 `metadata` result for the same hits, with its confidence capped at 0.45. A match the judge disagrees with is kept but flagged for review.
6. **Constants:** *K*, *D*, the cap, the confidence rule, the rule for "none" and the wording are **provisional** and will be filled in from S8. The starting points are K = 3 and D = 10 s. The exact template, rules and test vectors are in ADR 0009 Amendment 3.

### 4. Failures

The judge is an improvement layer. A failure never stops a run or changes provider error handling:

- On any failure, the strategy returns the **`basic` metadata result** for that track (`strategy: 'metadata'`, uncapped) and records `local: <message>` in the result's `error`. That covers a connection error, a timeout (30 s), an HTTP error, and an answer without letters.
- A connection failure (the server isn't running) or an HTTP 404 (the endpoint doesn't exist) also turns the judge off for the rest of the run. One warning is printed the first time the judge fails.
- LM Studio answers an unknown model ID with whatever model is loaded, so sple warns once when the response's `model` differs from the one it asked for.
- Judge errors are never mapped to `RateLimitError`, `QuotaExhaustedError` or `AuthRequiredError`, which ADR 0009 A1 §1.4 treats as run-stopping provider errors.

### 5. Results, cache and report

- `MatchCandidate.strategy` gains `'local'`. A candidate chosen by the judge has `strategy: 'local'`. A fallback after a failure or a "none" keeps `'metadata'`.
- The match cache (ADR 0009 A2) stores `'local'` entries the same way as `'metadata'` entries. The cache key does not depend on the matcher, so a cached `metadata` match is reused under `--matcher local` and vice versa; `--no-cache` forces a fresh decision.
- The report's `strategies[]` lists `local`, and the JSON report gains `matcher` and `judgeModel` (the response's `model` field) at the top level.

### 6. No new dependency

- The request is one `fetch` to `<SPLE_LOCAL_JUDGE_URL>/responses` (OpenAI Responses shape, as LM Studio implements it), so no SDK is added and `engines.node` stays `>=20`.
- There is no API key and no retry; the timeout is 30 s.
- Tests inject `fetch` and never call the network.
- Any server that implements `/v1/responses` with `top_logprobs` works, whatever the model. The tested setup is LM Studio with `jevk5` (spike S8). LM Studio's own chat and completions endpoints don't return log-probabilities.
- ADR 0009's "No External Dependencies" is about fuzzy-matching libraries in the scorer. The `basic` scorer and its A1 §5 test vectors stay exactly as they are.

## Alternatives considered

1. **TypeSafe Jev, hosted.** Typed questions with probabilities, dated model IDs, $0.042 per 1M input tokens. Rejected by the owner (2026-10-14) because it needs a separate subscription. TypeSafe publishes no weights, so it can't run locally.
2. **OpenAI Decisions API** (`/v1/decisions`, `gpt-6-luna`, public beta). The same capability through the official SDK, but it needs Node ≥ 22. Rejected because the owner has no OpenAI API key.
3. **One rating per candidate** (a three-level score: different song, other version, same recording). This was the design for options 1 and 2. In S8's smoke test the local model got 3–5 of 10 right, and it rated different songs as "versions".
4. **Ordering the shortlist by the A1 score** instead of provider order. Kept as an S8 run (`local-a1`). Provider order is simpler and is what a person would look at.
5. **Judge only unmatched and low-confidence tracks.** Fewest calls, but it can't catch a confident wrong match (a live or cover video that scores high), which is the error users mind most.
6. **Replace the scorer.** Every import would then need a running model server, and the A1 §5 vectors would no longer be deterministic across models.
7. **Generated text (chat completions, JSON output).** No probabilities, so no confidence. Thinking models also need a token budget.

## Consequences

- With `--matcher basic`, nothing changes: no new requests, the same results, the same privacy statement, the same Node minimum.
- With `--matcher local`, each track that reaches metadata search makes one request to the user's own server. That is about 200 input tokens and 0.35–0.5 s on a GPU (S8). Nothing is billed, and YouTube quota is unchanged.
- Results depend on whichever model the user loads. The report records `judgeModel`, and S8's numbers apply only to the model they were measured with.
- `MatchCandidate.strategy`, the match-cache schema, the run file and the JSON report each gain one value or field. Ports must implement the prompt template and the combination rule (A3 §3–4) exactly; model answers are mocked in tests.

## Risks

| Risk | Mitigation |
|---|---|
| **Privacy.** Track metadata (the user's titles and artists, and YouTube result titles) goes to the server at `SPLE_LOCAL_JUDGE_URL`. By default that is `localhost`, but a user can point it at another machine. | Opt-in only. No tokens, account IDs, provider refs or durations are sent. PRIVACY.md states what is sent and that it goes only to the server the user configures (below). |
| **YouTube Policies III.E.4.h** ("must not … use API Data to create new or derived data or metrics") and III.E.3.b. | Search results are not the user's Authorized Data. The model's answer is used only to choose a match, the same way the `basic` score is, and is stored only as the match confidence under the existing 30-day cache rule. **Closed by owner decision (2026-10-14):** sple is for personal use, and with the default `localhost` server the data never leaves the user's computer, so this does not block acceptance. |
| Unknown model provenance and calibration (`jevk5` is a community build). | S8 measures false accepts against hand labels. The cap and the "none" rule keep doubtful picks below the default threshold. `basic` stays the default. |
| Lower accuracy on non-English titles. | S8 includes at least 20 non-English tracks. |
| Prompt injection through video titles. | Titles are untrusted. Each title is a JSON string inside a lettered option, so a newline can't start a new option. The duration check runs in code, and a wrong match still shows its confidence and is listed in the report. |
| LM Studio's API changes, or another server reads the request differently. | Failures fall back to `basic` (§4). The request uses only documented Responses fields. |

## Amendments to other ADRs

These amendments were written with this ADR and are also **Proposed**. They take effect together when this ADR is accepted.

| ADR | Amendment | What it adds |
|---|---|---|
| [0009](0009-matching-strategy.md#amendment-3-local-judge-matcher-proposed-with-adr-0011) | Amendment 3 | The `local` strategy spec for ports: shortlist, prompt template, probability readout, combination rule, errors, cache, report and test vectors. Narrows "No External Dependencies" to the `basic` scorer |
| [0003](0003-provider-interface-and-capabilities.md#amendment-4-local-judge-matcher-proposed-with-adr-0011) | Amendment 4 | `'local'` in `MatchCandidate.strategy` |
| [0004](0004-token-store-and-config.md#amendment-2-local-judge-matcher-proposed-with-adr-0011) | Amendment 2 | The `SPLE_LOCAL_JUDGE_URL` and `SPLE_LOCAL_JUDGE_MODEL` variables |
| [0007](0007-cli-conventions.md#amendment-7---matcher-proposed-with-adr-0011) | Amendment 7 | `--matcher` usage, validation, the run-file option, stderr lines and help |
| [0002](0002-youtube-music-provider.md#amendment-6-youtube-data-and-the-local-judge-matcher-proposed-with-adr-0011) | Amendment 6 | What YouTube data is sent and where, the Developer Policies reading (the III.E.4.h question), quota unaffected |

## On acceptance

When S8 passes, in the PR that flips this ADR to Accepted:

1. Set the final K, D, cap, "none" rule and wording in ADR 0009 Amendment 3 (§2–4 and the §7 vectors), and mark the five amendments above Accepted.
2. **requirements.md:**
   - FR-MIG-2 mentions the optional local judge (ADR 0009 Amendment 3).
   - NFR-9's "no data is sent to any `sple` server" still holds, and the local-judge disclosure is added next to it.
   - Spike S8 is marked resolved.

In the implementation PR:

3. **docs/PRIVACY.md** (YouTube Developer Policies III.A.2.e; it must ship with the feature). Add roughly: "**Optional: local matching.** If you run `import` or `migrate` with `--matcher local`, sple sends the title, artists and album of each track it needs to search for, together with the titles and artists of the top search results, to the model server at `SPLE_LOCAL_JUDGE_URL` (by default `http://localhost:1234/v1`, a server on your own computer such as LM Studio). Nothing else is sent: no tokens, account IDs, playlist names or durations. If you point it at another machine, the data goes there. Without `--matcher local`, nothing is sent."
4. **docs/dev/matching-strategy.md:** this page is already stale (the old candidate shape, and its claim that strategies swallow quota errors). Rewrite it against ADR 0009 A1–A3.
5. **User docs:** setting up LM Studio (load a model, switch Repeat Penalty off, start the server; from WSL use the Windows host's address).

If S8 fails, mark this ADR and the five amendments **Rejected**, with S8's numbers as the reason.

## Sources

- [Spike S8](../spikes/local-judge-spike.md) and the documentation it cites (read 2026-10-14).
- [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.A.2.e, III.E.3.b, III.E.4.
