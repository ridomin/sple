# Local match-judge spike (S8)

- **Date:** 2026-10-14 (research and smoke tests); evaluation not yet run
- **Status:** Smoke tests done against a local model in LM Studio; **evaluation pending** (needs the labelled fixture)
- **Related:** [ADR 0011](../adr/0011-local-match-judge.md) (Proposed), [ADR 0009 Amendment 1 §4](../adr/0009-matching-strategy.md#4-metadata-score) (metadata score), [ADR 0009 Amendment 3](../adr/0009-matching-strategy.md#amendment-3-local-judge-matcher-proposed-with-adr-0011) (the spec), [ADR 0002](../adr/0002-youtube-music-provider.md) (YouTube quota and policies), [requirements FR-MIG-2, NFR-9](../requirements.md)
- **Data handling:** results record counts and rates only. Labelled pairs (titles, artists, video IDs) stay in a local fixture outside the repo, and that fixture is deleted within 30 days (YouTube API Developer Policies III.E.4). The smoke-test cases below are hand-written from well-known songs, not YouTube API data.

| Question | Status | Decision |
|---|---|---|
| Which judge? | Decided 2026-10-14 | A local decision model served by LM Studio, chosen by the owner. Hosted Jev and OpenAI Decisions were dropped (see [History](#history)) |
| Can a local model in LM Studio return per-answer probabilities? | **Yes** (smoke test) | Only through `POST /v1/responses` with `top_logprobs`; see [LM Studio findings](#lm-studio-findings) |
| Question shape: one rating per candidate, or one choice among the top hits? | **Choice** (smoke test) | One choice among the provider's top 3 plus "none". Per-candidate ratings scored 3–5/10; the choice made no wrong picks |
| Does it beat the ADR 0009 scorer on Spotify → YouTube? | **Not run** | Gate for accepting ADR 0011 |
| K, D, the cap and what "none" does | **Not run** | Filled in from the evaluation |

## Why

The metadata strategy ([ADR 0009 A1 §4](../adr/0009-matching-strategy.md#4-metadata-score)) scores word overlap on titles and artists plus a ±5 s duration check. On Spotify → YouTube it is weakest where YouTube data is noisy:

- `searchTracks` returns videos. Their titles look like `Artist - Song (Official Video)` and `Song (Lyrics)`, and the artist is guessed from the video title or the channel name (`src/providers/youtube-music/track-metadata.ts`).
- YouTube hits have no album and no ISRC, so the only signals are title, guessed artist and duration.
- Covers, live recordings, karaoke, sped-up and lyric re-uploads share most title words with the original. Live and remix words lower the score (A1 §3) but don't reject the hit (A1 §5, last test vector).

The scorer can't tell "same song, different recording" from "same recording", and it rejects correct hits whose artist parse failed (`a = 0`).

## History

1. **TypeSafe Jev, hosted** (first proposal, commit `d7a89dd`). Jev is a "decision" model: you send a state and typed questions (`noul`, `choice`, `score`) and get probabilities back, from `POST https://api.typesafe.ai/v1/systemone`. Dropped because it needs a TypeSafe subscription. TypeSafe publishes **no downloadable weights**; Jev is API-only ([models](https://docs.typesafe.ai/models)).
2. **OpenAI Decisions API** (commit `eb12300`). The same idea as Jev (`POST /v1/decisions`, `gpt-6-luna`, public beta). Dropped because the owner has no OpenAI API key.
3. **A local decision model in LM Studio** (this report). No account, no key, and no data leaves the machine. The owner loaded `jevk5`, a community GGUF in the Jev style.

## The model tested

| | |
|---|---|
| LM Studio ID | `jevk5` |
| Publisher (LM Studio metadata) | `alibiserikbay`. Not TypeSafe, and not the [`openjev/openjev-GGUF`](https://huggingface.co/openjev/openjev-GGUF) build. Provenance and training prompt format unknown |
| Architecture, quantization | `qwen35` (27B class), `Q8_0`, loaded with an 8K context |
| Runtime | LM Studio, `llama.cpp-win-x86_64-nvidia-cuda-avx2` 2.56.0 on the owner's Windows host |

OpenJev, the closest documented relative, is an independent project with a CC BY-NC 4.0 licence. Its model card uses a lettered-options prompt (`State:` / `Question:` / `Options: [A] …` / "Answer with the letter of the best option only.") and reads the letter probabilities at the first output token. Yes/no questions are lettered `[A] yes` / `[B] no`. sple uses the same shape, so it works with any instruction model, not just this one.

## LM Studio findings

| Finding | Consequence for sple |
|---|---|
| From WSL the server is at the Windows host's address (`http://172.19.192.1:1234`), not `localhost` | `SPLE_LOCAL_JUDGE_URL` is configurable. The default `http://localhost:1234/v1` suits native installs |
| `/v1/chat/completions` and `/v1/completions` return `"logprobs": null` even when asked | Not usable |
| `POST /v1/responses` with `top_logprobs: 20` and `include: ["message.output_text.logprobs"]` returns the top 20 tokens at each output position | The only endpoint sple uses |
| `chat_template_kwargs.enable_thinking: false` is ignored, and the model starts with `<think>` | Send `reasoning: { effort: "none" }`; the first output token is then the answer letter |
| The answer appears as `A` or `[A` (about 10% of the mass on `[A`) | A letter's probability sums every top token that is the letter after trimming and removing a leading `[` |
| The model preset's Repeat Penalty (reported as `frequency_penalty: 1.1`) can't be overridden per request, not even with `0` or `1e-6` | Users should switch Repeat Penalty off in LM Studio. Turning it off (1) didn't change the smoke results |
| An unknown model ID is not an error: the server answers with whichever model is loaded, and the response's `model` field names it | A typo in `SPLE_LOCAL_JUDGE_MODEL` would quietly use another model. sple prints one warning when the answering model differs (ADR 0009 A3 §5) |
| With the model partly on the CPU: about 6 s per question. Fully on the GPU: **0.35–0.5 s** | About 1 minute per 150 tracks with one question per track |

## Smoke tests (2026-10-14)

All of these are hand-written cases with `temperature: 0`. They check feasibility; the evaluation below decides.

### 1. One rating per candidate (the earlier design): poor

Ten (source, candidate) pairs: official video, live, cover, a different Adele song, a `- Topic` upload, a lyric upload, a VEVO upload with "ft.", a remix, a Japanese official video, and a same-titled song by another artist.

| Format | Correct |
|---|---|
| Three levels (different / version / same), as in the OpenAI design | 4/10 |
| The same levels in reverse order | 3/10 |
| Two yes/no questions (same song? same recording?) | 5/10 |

The three-level format put most of the mass on the middle option ("version") for almost everything. It rated Lionel Richie's "Hello" against Adele's at p(different) = 0.04, and "Someone Like You" against "Hello" at 0.01. The yes/no answers hovered around 0.5.

### 2. Sanity check: the readout works, the music knowledge is weak

| Question | Answer |
|---|---|
| `{order: {paid: true}}`, "Has the order been paid?" `[A] yes [B] no` | A, p = 0.96 |
| The same with the options swapped | B, p = 0.98: it follows the meaning, not the position |
| Two support tickets: billing / shipping / login problem | correct, p = 0.98 and 0.99 |
| "Hello by Adele" vs "Hello by Adele": same song? | yes, but only p = 0.65 |
| "Hello by Adele" vs "Bohemian Rhapsody by Queen": same song? | no, but only p = 0.76 |

The probability readout is sound, but the model is unsure about whether two recordings are the same.

### 3. One choice among the top 3 (the owner's proposal): promising

Six realistic top-3 result sets for an artist + title search, each with a "none of these" option, each asked in all three rotations of the candidate order (18 questions):

| Source | Top 3 (correct in bold) |
|---|---|
| Hello, Adele | Live at the BBC · **Official Music Video** · cover by J.Fla |
| Despacito, Luis Fonsi & Daddy Yankee | Remix ft. Justin Bieber · **Luis Fonsi - Despacito ft. Daddy Yankee (VEVO)** · karaoke |
| 夜に駆ける, YOASOBI | THE FIRST TAKE · **Official Music Video** · English cover |
| Hello, Lionel Richie | Adele - Hello · **Official Music Video** · **lyric upload** |
| Yesterday, The Beatles | live at Blackpool · guitar cover · karaoke (correct answer: none) |
| Bohemian Rhapsody, Queen | Live Aid 1985 · Panic! At The Disco · **Official Video Remastered** |

| Measure | Result |
|---|---|
| Correct | 10/18 (56%) |
| **Wrong recording picked** | **0**. It never chose a live, cover, remix or karaoke upload, or another artist's song |
| "None" when nothing matched | 3/3 |
| Same pick in all three rotations | 5/6 sets, so no sign of position bias |
| Speed | 0.36 s per track (one question) |

All eight errors were "none" when a correct upload was present:
- Despacito: the VEVO upload with "ft." in the title was missed.
- Lionel Richie: two correct uploads split the probability, so "none" won.
- Bohemian Rhapsody: a close call (0.37–0.57 against 0.34–0.45 for none).

Correct picks had p = 0.5–0.7.

### 4. Harness check: end to end on a 6-track sample

The six sets above went through the full harness as a hand-labelled fixture: 22 runs in 15 s, no failures. This checks the pipeline; it is not evaluation data.

- **The fresh repeat matched exactly:** 0 changed picks, and the largest confidence change was 0.0003. Answers are deterministic at `temperature: 0`.
- **`basic` matched none of the six.** YouTube-style titles fail the A1 title rule.
- **Official music videos often fail the duration check.** Intros and outros make them longer than the album track (Adele's video runs 367 s against the album's 295 s), so a correct pick is capped to low-confidence. The D sweep has to measure what this costs.

**Outcome:** the design moves to one choice among the provider's top K. A wrong pick is rare, while "none" is common. So what "none" does with the `basic` result is the main thing the evaluation must settle (ADR 0009 A3 §4).

## Proposed request

One request per track to the user's server (`SPLE_LOCAL_JUDGE_URL`, default `http://localhost:1234/v1`). The exact template is in [ADR 0009 Amendment 3 §3](../adr/0009-matching-strategy.md#3-judge-request).

```json
{
  "model": "jevk5",
  "input": "State:\n{\"source\":{\"service\":\"Spotify\",\"title\":\"Hello\",\"artists\":[\"Adele\"],\"album\":\"25\"}}\n\nQuestion: Which candidate is the same recording as the source track? …\nOptions:\n[A] \"Adele - Hello (Live at the BBC)\" by Adele\n[B] \"Adele - Hello (Official Music Video)\" by Adele\n[C] \"Adele - Hello (Cover by J.Fla)\" by J.Fla\n[D] None of these is the same recording.\n\nAnswer with the letter of the best option only.",
  "max_output_tokens": 2,
  "temperature": 0,
  "top_logprobs": 20,
  "include": ["message.output_text.logprobs"],
  "reasoning": { "effort": "none" }
}
```

Durations are left out, and code compares them afterwards. **Cost:** about 200 input tokens per track, nothing billed, no YouTube quota beyond the search `metadata` already makes.

## Evaluation protocol (to run)

The harness in `scripts/spikes/decisions/` (branch `spike/s8-decisions-harness`) runs each step: `collect.ts` (step 2), `label.ts` (step 3) and `evaluate.ts` (steps 4–6). `evaluate.ts` prints the results tables below, ready to paste.

1. **Dataset.** Pick 150 Spotify tracks from one or two of the owner's playlists (`sple export`). The set should include at least 20 non-English titles, 15 tracks with live or remix versions in the catalogue, and 15 tracks whose artist name differs between services ("The Beatles" vs "Beatles", featured artists).
2. **Hits.** Run the YouTube `searchTracks` call once per track with `limit: 10`. That is 150 searches, about 2 days of the 100-searches-per-day bucket. Save each track's hits in provider order to a local fixture outside the repo, so every later step is offline for YouTube.
3. **Labels.** Hand-label every (track, hit) pair as `same`, `version` or `different`. A track's correct answer is any `same` hit, or "none" if there isn't one.
4. **Runs.** All runs are offline against the fixture, with the model ID and LM Studio settings recorded:
   - `basic`: today's `MetadataStrategy` scoring.
   - `local`: K ∈ {3, 5} × D ∈ {5, 10, 15} s × the "none" rule ∈ {unmatched, basic, basic capped at 0.45}.
   - `local-a1`: the best `local` setting, but with the top K taken in A1 score order instead of provider order.
   - `local-score`: the per-candidate three-level rating (the earlier design), for comparison.
   - Repeat the best run once to confirm the answers are deterministic at `temperature: 0`.
5. **Measures,** each at `minConfidence` 0.5 (the default) and 0.8:
   - correct accept: `matched`, and the chosen hit is labelled `same`;
   - **false accept**: `matched`, and the chosen hit is labelled `version` or `different`;
   - low-confidence rate;
   - missed `same`: unmatched although some hit is labelled `same`;
   - judge failures, and the time per track.
6. **Pass bar for ADR 0011:** false accepts ≤ `basic` **and** correct accepts at least 10 points above `basic` at the default threshold. If it fails, ADR 0011 is Rejected and this doc records why.

## Results

_Evaluation not run yet; smoke tests above._

| Run | K | D (s) | "none" | Correct accept | False accept | Low-conf | Missed `same` | Failures | Time/track |
|---|---|---|---|---|---|---|---|---|---|
| basic | – | 5 | – | | | | | – | – |

**Model, settings and date:** –  
**Decision:** pending.

## Sources

- LM Studio: probed against the owner's server on 2026-10-14 (`/api/v0/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/responses`).
- [openjev/openjev-GGUF](https://huggingface.co/openjev/openjev-GGUF) model card (prompt format and probability readout), read 2026-10-14.
- TypeSafe: [models](https://docs.typesafe.ai/models), [introduction](https://docs.typesafe.ai/introduction). Third-party: [running the Jev pattern locally](https://www.modemguides.com/blogs/ai-news/jev-typesafe-reality-check-run-locally).
- OpenAI: [Decisions guide](https://developers.openai.com/api/docs/guides/decisions) (the alternative dropped).
- [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.A.2.e, III.E.4.
