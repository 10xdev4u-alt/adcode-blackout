# Changelog

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
- 70 tests, including a real install-launch-uninstall run in a temporary HOME,
  and an end-to-end run against the stock AppImage (see `docs/EVIDENCE.md`).

Known limits: Linux only; requires Node 20+; cannot see ads that never reach
the network; depends on `ADCODE_AD_SERVER` continuing to be honoured.
