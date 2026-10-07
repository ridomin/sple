# Logging and debugging

By default sple prints only results (stdout) and errors, warnings and summaries (stderr). Two flags and the `DEBUG` variable add diagnostic lines on **stderr**, so they never mix with `--json` or piped output. The contract is [ADR 0007](../adr/0007-cli-conventions.md) §6 and A11.

## Flags

| Flag | Shows |
|---|---|
| *(none)* | Nothing extra, unless `DEBUG` is set |
| `--verbose` | What sple is doing: the selected provider and command, playlists resolved, files read and written, and how many tracks are being matched. Equivalent to `DEBUG=sple:*,-sple:http*`. |
| `--debug` | Everything from `--verbose`, plus one line per HTTP request attempt (method, path, status, duration, retries). Equivalent to `DEBUG=sple:*`. |

```console
$ sple --debug playlist list --provider youtube-music
sple:cli provider=youtube-music command=playlist
sple:http GET /youtube/v3/playlists?part=snippet%2CcontentDetails%2Cstatus&mine=true&maxResults=50 200 420ms
```

## Filtering with `DEBUG`

Lines are written through the [`debug`](https://www.npmjs.com/package/debug) package, one namespace per area, so you can choose exactly what to see with the `DEBUG` environment variable. It uses comma- or space-separated names, `*` wildcards, and a leading `-` to exclude (exclusions win). `DEBUG` combines with the flags.

```bash
DEBUG=sple:http sple export "Road trip" -o trip.json         # only HTTP lines
DEBUG=sple:import sple import trip.json --dry-run            # only import progress
DEBUG=-sple:http:retry sple --debug playlist show "Road trip"   # everything except retry lines
```

| Namespace | Lines |
|---|---|
| `sple:cli` | Selected provider and command |
| `sple:export`, `sple:import` | Playlists resolved, files read and written, tracks being matched |
| `sple:spotify:auth` | Spotify token-endpoint calls (method, path, status, duration only) |
| `sple:http` | One line per HTTP attempt |
| `sple:http:retry` | Retries and their waits (429, 5xx, network errors) |
| `sple:http:error` | Errors mapped from HTTP responses |

On a terminal `debug` adds colors and a `+Nms` suffix, and otherwise an ISO timestamp. `DEBUG_COLORS`, `DEBUG_HIDE_DATE` and `NO_COLOR` control that decoration. The decoration isn't part of the contract: scripts should use `--json`, not logs.

## What is never logged

- Request and response headers, request bodies, and token-endpoint responses.
- The contents of `tokens.json` or `.env`.
- Tokens and secrets, at any level. Every log line and error message passes through one redaction function: `Bearer …`, `access_token=`, `refresh_token=`, `code=`, `code_verifier=` and `client_secret=` values and the matching JSON fields become `[REDACTED]`.
- Long search queries and track lists in URLs (`q`, `uris`) are cut to 20 characters.

It's safe to paste `--debug` output into an issue, but check it first anyway.
