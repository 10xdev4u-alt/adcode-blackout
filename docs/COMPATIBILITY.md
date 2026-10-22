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

## After an ADCode update: the two-minute check

```sh
blackout doctor
blackout launch
```

Then, with the editor open for a full scheduler interval (60 seconds of settle
plus one tick):

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

2. Add a rule to `rules/core.json`, with a test in `test/rules.test.js` and a
   proxy test for the response.
3. `npm test && node scripts/smoke.js`.
4. Launch the stock AppImage and confirm `servesBlocked` moves.

The rule file is data on purpose: this is a reviewable JSON change, not a
release of a patched binary.
