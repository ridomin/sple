# OpenAI Decisions match-judge spike (S8)

- **Date:** 2026-10-14 (research); evaluation not yet run
- **Status:** Research done; **evaluation pending** (needs the owner's `OPENAI_API_KEY`)
- **Related:** [ADR 0011](../adr/0011-openai-decisions-match-judge.md) (Proposed), [ADR 0009 Amendment 1 §4](../adr/0009-matching-strategy.md#4-metadata-score) (metadata score), [ADR 0002](../adr/0002-youtube-music-provider.md) (YouTube quota and policies), [requirements FR-MIG-2, NFR-9](../requirements.md)
- **Data handling:** results record counts and rates only. Labelled pairs (titles, artists, video IDs) stay in a local fixture outside the repo, and that fixture is deleted within 30 days (YouTube API Developer Policies III.E.4).

| Question | Status | Decision |
|---|---|---|
| Can the OpenAI Decisions API judge "same recording?" for a Spotify track and a YouTube hit? | Researched | Yes, in principle. A 3-level `score` question per candidate (see below) |
| Does it beat the ADR 0009 scorer on Spotify → YouTube? | **Not run** | Gate for accepting ADR 0011 |
| Shortlist size K, relaxed gate, duration tolerance D, variant cap | **Not run** | Filled in from the evaluation |
| One request per track vs one request per pair | **Not run** | Filled in from the evaluation |

## Why

The metadata strategy ([ADR 0009 A1 §4](../adr/0009-matching-strategy.md#4-metadata-score)) scores word overlap on titles and artists plus a ±5 s duration check. On Spotify → YouTube it is weakest where YouTube data is noisy:

- `searchTracks` returns videos. Their titles look like `Artist - Song (Official Video)` and `Song (Lyrics)`, and the artist is guessed from the video title or the channel name (`src/providers/youtube-music/track-metadata.ts`).
- YouTube hits have no album and no ISRC, so the only signals are title, guessed artist and duration.
- Covers, live recordings, karaoke, sped-up and lyric re-uploads share most title words with the original. Live and remix words lower the score (A1 §3) but don't reject the hit (A1 §5, last test vector).

The scorer can't tell "same song, different recording" from "same recording", and it rejects correct hits whose artist parse failed (`a = 0`).

## What the Decisions API is

The [Decisions API](https://developers.openai.com/api/docs/guides/decisions) is an OpenAI endpoint that answers typed questions about an input with probabilities instead of generated text. It was previewed at DevDay (2026-09-29) and has been in **public beta since 2026-10-06**; OpenAI expects general availability "in the coming weeks".

- **Endpoint:** `POST https://api.openai.com/v1/decisions`, authenticated with `Authorization: Bearer $OPENAI_API_KEY`.
- **Request:** `{ model, input, questions, safety_identifier? }`.
  - `input` is a text string, or user messages with `input_text` and `input_image` parts. It is **not** a JSON object, so sple sends its state as a JSON string.
  - `questions` is an **array**. Each question has `type`, `instructions` and an optional unique `name`.
- **Question types** (from the `openai` SDK types, `resources/decisions.d.ts`, v7.33.0):

| Type | Extra fields | Answer |
|---|---|---|
| `predicate` | – | `probability`, 0–1, with no `confidence` |
| `choice` | `choices`: 2–255 items of `{ value: string \| boolean, description? }` | `choice`, `probabilities: [{ value, probability }]`, `confidence` |
| `score` | `levels`: ordered `{ label, description? }`, lowest first | `score` (the probability-weighted mean of the zero-based level indices, so 0–2 for three levels), `probabilities: [{ value, label, probability }]`, `confidence` |
| `refusal` (answer only) | – | `{ type: 'refusal', name }`: this question wasn't answered, but the others in the request still are |

- **Response:** `{ answers, model, usage: { input_tokens, output_tokens, total_tokens, … } }`. `answers` comes back in the order the questions were asked, and each answer echoes its `name`.
- **Model:** `gpt-6-luna` is the only supported model. **No dated snapshot is published**, so the model behind the name can change without notice. sple logs the response's `model` field.
- **Price:** $0.10 per 1M input tokens, with no output, cache-read or cache-write charges. Regional-processing and long-context surcharges apply.
- **Rate limits (gpt-6-luna, default tiers):** 5,000 requests/min and 2M tokens/min on Build. sple matches one track at a time, far below that.
- **Data controls ([your data](https://developers.openai.com/api/docs/guides/your-data)):**
  - API data is **not used for training** unless the organization opts in.
  - `/v1/decisions` keeps abuse-monitoring logs for **30 days** and stores no application state, apart from prompt-cache tensors held for up to 24 h.
  - Zero data retention is available to eligible customers, with limitations. US and EU data residency are available.
- **JS SDK:** [`openai`](https://www.npmjs.com/package/openai), v7.30.0 or later (7.33.0 today). Apache-2.0 licence, no runtime dependencies, **Node ≥ 22**. Call it as `client.decisions.create({ model, input, questions })`.
  - **Defaults:** `maxRetries` 2 (on connection errors, 408, 409, 429 and 5xx, or when the server sends `x-should-retry`), and a **10-minute** timeout per attempt. sple sets its own values for both (ADR 0011 §6).
  - **Environment variables the SDK reads:** `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_LOG`, `OPENAI_CUSTOM_HEADERS`.
  - **Errors:** all are `APIError` subclasses: `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `RateLimitError` (429), `InternalServerError` (5xx), `APIConnectionError` and `APIConnectionTimeoutError`. A 429 whose `error.code` is `insufficient_quota` means the account is out of credit, and retrying won't help.
  - **Node version:** sple's `engines.node` moves from `>=20` to `>=22`. CI already tests only 22.x and 24.x, and Node 20 reached end-of-life on 2026-04-30.

### Unknowns and how the design handles them

The guide does not cover calibration, ordering bias, language coverage or per-request limits (one third-party summary mentions 200 questions per request). Treat all of them as unknown until S8 measures them:

| Unknown or weakness | Design response |
|---|---|
| Calibration of `probabilities` is unpublished; the guide says to "set thresholds with labeled examples from your application" | S8 sets the cap and checks false accepts against labels; nothing is accepted on the model's word alone |
| LLM judges compare numbers poorly | Durations are compared **in code** and never sent |
| Possible bias towards the first option in a `choice` | One `score` question per candidate, not a choice over the list |
| Irrelevant input lowers accuracy | Shortlist in code first; send only title, artists and album |
| Non-English titles | The evaluation set includes them; see the protocol |
| Prompt injection through video titles | Titles are untrusted. Duration and artist checks in code limit the damage, and the worst case is a wrong match, which `minConfidence` and the report already surface |
| Refusals | A refusal on any question makes sple fall back to `basic` matching for that track |
| No pinned snapshot; the API is in beta | The model ID is recorded in the report; S8 is rerun when the model or the contract changes; `basic` stays the default |

### Compared with TypeSafe Jev (the first proposal)

[Jev](https://docs.typesafe.ai/introduction) has the same three question types (its `noul` is OpenAI's `predicate`) and a closely matching request shape. It also publishes dated model IDs (`jev-1.13.0`) and a list of known weaknesses. It was dropped because it needs a separate TypeSafe subscription (owner decision, 2026-10-14). The Decisions API uses the OpenAI account the owner already has. It costs $0.10 per 1M input tokens against Jev's $0.042, and it has no pinned snapshot.

## Proposed request

One request per track. The input is a JSON string holding the source track and the shortlisted candidates. There is one `score` question per candidate, named after it.

```json
{
  "model": "gpt-6-luna",
  "input": "{\"source\":{\"service\":\"Spotify\",\"title\":\"Hello\",\"artists\":[\"Adele\"],\"album\":\"25\"},\"candidates\":{\"c1\":{\"service\":\"YouTube Music\",\"title\":\"Adele - Hello (Official Music Video)\",\"artists\":[\"Adele\"]},\"c2\":{\"service\":\"YouTube Music\",\"title\":\"Hello - Adele (Live at the BBC)\",\"artists\":[\"Adele\"]},\"c3\":{\"service\":\"YouTube Music\",\"title\":\"Adele - Hello (Cover by J.Fla)\",\"artists\":[\"J.Fla\"]}}}",
  "questions": [
    {
      "type": "score",
      "name": "c1",
      "instructions": "The input is JSON with a source track and candidate tracks. How does candidate c1 relate to the source track as a recording? Ignore words that only describe the upload, such as 'Official Video', 'Lyrics', 'Audio', 'HD' or a channel suffix like 'VEVO' or '- Topic'.",
      "levels": [
        { "label": "different", "description": "A different song." },
        { "label": "version", "description": "The same song but a different recording or version: live, remix, cover, acoustic, instrumental, karaoke, sped up or slowed, or re-recorded." },
        { "label": "same", "description": "The same recording as the source; only the upload's packaging differs." }
      ]
    },
    { "type": "score", "name": "c2", "...": "same question for c2" },
    { "type": "score", "name": "c3", "...": "same question for c3" }
  ]
}
```

Durations are deliberately left out of the input. Code applies the duration check afterwards.

**Combining (ADR 0011 §3.5).**
- For each candidate, `level = round(score)`, and `p2` is the probability of the level whose `value` is 2.
- A candidate is eligible when its level is 2 and it passes the duration check. Its confidence is `p2`.
- A candidate that fails the duration check, or rounds to level 1, has its confidence capped at 0.45, so it is low-confidence at the default threshold.
- The best eligible candidate wins. Ties go to the earlier hit in the provider's order.
- The exact rules and test vectors are in [ADR 0009 Amendment 3](../adr/0009-matching-strategy.md#amendment-3-openai-decisions-matcher-proposed-with-adr-0011).

**Cost estimate.** About 150 tokens for the source plus about 150 per candidate (input and question). With K = 5 that is roughly 1K input tokens per track: **about $0.10 per 1,000 tracks**. The Decisions API uses no YouTube quota, and the search is the same call the metadata strategy already makes.

## Evaluation protocol (to run)

1. **Dataset.** Pick 150 Spotify tracks from one or two of the owner's playlists (`sple export`). The set should include at least 20 non-English titles, 15 tracks with live or remix versions in the catalogue, and 15 tracks whose artist name differs between services ("The Beatles" vs "Beatles", featured artists).
2. **Hits.** Run the YouTube `searchTracks` call once per track with `limit: 10`. That is 150 searches, about 2 days of the 100-searches-per-day bucket. Save each track's hits to a local fixture outside the repo (path under the config directory), so that every later step is offline for YouTube.
3. **Labels.** Hand-label every (track, hit) pair as `same`, `version` or `different`. A track's correct answer is any `same` hit, or "none" if there isn't one.
4. **Runs.** All runs are offline against the fixture:
   - `basic`: today's `MetadataStrategy` scoring.
   - `openai`: K ∈ {3, 5, 8} × D ∈ {5, 10, 15} s, relaxed gate = `t > 0 || a > 0`.
   - `openai-pair`: the best setting, but one request per (track, candidate) pair.
   - Repeat the best `openai` run once to check stability, and record `model` and the date. With no snapshot to pin, the date matters.
5. **Measures,** each at `minConfidence` 0.5 (the default) and 0.8:
   - correct accept: `matched` and labelled `same`;
   - **false accept**: `matched`, labelled `version` or `different`, or the track has no `same` hit;
   - low-confidence rate;
   - unmatched-but-had-a-`same`-hit rate;
   - refusals;
   - input tokens and wall time.
6. **Pass bar for ADR 0011:** false accepts ≤ `basic` **and** correct accepts at least 10 points above `basic` at the default threshold. If it fails, ADR 0011 is Rejected and this doc records why.

## Results

_Not run yet._

| Run | K | D (s) | Correct accept | False accept | Low-conf | Missed `same` | Refusals | Tokens | Time |
|---|---|---|---|---|---|---|---|---|---|
| basic | – | 5 | | | | | – | – | |

**Model and date:** –  
**Decision:** pending.

## Sources

- OpenAI: [Decisions guide](https://developers.openai.com/api/docs/guides/decisions), [gpt-6-luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna), [your data](https://developers.openai.com/api/docs/guides/your-data). All read 2026-10-14.
- npm: `openai` 7.33.0: `resources/decisions.d.ts` (request and response types), `client.js` (retry and timeout defaults, environment variables), `engines.node >=22.0.0`.
- Third-party summaries (not authoritative): [promptfoo provider docs](https://www.promptfoo.dev/docs/providers/openai-decisions/), [Jev vs Decisions comparison](https://befailproof.ai/jev/vs-openai-decisions-api/).
- TypeSafe Jev, the alternative considered: [docs](https://docs.typesafe.ai/introduction), [models](https://docs.typesafe.ai/models).
- [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.A.2.e, III.E.4.
