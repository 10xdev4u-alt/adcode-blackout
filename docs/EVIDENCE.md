# Evidence: the stock AppImage talks to blackout

Run on 2026-10-22 against `ADCode-x86_64.AppImage`, extracted to
`/tmp/ai-extract/squashfs-root`, under `xvfb-run` with no display. No file in
the AppImage was modified.

```sh
BLACKOUT_HOME=/tmp/blackout-e2e/config \
BLACKOUT_STATE=/tmp/blackout-e2e/state \
node bin/blackout.js serve --foreground --port 8790 &

ADCODE_AD_SERVER=http://127.0.0.1:8790 \
ADCODE_SETTLE_MS=0 \
timeout 35 xvfb-run -a /tmp/ai-extract/squashfs-root/AppRun --no-sandbox
```

`ADCODE_SETTLE_MS=0` is a development-only override for the 60-second launch
grace period; normal launches keep it.

The journal after 35 seconds, verbatim:

```json
{"seq":0,"at":1792693657823,"kind":"config-degraded","data":{"path":"/v1/config","status":401},"prev":"0000000000000000000000000000000000000000000000000000000000000000","hash":"8be07028fde416fb0cf48254069c214e23934a9f7830d04e22f9511dff12cf4b"}
{"seq":1,"at":1792693658236,"kind":"serve-blocked","data":{"path":"/v1/serve","rule":"serve-v1"},"prev":"8be07028fde416fb0cf48254069c214e23934a9f7830d04e22f9511dff12cf4b","hash":"bee1f58b6681ceff5ef32eb83ae889bd2a09b61dd113cb5a18541e395b810f96"}
```

Report at the same moment:

```json
{
  "totals": { "servesBlocked": 1, "receiptsBlocked": 0, "configsRewritten": 0, "endpointsSeen": 0 },
  "attention": { "seconds": 8, "minutes": 0, "hours": 0 },
  "integrity": { "ok": true, "brokenAt": null }
}
```

## What this proves and what it does not

Proves:

- The stock build reads `ADCODE_AD_SERVER` at launch and routes its ad calls to
  the proxy. Both `/v1/config` and `/v1/serve` arrived.
- `serve` was answered locally; the upstream was never asked for creatives.
- The journal chain verifies.

Does not prove:

- `config-degraded` is expected here: with `ADCODE_AD_SERVER` set, ADCode's
  `backendAccount` deliberately stops creating a real Firebase account and
  sends `dev-token`, which production rejects. The proxy falls back to the safe
  config, which also forces the kill switch. With a real credential the same
  call is rewritten instead; the proxy unit test covers that path with a 200.
- No toast appeared because the inventory was empty, which is the point, and
  because a headless run with no focused window is not a normal session.
  Receipts are only generated after a card is shown, so `receiptsBlocked: 0` is
  the correct number here.

## Repeat it

```sh
npm test
node scripts/smoke.js
```

Then the two commands at the top of this file. Keep the app open for at least
one scheduler tick; with the default 60-second settle, that is about two
minutes. GPU and zygote errors in the app log are normal under `xvfb`.
