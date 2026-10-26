# Surviving ADCode updates

The blocker is only useful if an update does not silently switch it off. This
is what it depends on, and how to check after a release.

## What it depends on

| Contract | Where it comes from | How a change breaks it |
| --- | --- | --- |
| `ADCODE_AD_SERVER` is read at launch | `apps/desktop/src/main/backend.ts` | Removed or renamed: the proxy is never called |
| Ad calls live under `/v1` | `apps/desktop/src/main/ads.ts` | Moved out of `/v1`, or behind a different origin |
| `POST /v1/serve` answers `{creatives: []}` | `packages/ads/src/validation.ts` | A new required field in the response |
| `POST /v1/receipts` acks ids matching `[A-Za-z0-9_-]{1,64}` | same | Different id shape, or a required body field |
| `GET /v1/config` accepts `{killSwitch, caps, projections}` | same | Extra required keys, or the whole response rejected |

Nothing else. No internal module path, no symbol, no asar entry, no build hash,
no certificate.

## After an ADCode update: one command

```sh
blackout compat
```

It starts a private proxy on an ephemeral port, launches the AppImage against
it for 60 seconds, and judges what happened: was `/v1/serve` answered, did the
app call anything ad-like outside the pack, did it refuse the proxy's Host, did
it die. Exit `0` is a pass, `1` is inconclusive (the app talked to the proxy but
had no ad opportunity - open the editor, keep it focused, run `blackout compat
--seconds 180`), `2` is a failure. A run that is not a pass keeps its journal
and the app's log and prints both paths, so a failure can be read rather than
guessed at. `--json` prints the same verdict as an object.

A pass needs `serve` answered. A config rewrite is evidence when it happens, but
not a requirement: with `ADCODE_AD_SERVER` set, a stock build sends `dev-token`
instead of a real credential, production answers 401, and the proxy serves
`SAFE_CONFIG` (kill switch on, cap zero) itself - so the block still holds and
the harness reports the rewrite as unverified rather than failing the build.
A 200 that cannot be parsed is different, and is a failure: that is the schema
having moved.

The harness launches with `ADCODE_SETTLE_MS=0`, the development override the
evidence run used, so the first-install settle grace does not swallow the
window. Normal launches through `blackout launch` keep the grace.

Arguments after `--` go to the app: `blackout compat -- --no-sandbox` in a
container, or `xvfb-run -a blackout compat` with no display. Under `xvfb`, GPU
and zygote errors in the kept app log are normal.

### Reading the checks

| Check | A failure means | What to do |
| --- | --- | --- |
| `launch` | the build died or never started | read the kept app log; pass `-- --no-sandbox` in a container |
| `contact` | nothing reached the proxy | the build stopped reading `ADCODE_AD_SERVER` (report it) or never started (app log) |
| `host` | a non-loopback `Host` was refused | a bug in the build, not a rule to add |
| `drift` | an ad-like path passed through | add the narrowest rule and `SIGHUP` |
| `config` | a 200 that could not be rewritten | the schema moved; a 401 under `dev-token` is expected and harmless |
| `serve`/`receipts` | `warn`, never a failure | a window without an ad opportunity: rerun longer, editor focused |

The harness uses its own journal in a temp directory and never touches the
installed state, so it can run while the normal blocker is up.

For the human numbers, after the editor has been open for a full scheduler
interval (60 seconds of settle plus one tick):

```sh
blackout report
blackout rules
```

What to look for:

- `report` shows a rising `servesBlocked`. If it stays at zero while the app is
  open, the hook is not being reached.
- The report's **endpoints seen outside the rules** section lists an ad-like
  path the pack does not cover. That is the signal to add a rule
  ([docs/RULES.md](RULES.md)), not to fork.
- `doctor` fails on `appimage` after a rename: run `blackout install` again, or
  set `ADCODE_APPIMAGE`.

## What is already version-tolerant

`rules/core.json` contains `^/v(?:[2-9]|[1-9][0-9]+)/serve$` and the same for
`receipts` and `config`. An API bump from `/v1` to `/v2` or `/v10` keeps
working without a release. The launcher resolves the newest AppImage on every
run, so a new filename works without reinstalling. `.desktop` entries that
still name an older AppImage are repointed by `install --desktop`.

## What genuinely breaks it

- The variable is renamed or no longer read.
- Ads move to a different origin that the app chooses itself.
- Ads are rendered from data bundled in the app, with no request.
- The response schemas gain a required field.

The first two are visible immediately: no `serve-blocked` in the journal. The
third is invisible to any network tool and is stated as a limit in the README.
The fourth shows up as `config-degraded` with a 200 status, or as a client
validation failure - and a new response shape is a small, testable change.

## When a new endpoint appears

1. Find it in the journal:

   ```sh
   grep endpoint-seen ~/.local/state/blackout/journal.jsonl
   ```

2. Copy the pack to `~/.config/blackout/rules/core.json`, add the narrowest rule
   that covers the endpoint, and reload:

   ```sh
   kill -HUP "$(cat ~/.local/state/blackout/blackout.pid)"
   blackout events --once
   ```

   A valid pack applies immediately; an invalid one is journaled as
   `rules-rejected` and the old pack keeps running.

3. If it belongs in the project, add a test in `test/rules.test.js` and a proxy
   test for the response, then `npm test && node scripts/smoke.js && npm run
   surface`.
4. Check it against the stock build with `blackout compat --seconds 60`. The
   long form - launch it yourself and watch `servesBlocked` move - is still in
   [EVIDENCE.md](EVIDENCE.md) for the first run, when you want to see the window
   as well as the verdict.

The rule file is data on purpose: this is a reviewable JSON change, not a
release of a patched binary, and SIGHUP means it does not even need a restart.
