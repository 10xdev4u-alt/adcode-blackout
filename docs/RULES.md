# Rule packs

`rules/core.json` is the shipped pack. A pack is data, so a new endpoint is a
reviewable JSON change rather than a code change.

A user pack at `~/.config/blackout/rules/<name>.json` overrides the bundled pack
of the same name. It is loaded by the same validator, and `blackout rules` prints
which file is in force:

```
pack       core v1
source     /home/you/.config/blackout/rules/core.json
```

Reload it without restarting the proxy:

```sh
kill -HUP "$(cat ~/.local/state/blackout/blackout.pid)"
```

A valid pack is applied immediately and journaled as `rules-reloaded`. An invalid
one is journaled as `rules-rejected` and the previous pack stays active, because a
typo must not be a way to switch the blocker off. No restart means no dropped AI
stream and no lost terminal session just to answer a new path.

```json
{
  "name": "core",
  "version": 1,
  "rules": [
    {
      "id": "serve-v1",
      "match": { "method": "POST", "path": "/v1/serve" },
      "action": "empty-serve"
    },
    {
      "id": "serve-vnext",
      "match": { "method": "POST", "pathPattern": "^/v(?:[2-9]|[1-9][0-9]+)/serve$" },
      "action": "empty-serve"
    }
  ]
}
```

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | unique, stable; appears in the journal |
| `match.method` | yes | `GET`, `POST`, ... |
| `match.path` | one of | exact path, no query string |
| `match.pathPattern` | one of | regex, anchored by the author, compiled once at load |
| `action` | yes | `empty-serve`, `ack-receipts`, `rewrite-config`, `block`, `pass` |
| `since` | no | first app version the rule is known to apply to |
| `note` | no | why the rule exists |

`loadRulePack` validates a pack before use: name shape, unique ids, a known
action, and a pattern that compiles. A bad pack is refused with the rule id in
the error, not silently skipped.

## Actions

- `empty-serve` - discard the request, answer `{"creatives":[]}`.
- `ack-receipts` - parse `{receipts:[{receiptId}]}`, validate each id against the
  client's own `[A-Za-z0-9_-]{1,64}` rule, ack the valid unique ones, log the
  count. Malformed body is a 400.
- `rewrite-config` - fetch upstream with the caller's credential, force
  `killSwitch: true` and `dailyCap: 0`, preserve a numeric `minIntervalMs` and
  numeric projections, drop every unknown key. A refusal or non-JSON body
  degrades to `SAFE_CONFIG`.
- `block` - 403, for endpoints that should never be reachable.
- `pass` - explicit pass-through.

## Adding a rule for a new endpoint

1. Run `blackout` with the new build and look at `blackout report`; a new
   ad-like path appears under "endpoints seen outside the rules" and in the
   journal as `endpoint-seen`.
2. Copy the bundled pack to `~/.config/blackout/rules/core.json`, add a rule
   with the narrowest match that covers it - an exact path if it is stable, a
   version-tolerant pattern if only the version moves.
3. `kill -HUP` the proxy and confirm with `blackout events` that the new path is
   answered.
4. If it belongs in the project, add a case to `test/rules.test.js` and a proxy
   test for the response shape, then `blackout verify` and a launch on the stock
   AppImage before merging.
