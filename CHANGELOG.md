# Changelog

## Unreleased

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
