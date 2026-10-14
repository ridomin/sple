# Spike S8 harness: OpenAI Decisions as a match judge

Scripts for running the [S8 evaluation](../../../docs/spikes/decisions-matching-spike.md#evaluation-protocol-to-run) of [ADR 0011](../../../docs/adr/0011-openai-decisions-match-judge.md).
They are never shipped and never run in CI. `tsc` skips them (`rootDir`/`include` is `src/`). The pure parts (`judge.ts`, `metrics.ts`) are unit-tested in `tests/scripts/decisions-*.test.ts`, including the ADR 0009 Amendment 3 §7 vectors.

`openai` is a **devDependency** here, so `engines.node` and the runtime dependencies stay as they are until ADR 0011 is accepted. The SDK needs Node ≥ 22.

## Data handling

- The fixture (`fixture.json`: source tracks, YouTube hits, your labels) and the response cache (`responses.json`) live in `<configDir>/spikes/s8/`, outside the repo. On Linux that is `~/.config/sple/spikes/s8/`. Use `--dir` to put them somewhere else.
- **Delete the directory within 30 days of collection** (YouTube API Developer Policies III.E.4). Every script prints a reminder from day 25: `rm -rf ~/.config/sple/spikes/s8`.
- `evaluate.ts` prints counts and rates only. Paste them into the spike doc; never paste titles or video IDs.
- Requests to OpenAI carry only titles, artists and albums (ADR 0009 A3 §3). Durations, refs and IDs are never sent.

## Run

```sh
# 1. Export one or two Spotify playlists (protocol step 1)
sple export "<playlist>" --provider spotify -o s8-a.json

# 2. Save each track's YouTube hits. Uses 1 of the 100 daily searches per track; rerun the next day to continue.
sple auth login --provider youtube-music
npx tsx scripts/spikes/decisions/collect.ts s8-a.json s8-b.json --max-tracks 150

# 3. Label every (track, hit) pair. Saves on every key press; rerun to continue.
npx tsx scripts/spikes/decisions/label.ts

# 4–6. Check what it will cost, then run basic, the K × D grid, pair mode and a fresh repeat
npx tsx scripts/spikes/decisions/evaluate.ts --dry-run
OPENAI_API_KEY=sk-... npx tsx scripts/spikes/decisions/evaluate.ts > s8-results.md
```

### collect.ts

`<export.json|csv>... [--max-tracks 150] [--dir <dir>] [--target youtube-music]`

- Runs exactly the `metadata` search (`limit: 10`) once per source track and saves the hits.
- Tracks already in the fixture are skipped. When the search quota runs out, it saves and stops; rerun after the reset.
- `--target fake` with `SPLE_ENABLE_FAKE_PROVIDER=1` exercises the script without spending quota.

### label.ts

`[--relabel] [--dir <dir>]`

Shows the source track and all of its hits, with durations and the difference from the source.

| Key | Label |
|---|---|
| `s` | `same`: the same recording; only the upload's packaging differs (Official Video, Lyrics, Topic channel) |
| `v` | `version`: the same song but another recording (live, remix, cover, acoustic, karaoke, sped up, re-recorded) |
| `d` | `different`: a different song |
| `D` | this hit and the rest of the track's unlabelled hits are `different` |
| `b` | back to the previous pair |
| `q` | save and quit |

### evaluate.ts

`[--k 3,5,8] [--d 5,10,15] [--cap 0.45] [--gate relaxed|none] [--skip-pair] [--skip-repeat] [--concurrency 4] [--dry-run] [--dir <dir>]`

- Evaluates only tracks whose hits are all labelled.
- **basic** is the A1 `MetadataStrategy` scoring over the saved hits.
- **openai** runs the A3 judge for every K × D. The judge falls back to basic on a refusal or a failed request, as the shipped strategy would. D only changes the combination step, so the grid makes one request per track per K.
- The best setting is the one with the most correct accepts at 0.5 among those with no more false accepts than basic. That setting is then rerun as **openai-pair** (one request per candidate) and as **openai (repeat)**, which calls the API again to check stability.
- Responses are cached by request body in `responses.json`, so rerunning the grid (for example with another `--cap`) is free. The repeat is never cached.
- Reads `OPENAI_API_KEY` and `SPLE_OPENAI_DECISIONS_MODEL` from the environment or the sple `.env`, and uses the SDK settings from ADR 0011 §6.
- A 401, 403, 404 or `insufficient_quota` stops the run (exit 1); the responses so far are kept.

Measures (protocol step 5), as a share of evaluated tracks:

- **Correct accept:** `matched`, and the chosen hit is labelled `same`.
- **False accept:** `matched`, and the chosen hit is labelled `version` or `different`.
- **Low-conf:** a candidate below `minConfidence`.
- **Missed `same`:** `unmatched` although some hit is labelled `same`.
- **Refusals:** tracks with a refusal (`+n failed` counts other fallbacks).
- **Tokens:** input tokens.
- **Time:** the sum of request latencies.
