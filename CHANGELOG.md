# Changelog

## Unreleased

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
