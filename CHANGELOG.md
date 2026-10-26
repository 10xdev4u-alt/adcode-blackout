# Changelog

## Unreleased

- A receipts body that never arrives is refused instead of parked. The drain on
  the blocked paths has had a two-second deadline since it was written; the
  receipts path had none, so a client that sent headers, an announced length and
  nothing else got no answer at all and held the request, its buffers and the
  pending response until Node's own five-minute request timeout closed the
  socket. `readBody` now carries the same deadline and answers `408` with
  `body timeout`, and keeps reading afterwards so the refusal is delivered on a
  socket that is not reset. The two tests are the two halves of a body that
  never finishes: one stalls and is answered in ~2s, the other abandons the body
  and must cost the proxy nothing - no decision written for it, no timer left
  behind, the next request answered normally. Before this, the stalled case
  answered nothing at all (`no answer: ""` after six seconds).
- An upstream that dies mid-response is a fault again, not a silent truncation.
  The request object does not error when the connection drops after the headers,
  only the response does, and the one check that existed asked whether *our*
  controller had been aborted - which the pipe sets as it tears down the failed
  response. So a dropped upstream was classified as a cancellation: the client
  got half a body with a 200 on it and the journal, the place upstream errors are
  meant to be, recorded nothing. The response is now watched to completion and
  the test is whether the *client* went away, so a truncation is journaled once
  and the client's socket is destroyed instead of left to hang on a body that is
  never coming.
- The refusals at the library edges are covered, one case each: a rule pack
  nobody can honour (no name, no rules, a rule that is not an object, an invalid
  id, an unknown action, no match, an invalid method, both a path and a pattern,
  neither, a path that does not start with `/`, and two rules sharing an id), a
  pack that states no version being version 1, a policy flag that is not a flag
  (`enabled`, `dashboard`, and a pack name that is a path), a pid that is not a
  process being not the proxy, a port that cannot exist having no owner, a lock
  file that is not a claim, a claim with garbled port and time that keeps its
  pid, a claim naming a process that is no longer the proxy, a claim that cannot
  be removed reporting `false` instead of pretending, a journal that cannot be
  written keeping the entry and its count and surfacing the failure, a state
  directory that was never created reading as an empty journal, and a unit that
  was never installed not being enabled. The floors move up with it: 95.7 line,
  83 branch, 95 function.
- The soak runs in CI on every pull request, at a rate a shared runner holds.
  It was the one gate that only ran when somebody remembered, and it is the only
  place a descriptor leak, a heap that only grows, counters that drift from what
  was sent, or a chain that stops verifying can show up at all.
- More of the record and the request path is covered, each with the case it is
  there for: a name where a segment should be is reported rather than read
  around, a rotation that cannot happen (a state directory that cannot be
  written) leaves a degraded record rather than a stopped blocker, a live file
  removed underneath keeps counting, a torn tail in a file that cannot be
  repaired is dropped and the loss reported, `retainEntries` is validated, a
  policy that is not an object is refused by name, a wrapper that cannot be read
  is not ours, desktop entries that are not regular files are left alone rather
  than deleted, `unitEnabled` reads the wants directory, a launch failure names
  the binary, a window outside 1s-1h is refused before anything starts, an
  unknown control path is a 404, a Host header the URL parser cannot read is a
  421, and a `pass` rule forwards to the upstream and returns its bytes. The
  floors move up with it: 95.5 line, 80.5 branch, 95 function.
- The suite now covers the refusals, which were the paths with no test: a
  foreground start in a state directory another proxy owns, a port held by
  something that is not the proxy (and the claim it must release on the way
  out), `uninstall` against a process that answers the health route but is not
  this proxy - the stale pid is named and nothing is signalled - `verify` on an
  absent, intact and tampered journal, `status` when nothing is running,
  `doctor` on a launcher it did not write and a config it cannot read, a port
  moved under a running proxy, a terminal signal reaching the editor and
  stopping when it exits, and a broken custom pack stopping a detached start
  before it spawns anything. `launch.js` and `report.js` are at 100% of lines.
  `npm run coverage` holds the floors (95 line, 79 branch, 94 function) in CI,
  so the next branch arrives with a test or with a lowering someone argued for.
- The soak stopped failing itself. It divided the achieved rate by wall time
  that included its own five-second settle sleep, so a 20-second run at 60/s
  reported `44/s` and `soak: FAILED` while the load window had actually
  delivered 58.8/s - the proxy answers 708/s with four in flight. The rate is
  now measured over the load window and the settle is reported separately, the
  pacing loop sleeps until the next tick is due instead of dropping its own
  overshoot, and a test runs the script and pins both numbers so a gate that
  cries wolf cannot come back quietly.
- `npm run surface` walks every command in every state it meets. Nothing
  running, running, paused - each against a throwaway HOME on its own port - and
  fails on an exit code that contradicts the README, JSON that does not parse, a
  config write that was silently refused, or a stack trace where a sentence
  belongs. The unit tests check commands one at a time; this checks that  the tool still behaves like a tool when someone uses it. 65 checks, including
  `compat`'s pass and failure paths and the artifacts a failure retains.
- Two proxies can no longer share one state directory. `serve --port A` and
  `serve --port B` both appended to the same `journal.jsonl` with independent
  chains, so each decision was valid and the file still read as tampering:
  reproduced with two proxies and ten decisions each, `verify` reported `BROKEN
  at entry 1`. The directory is now claimed by the process that writes it, the
  claim names its pid and port, and a second start is refused before the journal
  is opened. A claim left by a crash is taken over, and starting `serve` for the
  port already answering stays a no-op.
- The suite now covers the protocol paths nothing else reached: oversized
  headers, `CONNECT`, `Upgrade`, HTTP/1.0 without a `Host`, pipelining, two
  framings on one request (smuggling), hostile request targets, an 8 MiB
  response to a deliberately slow reader, a failed TLS handshake, and a clock
  that moves backwards. Each asserts the proxy is still answering afterwards. A
  crash between the rotation rename and the new live file - a real two-syscall
  window - is covered in the journal tests, because the next start has to
  resume the chain rather than begin again at genesis. All of it passed on the
  first run; the value is that it now stays that way.
- `blackout compat` no longer points at a journal it did not write. A build that
  never called the proxy journals nothing, and the journal is opened lazily on
  its first decision, so a failing run printed `journal kept /tmp/...` for a
  path that did not exist - the one artifact the verdict says to read next. The
  retained directory now always contains the file the message names.
- Memory no longer grows with the journal. Only the most recent 5,000 decisions
  are retained; totals are counted as entries arrive, so `report`, `status` and
  the dashboard still show the whole record. Measured before the change: a soak
  at 400 decisions/s reached 137 MiB of heap in five minutes and kept climbing.
- A decision stream subscriber that stops reading is disconnected instead of
  buffered. A suspended dashboard tab used to collect every later decision in a
  socket queue that never drained (about 12 MiB per 10 MiB of journal traffic);
  it is now cut off past 256 KiB of backlog and reconnects to a replayed tail.
- A pass-through request whose client hangs up now closes the upstream request.
  `req.pipe()` did not: a stalled upstream never errors, so each cancelled call
  left a socket and a request object open (40 cancellations, 40 open sockets).
- An answer that is ready after the client has already gone is dropped instead
  of written to a destroyed response.
- Endpoint discovery is capped at 256 distinct observations and says when it
  stops (`discovery-capped`). Any page can POST to loopback, and every new
  ad-like path would otherwise cost a set entry and a journal line that the
  request chooses the size of.
- A config response over 1 MiB is refused without reading the rest. The rewrite
  used to buffer whatever the upstream sent before failing to parse it: a 200
  MiB body drove peak RSS to 723 MiB, and 87 MiB after the limit.
- `blackout report` reaches its on-disk fallback again. `fetch` rejecting on a
  refused connection made the command print `fetch failed` instead of the
  journal's report, so the fallback was unreachable whenever it was needed.
- A crash mid-write no longer bricks the journal. The truncated last line was
  tolerated by the reader but left in the file, so the next decision was
  appended onto it and produced one unparseable line; a second decision then put
  that line in the middle of the file, where the tolerance does not apply. From
  there `serve` refused to start and `verify` and `report` threw. The fragment
  is now removed from the file before anything is written to it, in the same
  open that resumes the chain.
- `uninstall` stops the proxy, not whatever a stale pid file names. The old
  check was "the command line contains blackout", which is also true of
  `tail -f ~/.local/state/blackout/blackout.log`; a recycled pid matching that
  was sent SIGTERM, and the command still printed `stopped pid N` while the real
  proxy kept serving. Ownership now comes from the process holding the port, and
  `--purge` refuses to delete the journal under a listener it cannot prove is
  the proxy.
- A `team` block in `config.json` no longer stops every command. The setting
  was parsed and validated but nothing read it and nothing documented it, so a
  typo in `team.url` produced `cannot read ...config.json: team.url must be an
  absolute URL` for a feature that does not exist. Removed; unknown keys are
  ignored, as they always were.
- `uninstall` disables the systemd unit before deleting its file. `systemctl
  disable` reads the unit it is disabling: the old order worked only while
  systemd still had the unit loaded, and the `--now` half - the one stop that
  does not depend on trusting the pid file - silently failed every time. A
  `daemon-reload` in between would have left a dangling `wants` symlink, and a
  proxy whose ownership could not be proven would have kept running with no
  unit left to address it. Verified against a real `systemctl --user` session:
  active and enabled, serving and journaling under `ProtectHome=read-only` with
  `StateDirectory`, then inactive, gone, port free, no `wants` link.
- `install --desktop` no longer writes through a symlinked desktop entry. A
  link in `~/.local/share/applications` to an entry under /usr/share was
  followed, so the patch landed on a file blackout does not own; the backup was
  written beside the link, and `uninstall` renamed it over the link - replacing
  the user's symlink and leaving the system entry patched. Only regular files in
  that directory are considered now, by both the patch and the restore.
- An IPv6 loopback host works end to end (`"host": "::1"`). Two failures: every
  URL built from the policy left out the brackets, so `status` said "not
  running" against a serving proxy and the app was launched with an unusable
  `ADCODE_AD_SERVER` (`http://::1:8790`); and each request's URL was parsed
  against `http://${policy.host}`, which is `http://::1` - `new URL` throws, so
  every request answered `500 Invalid URL`. Authorities are bracketed now, and
  the request URL is parsed against a fixed base since only its path is read.
- `blackout events` reconnects after the proxy restarts. The stream advertised
  `retry: 3000` on the assumption that something would, but the CLI read once
  and exited - `blackout: terminated`, status 1 - so a follower lost the view at
  the first update, crash or `systemctl restart`. It now retries every three
  seconds, says so on stderr, and keeps stdout clean for `--json`; the first
  connection still fails immediately with the address when nothing is listening.
- `uninstall` finishes what it can when one step refuses. A launcher the user
  had replaced threw before the AppImage record was forgotten and before the
  summary printed, so the only output was the refusal and the next `launch`
  still resolved the old build. The refusal still stands - the file is not
  deleted - it is now reported at the end with the rest of the summary, and the
  exit code is 1. The same applies to a `--purge` that stops on a symlink.
- A stopping proxy lets the answers it already started land. SIGTERM destroyed
  every open connection on the spot, so `uninstall`, Ctrl-C and
  `systemctl restart` turned a request the app was waiting on into "fetch
  failed" 26 ms after the signal. The listening socket still closes at once, so
  a caller polling for "has it stopped" does not wait; existing answers get up to
  three seconds, and idle keep-alive sockets are swept while waiting so a
  finished response does not cost the whole grace period.
- `blackout doctor` reports an unreadable journal instead of dying on it. The
  journal check read the file outside any handler, so a corrupt line printed
  `cannot read journal ... corrupt at line N` and nothing else - no node, config,
  rule or upstream check, and `--json` produced no object at all. The command
  that exists to say what is wrong now says this, and the rest.
- `blackout events --once` prints the latest decision, or waits for the next one
  when there is no history. The stream replays the last 20 entries and the
  command printed the first of them, so a script asking for "the next decision"
  got the oldest one immediately - and the documented post-SIGHUP check showed a
  decision from before the reload instead of `rules-reloaded`. `?tail=N` now
  bounds the replay for that one caller.
- The "ADCode is already open" explanation from `blackout compat` reaches the
  person running it. `judge` only adds the note when the exit is marked as
  observed, and the runner resolved a real exit as `{ code, signal }` without
  that flag, so `undefined === false` dropped it and only the unit test - which
  passed the flag itself - ever saw it. An observed exit is now marked.
- `blackout launch` starts the editor when `~/.config` or the state directory
  is read-only or full. Recording the AppImage path threw EACCES before the
  editor was considered, and a failure to open the proxy's log file escaped
  `ensureProxy` the same way, so a filesystem problem cost the editor over a
  blocker. Both are warnings now; only the editor failing to start is an error.
- A launcher that cannot spawn the proxy (out of descriptors, for example) now
  warns and starts the editor. The unhandled `error` event from `spawn` threw in
  the launcher, which cost the editor over a blocker the person could not see.

## 0.4.4 - 2026-10-23

- `npm run soak -- --segment-bytes 8000` forces journal rotation every few
  entries; 30 seconds at 25 req/s produced 19 segments and a chain that still
  verifies. A `kill -9` under load left a complete chain, and the restart
  resumed from it without losing a line.
- `scripts/soak.js` (`npm run soak`) drives a mixed load against a proxy and
  fails on a broken chain, drifting counters, descriptors that do not settle, or
  a heap that keeps growing in the second half. `CONTRIBUTING.md` says when to
  run it. Sixty seconds at 25 req/s currently ends with the heap flat, the
  descriptor count back at its baseline, and every count matching what was sent.
- A blocked request's body is now consumed before the answer is sent. Answering
  first made Node destroy the socket afterwards, so a large `serve` body cost a
  new connection every time and could cut the response off. The wait is bounded
  at two seconds, so a client that never finishes cannot hold the answer.
- A broken config now names the file it could not read, instead of saying
  "policy file" and leaving the reader to guess which one.
- The proxy test fixture is restored after the test that takes the upstream
  away. It was left on a stand-in answering `{}` to every request, so every test
  after it was measuring the wrong thing.

## 0.4.3 - 2026-10-23

- `blackout compat` explains a build that quits immediately with no traffic:
  a second instance of ADCode focuses the first one and exits, so the answer is
  "close the editor", not "the build is broken".
- `blackout compat` prints the next step with a failure, not only the check
  that failed: what to read, which flag to try, or whether the answer is a rule
  or a bug report. `docs/COMPATIBILITY.md` has the same table.

## 0.4.2 - 2026-10-23

- `blackout compat` now stops the app's whole process group when the window
  ends. Killing only the launched process left Electron's renderers and GPU
  helpers behind on every run.
- An explicit `--app` path is now authoritative. A path that is missing, not a
  file, or under 1 MiB used to fall through to a discovered AppImage, which
  could launch (or record, or judge) a different build than the one named. It
  is now an error naming the path.

## 0.4.1 - 2026-10-23

- `blackout compat` no longer requires a rewritten `/v1/config` for a pass. A
  stock build sends `dev-token` when `ADCODE_AD_SERVER` is set, production
  answers 401, and the proxy serves `SAFE_CONFIG` itself - the recorded evidence
  run shows exactly that. The rewrite is reported as unverified instead of
  leaving every real build inconclusive; a 200 that cannot be parsed is still a
  failure.
- The harness launches with `ADCODE_SETTLE_MS=0`, the development override the
  evidence run used, so the first-install settle grace cannot swallow the
  window.
- `blackout compat -- ARGS...` passes arguments to the app, so a container that
  needs `--no-sandbox` can run the harness.

## 0.4.0 - 2026-10-23

- `blackout compat [--app PATH] [--seconds N] [--json] [--keep]` runs a build
  against a private proxy and judges whether the contract still holds: serve
  answered, config rewritten, no ad-like endpoint passed through, app alive.
  Exit 0 pass, 1 inconclusive, 2 fail; a run that is not a pass keeps its
  journal and app log for reading. This replaces the manual two-minute check in
  docs/COMPATIBILITY.md and is the check to run before trusting a new AppImage.
- An `--app` path that exists but is not usable (missing, not a file, under
  1 MiB) is now named back instead of falling through to "no AppImage found".
- The dashboard shows when the journal file stopped accepting writes, instead
  of only the CLI and the report saying so.
- A journal that cannot be read at all (a directory in its place, a permission
  error) now fails with the path it could not read, not a bare `EISDIR`.

## 0.3.1 - 2026-10-23

- A journal that cannot be written no longer fails open. A full or read-only
  state directory used to throw from `append`, which turned a `serve` the proxy
  should have blocked into a `500` and let the ad through. The entry now stays in
  memory, the request is still blocked, and the first failure is reported as
  `journalWriteError` by `/health`, `status`, `doctor` and `report`. The gap left
  on disk is reported by `verify` after a restart rather than papered over.

## 0.3.0 - 2026-10-23

- The optional systemd unit now runs sandboxed: state directory only, no new
  privileges, private `/tmp`, read-only system and home.
- Requests whose `Host` is not loopback are refused with `421` and journaled as
  `host-rejected`. This closes the DNS-rebinding path to pause/resume, which the
  custom control header alone did not cover.
- A malformed `core` override at startup falls back to the bundled pack and
  journals `rules-rejected` with `fallback`, instead of starting unprotected.
  `doctor` now checks that the active pack loads and names its source.
- A user rule pack at `~/.config/blackout/rules/<name>.json` overrides the
  bundled pack, validated by the same loader. `SIGHUP` reloads it live:
  `rules-reloaded` on success, `rules-rejected` plus the old pack on a typo.
- The journal now rotates at 5 MiB into `journal.0001.jsonl`, `0002`, ... with
  the hash chain continuing across files. `verify` and an offline report read
  every segment and name a tampered entry by its absolute index.

## 0.2.0 - 2026-10-22

Diagnostics and lifecycle, after the first end-to-end run against the stock
AppImage.

- `status --json`, `launch --dry-run`, `rules [--json]` and `--version` for
  scripts and bug reports.
- `doctor` names the process holding the proxy port on Linux, and warns when
  the launcher points at another checkout.
- `uninstall` stops the proxy it started, and `--purge` removes the journal,
  config and state it created. Purge refuses to follow a symlink.
- `install --desktop` now repoints entries that name an older AppImage, so an
  update does not leave a dead `Exec`.
- Rule packs can be inspected without reading the source tree.
- 83 tests, including install/launch/uninstall in a temporary HOME, desktop
  entry patching and restoration, port-owner lookup and proxy shutdown.

## 0.1.0 - 2026-10-22

First working release, Linux AppImage.

- Loopback proxy that answers `POST /v1/serve`, `POST /v1/receipts` and
  `GET /v1/config`; everything else is piped unchanged.
- Rule packs with exact and version-tolerant path matching (`rules/core.json`).
- Hash-chained journal, `verify`, and a report with blocked totals, attention
  returned and explicitly estimated forgone earnings.
- Dependency-free local dashboard and server-sent event stream.
- `blackout install` / `launch` / `serve` / `status` / `report` / `verify` /
  `pause` / `resume` / `doctor` / `uninstall`.
- AppImage resolution on every launch, so a renamed update still works.
- Optional `.desktop` rewrite with backups, and an optional systemd user unit.

Known limits: Linux only; requires Node 20+; cannot see ads that never reach
the network; depends on `ADCODE_AD_SERVER` continuing to be honoured.
