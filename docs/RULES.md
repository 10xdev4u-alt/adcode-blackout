# Rule packs

`rules/core.json` is the shipped pack. A pack is data, so a new endpoint is a
reviewable JSON change rather than a code change.

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
2. Add a rule with the narrowest match that covers it - an exact path if it is
   stable, a version-tolerant pattern if only the version moves.
3. Add a case to `test/rules.test.js` and a proxy test for the response shape.
4. `blackout verify` and a launch on the stock AppImage before merging.
