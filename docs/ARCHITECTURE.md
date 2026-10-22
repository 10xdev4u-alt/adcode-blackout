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

The live file rotates at 5 MiB to `journal.0001.jsonl`, then `0002`, and so on.
Rotation happens after the append that crosses the threshold, so no entry is
split, and renaming is atomic on one filesystem. The sequence number and `prev`
continue across files, which means `verify` reads the segments oldest-first and
checks them as one chain; tampering in an old segment is reported at its
absolute index. Rotation bounds each file, not the total history: at roughly 200
bytes per decision, 5 MiB is about 25,000 decisions, and a year of ticks is a few
segments. `blackout verify` and an offline `blackout report` read every segment.

Memory holds the most recent 5,000 entries, not every entry ever made. The
report, the dashboard and the event stream read from that tail, so the retained
list has to be long enough to describe "what just happened" and no longer. The
earlier version kept everything and argued the ad rate was low enough to bound
it; a 400 decisions/s soak disagreed, growing the heap to 137 MiB in five
minutes and still climbing. Totals are therefore counted as entries arrive
(`summary()`), and the report presents `window.entries` (the whole record) next
to `window.retained` (what memory holds) instead of quietly reporting the tail.

A subscriber that stops reading is cut off rather than queued for. `res.write`
on a full socket buffers without limit, so a suspended dashboard tab or a
`SIGSTOP`ped `blackout events` would otherwise convert every later decision into
heap that is never reclaimed; past 256 KiB of backlog the stream is destroyed
and the client's own reconnect replays the tail.

A failed write never becomes a failed decision. If the state directory is full
or read-only, the entry stays in memory, the request is still blocked, and the
first failure is kept as `{at, message}` and surfaced by `/health`, `status`,
`doctor` and the report. The gap it leaves on disk is not hidden: after a
restart `verify` names the entry where the chain broke, which is the truthful
reading of a record that stopped being written.

The chain is tamper-evident, not tamper-proof. Its value is that a report can
name a head hash; changing history after that means the published head no longer
matches.

## Local endpoints

All under `/_blackout/`, never forwarded:

- `GET /health` - version, enabled state, upstream, journal head, `journalWriteError`,
  and `requests` (application traffic counted, not journaled, so a build making
  only pass-through calls is still visibly talking to us)
- `GET /report` - the report JSON
- `GET /dashboard` - the HTML dashboard (if enabled)
- `GET /events` - server-sent events, one per journal entry
- `POST /pause`, `POST /resume` - require `x-blackout-control`

Pass-through ties the two sockets together in both directions. `req.pipe(upstream)`
alone only closes the outgoing request when the *upstream* fails: a client that
hangs up mid-call leaves the upstream socket open, and a stalled upstream never
errors, so nothing cleans it up. `res.on("close")` on an unfinished response
aborts and destroys the upstream request; without it, 40 cancelled calls left 40
upstream sockets open.

The proxy binds loopback only. `policy.js` refuses any other host rather than
clamping it, because a typo in a host is how a local tool becomes a public one.
Every request must also name loopback in `Host`; anything else is `421` and a
single `host-rejected` entry per distinct name. Binding alone is not enough
against DNS rebinding, where the browser's host is the attacker's and the socket
is loopback.
