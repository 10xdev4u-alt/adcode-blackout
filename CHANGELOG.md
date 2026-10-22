# Changelog

## Unreleased

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
