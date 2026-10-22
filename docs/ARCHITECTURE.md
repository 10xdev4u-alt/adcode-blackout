# Architecture

```
adcode  (wrapper)
  └─ blackout launch
       ├─ ensureProxy ──► blackout serve  (detached, 127.0.0.1:8790)
       └─ exec AppImage with ADCODE_AD_SERVER=http://127.0.0.1:8790
                              │
                              ├─ POST /v1/serve     ──► []            (local)
                              ├─ POST /v1/receipts  ──► {acked:[...]} (local)
                              ├─ GET  /v1/config    ──► killSwitch    (rewritten)
                              └─ everything else    ──► upstream      (piped)
```

## Modules

| File | Responsibility |
| --- | --- |
| `src/proxy.js` | HTTP server, rule dispatch, pass-through, local control endpoints |
| `src/rules.js` | rule-pack loading and validation, exact and pattern matching |
| `src/config.js` | turns any upstream config into the exact shape the client validates |
| `src/journal.js` | append-only hash-chained log, verification, subscriptions |
| `src/report.js` | totals, attention, estimated forgone earnings, integrity |
| `src/dashboard.js` | dependency-free HTML dashboard |
| `src/policy.js` | local configuration; refuses non-loopback hosts |
| `src/desktop.js` | AppImage resolution, wrapper, `.desktop` patching, systemd unit |
| `src/launch.js` | ensure-proxy, launch-with-env, signal forwarding |
| `src/cli.js` | the commands |

## Three invariants

1. **Only matched paths are parsed.** A rule is a method plus an exact path or a
   path pattern. Anything else is piped, including request and response bodies,
   headers and streaming AI responses. The proxy is not a man-in-the-middle and
   does not buffer what it does not need.
2. **A blocked receipt is acknowledged.** ADCode's receipt queue only drains on
   an `acked` array. Dropping the request leaves it retrying forever; acking the
   valid ids and discarding them is both quieter and honest - nothing is
   claimed.
3. **An ad failure costs an ad, never an editor.** Proxy start failure, a busy
   port, a malformed upstream response: each degrades to either the safe config
   or an unprotected launch with a warning. Editing, the terminal and the
   included AI are never on this path.

## What makes it survive an update

The durable contract is not a file in the AppImage. It is:

- `ADCODE_AD_SERVER`, read once at process start by `backend.ts`.
- The `/v1/{serve,receipts,config}` path names.
- The response schemas, which the client validates strictly.

Blackout depends on those three and nothing else. It does not depend on an
internal module path, a symbol name, an asar entry or a build hash. A release
that changes the API version but keeps the path name is covered by the
future-version rules. A release that renames the path is what the journal's
`endpoint-seen` discovery entries and `doctor` are for: the old paths keep
working, the new ad-like path shows up in `blackout report`, and a rule can be
added without shipping a new binary.

The launcher is the second half: it re-resolves the AppImage every run, so a
`.AppImage` update with a new filename does not break the entry point.

## Data flow for one blocked serve

1. ADCode's `AdClient` calls `POST /v1/serve` with tags, theme and a count.
2. `matchRule` returns `serve-v1` (`empty-serve`).
3. The request body is drained and discarded; nothing is logged about it beyond
   the path and rule id.
4. `journal.append("serve-blocked", …)` writes one hash-chained line.
5. The response is `{"creatives":[]}` with `x-blackout: serve-empty`.
6. The client's validator accepts it, the scheduler sees an empty inventory and
   shows nothing.

No request ever contains the user's code. The tagger sends a vocabulary of
languages and file *basenames*, and blackout discards even that.

## Journal

Each entry is `{seq, at, kind, data, prev, hash}` where `hash` is SHA-256 over
`[seq, at, kind, data, prev]`. `verify` recomputes the chain from genesis
(`"0".repeat(64)`). A truncated final line is tolerated; a broken link anywhere
else is reported at its index. Subscribers receive entries as they are appended,
which is what the dashboard's event stream consumes.

The chain is tamper-evident, not tamper-proof. Its value is that a report can
name a head hash; changing history after that means the published head no longer
matches.

## Local endpoints

All under `/_blackout/`, never forwarded:

- `GET /health` - version, enabled state, upstream, journal head
- `GET /report` - the report JSON
- `GET /dashboard` - the HTML dashboard (if enabled)
- `GET /events` - server-sent events, one per journal entry
- `POST /pause`, `POST /resume` - require `x-blackout-control`

The proxy binds loopback only. `policy.js` refuses any other host rather than
clamping it, because a typo in a host is how a local tool becomes a public one.
