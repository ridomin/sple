# Spike S8 harness: a local decision model as a match judge

Scripts for running the [S8 evaluation](../../../docs/spikes/local-judge-spike.md#evaluation-protocol-to-run) of [ADR 0011](../../../docs/adr/0011-local-match-judge.md).
They are never shipped and never run in CI. `tsc` skips them (`rootDir`/`include` is `src/`). The pure parts (`judge.ts`, `metrics.ts`) are unit-tested in `tests/scripts/decisions-*.test.ts`, including the ADR 0009 Amendment 3 §7 vectors.

The judge talks to an OpenAI-compatible server through `POST <url>/responses`. The tested setup is LM Studio. No package is added and no API key is used.

## Data handling

- The fixture (`fixture.json`: source tracks, YouTube hits, your labels) and the response cache (`responses.json`) live in `<configDir>/spikes/s8/`, outside the repo. On Linux that is `~/.config/sple/spikes/s8/`. Use `--dir` to put them somewhere else.
- **Delete the directory within 30 days of collection** (YouTube API Developer Policies III.E.4). Every script prints a reminder from day 25: `rm -rf ~/.config/sple/spikes/s8`.
- `evaluate.ts` prints counts and rates only. Paste them into the spike report; never paste titles or video IDs.
- Prompts carry only titles, artists and albums (ADR 0009 A3 §3), and they go only to your server. The response cache stores only the answer token's top log-probabilities.

## LM Studio

1. Load the model (for example `jevk5`) and start the server (Developer tab).
2. In the model's settings, switch **Repeat Penalty** off. The server ignores it per request.
3. From WSL, use the Windows host's address instead of `localhost`: `ip route show default | awk '{print $3}'` gives it (for example `172.19.192.1`).
4. Check that it answers: `curl http://<host>:1234/v1/models`.

## Run

```sh
# 1. Export one or two Spotify playlists (protocol step 1)
sple export "<playlist>" --provider spotify -o s8-a.json

# 2. Save each track's YouTube hits. Uses 1 of the 100 daily searches per track; rerun the next day to continue.
sple auth login --provider youtube-music
npx tsx scripts/spikes/decisions/collect.ts s8-a.json s8-b.json --max-tracks 150

# 3. Label every (track, hit) pair. Saves on every key press; rerun to continue.
npx tsx scripts/spikes/decisions/label.ts

# 4–6. Check the request count, then run everything
export SPLE_LOCAL_JUDGE_URL=http://172.19.192.1:1234/v1 SPLE_LOCAL_JUDGE_MODEL=jevk5
npx tsx scripts/spikes/decisions/evaluate.ts --dry-run
npx tsx scripts/spikes/decisions/evaluate.ts > s8-results.md
```

### collect.ts

`<export.json|csv>... [--max-tracks 150] [--dir <dir>] [--target youtube-music]`

- Runs exactly the `metadata` search (`limit: 10`) once per source track and saves the hits in provider order.
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

`[--model <id>] [--url <base>] [--k 3,5] [--d 5,10,15] [--none unmatched,basic,capped] [--confidence any,pick] [--cap 0.45] [--skip-a1] [--skip-score] [--skip-repeat] [--concurrency 1] [--dry-run] [--dir <dir>]`

- `--model` and `--url` default to `SPLE_LOCAL_JUDGE_MODEL` and `SPLE_LOCAL_JUDGE_URL`, from the environment or the sple `.env`. The URL defaults to `http://localhost:1234/v1`.
- Evaluates only tracks whose hits are all labelled.

Runs:

| Run | What it does |
|---|---|
| `basic` | The A1 `MetadataStrategy` scoring over the saved hits |
| `local-any`, `local-pick` | The A3 judge for every K × D × "none" rule × confidence rule: one lettered choice among the first K hits plus "none" |
| `local-…-a1` | The best setting, with the top K taken in A1 score order |
| `local-score` | The best setting with the earlier design: one three-level rating per candidate, shortlisted by the relaxed A1 gate |
| `local-… (repeat)` | The best setting again with fresh requests, to confirm the answers are deterministic |

- The best setting is the one with the most correct accepts at 0.5 among those with no more false accepts than `basic`.
- **Confidence rules:**
  - `any`, the provisional default: 1 − p(none), the chance that some shortlisted hit is the recording. The most probable hit wins unless p(none) ≥ 0.5.
  - `pick`: the winning letter's own probability. It suffers when several uploads of the same recording split the probability (21-track check: 0% correct against 81% for `any`).
- **"none" rules:** `unmatched` gives no match. `basic` uses the A1 result. `capped` uses the A1 result capped at `--cap` (the ADR's provisional rule).
- Responses are cached by request body in `responses.json`. D, the cap and the "none" rule only change the combination, so the grid makes one request per track per K, and reruns are instant. The repeat is never cached.
- A failed request falls back to `basic` for that track and counts under **Failures**. If the server is unreachable or returns 404, the run stops (exit 1) and the responses so far are kept.

Measures (protocol step 5), as a share of evaluated tracks:

- **Correct accept:** `matched`, and the chosen hit is labelled `same`.
- **False accept:** `matched`, and the chosen hit is labelled `version` or `different`.
- **Low-conf:** a candidate below `minConfidence`.
- **Missed `same`:** `unmatched` although some hit is labelled `same`.
- **Failures:** tracks where the judge failed.
- **Time/track:** the mean judge latency per track, as first measured. Cached runs repeat it.
