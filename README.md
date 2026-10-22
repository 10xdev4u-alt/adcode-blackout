# adcode-blackout

A local, path-scoped ad blocker for **ADCode**, the desktop editor. It runs on
the stock AppImage, survives updates, and never touches the app's files.

ADCode's main process reads `ADCODE_AD_SERVER` at launch and sends its ad calls
to `/v1/serve`, `/v1/receipts` and `/v1/config` on that origin. Blackout is a
loopback proxy that answers those three paths itself:

| Call | Stock server | Blackout |
| --- | --- | --- |
| `POST /v1/serve` | returns creatives | `{"creatives":[]}` |
| `POST /v1/receipts` | clears impressions | acks the ids, keeps nothing |
| `GET /v1/config` | caps and kill switch | `killSwitch: true`, `dailyCap: 0` |

Everything else - auth, the included AI, model lists, releases, support - is
piped through byte for byte.

## Why this shape

A browser extension cannot reach the desktop toast: ADCode delivers it to the
renderer as data, not as a page. A patched binary or a fork works until the next
release, then has to be redone. Blackout instead owns **how the app is started**
and **three response bodies**, both of which survive a version bump:

- The launcher resolves the AppImage on every run. An update that installs
  `ADCode-2.5.0.AppImage` next to `ADCode-2.4.0.AppImage` is picked up by mtime,
  and a recorded path is only a hint.
- Rules match paths, not builds. `/v1/serve` and its future-version pattern
  `^/v(?:[2-9]|[1-9][0-9]+)/serve$` are in `rules/core.json`; a new API version
  that keeps the path name is answered without a code change.
- A pack at `~/.config/blackout/rules/core.json` overrides the bundled one, and
  `SIGHUP` applies it live. A new endpoint is a file edit and a signal, not a
  restart or a release; a bad edit is journaled and the old pack stays active.
- No AppImage is extracted, repacked or modified. `uninstall` removes the
  launcher and restores any `.desktop` file it touched.

## Install

Needs Node 20 or newer and a Linux ADCode AppImage.

```sh
git clone https://github.com/10xdev4u-alt/adcode-blackout.git
cd adcode-blackout
npm link                 # puts `blackout` on PATH
blackout install         # finds the AppImage, installs the `adcode` launcher
```

`install` looks for `ADCode*.AppImage` in `~/Applications`, `~/AppImages`,
`~/Downloads` and `~/.local/bin`, newest first. Point it somewhere else with
`--app /path/to/ADCode.AppImage`.

Optional:

```sh
blackout install --desktop    # repoint matching .desktop entries at the launcher
blackout install --autostart  # systemd user unit, so the proxy is always up
```

Then start the editor through the launcher, not the AppImage directly:

```sh
adcode
```

The launcher starts the proxy if it is not running, sets
`ADCODE_AD_SERVER=http://127.0.0.1:8790`, and execs the AppImage. If the proxy
cannot start, ADCode still launches with a warning - a blocker must never lock
you out of your editor.

Already have `~/.local/bin` on `PATH`? Then `adcode` is the only command you
need after install.

## Check it

```sh
blackout status
blackout status --json     # same facts, for a script
blackout report
blackout verify
blackout doctor
blackout doctor --json   # one object, one entry per check
blackout config          # show the effective policy; flags write it
blackout rules             # the active pack, with --json for the raw object
blackout events            # follow decisions live; --once for scripts
```

Diagnose a launch without starting an editor:

```sh
blackout launch --dry-run
```

It prints the AppImage it resolved, which rule chose it, the proxy URL and the
exact argv, and starts nothing.

`report` counts blocked serves and receipts, the minutes of attention that
bought back, and - honestly labelled as an estimate - the earnings you chose not
to take. `verify` recomputes the hash chain and names the first entry that no
longer matches. `doctor` checks node, config, the active rule pack, AppImage
resolution, the launcher, the proxy, systemd, the journal and the upstream.

A local dashboard is at <http://127.0.0.1:8790/_blackout/dashboard> while the
proxy runs. It loads no external assets and has no build step.

Pause for five minutes without uninstalling:

```sh
blackout pause
blackout resume
```

While paused, every request is forwarded unchanged, including the ad calls.
The pause endpoint requires an `x-blackout-control` header, so a random web page
cannot hit it with a form post.

## What it does not do

- **No TLS interception.** The proxy is only ever the origin ADCode is told to
  use. It does not read HTTPS traffic to anywhere else, and it has no
  certificate authority.
- **No content filtering.** It does not hide sponsored UI that ships inside the
  app bundle, and it does not rewrite the renderer. That is a different product
  with a different maintenance cost.
- **No first-party sneaking.** If a future build stops reading
  `ADCODE_AD_SERVER`, or hard-codes ads into the bundle, blackout cannot see
  them. `doctor` and the journal's `endpoint-seen` entries are how you find out.
- **Not a general ad blocker.** It answers ADCode's ad API, not the web.
- **Linux only for now.** The proxy is portable Node; the launcher and
  `.desktop` integration are Linux-specific. macOS and Windows launchers are
  the obvious next port.
- **Not silent about the trade.** The report states what was blocked and what
  that was estimated to be worth. You decide which number matters.

## Failure modes, stated plainly

- Upstream down: pass-through features degrade, ads stay blocked. `/v1/config`
  falls back to `killSwitch: true`, `dailyCap: 0`.
- Journal tampered with: `verify` reports the first broken link, including a
  link in an older rotated segment. The chain is a detector, not a preventer -
  anyone with write access can rewrite the whole file, but not keep the head
  hash you already published.
- Journal grows: the live file rotates at 5 MiB into numbered segments, and
  `verify` checks across them. Each file is bounded; the total is not, because
  deleting history would defeat the point. Plan on a few segments per year.
- A broken `core` override at startup: the bundled pack is used instead, and
  `rules-rejected` says why. A broken custom pack refuses to start rather than
  guessing.
- Port 8790 busy: `launch` warns and starts ADCode unprotected rather than
  refusing to start it. `doctor` names the pid and command that hold the port
  on Linux, and says "not running" where it cannot know.
- AppImage renamed by an update: the next launch resolves the newest match.
  Set `ADCODE_APPIMAGE` to pin one deliberately.

`uninstall` also stops a proxy that blackout started, identified by both the
pid file and the process command line. A proxy started by hand is reported, not
killed.

Uninstalling keeps the journal and the config, because they are the record of
what happened. `blackout uninstall --purge` removes them too; it refuses to
follow a symlink and deletes only files it recognises.

## Development

No dependencies, no build step.

```sh
npm test                 # 83 tests, node:test
node bin/blackout.js help
node scripts/smoke.js    # proxy + contract calls + a report, no app needed
```

The end-to-end check against a real AppImage is written up in
[docs/EVIDENCE.md](docs/EVIDENCE.md). Architecture, threat model and the rule
format are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md),
[docs/RULES.md](docs/RULES.md) and
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). The last one is the update
checklist: what the blocker depends on and how to tell in two minutes whether a
new ADCode release still honours it.

## Independence

Blackout is not affiliated with, endorsed by, or supported by ADCode or
Bluethenics. It is an independent client-side tool that uses a documented
environment variable. It is not a licence to redistribute ADCode; the app's own
licence still applies.

Apache-2.0.
