---
name: New ad endpoint
about: ADCode added or changed an ad endpoint
labels: rules
---

## Endpoint

Method and path:

## Evidence

The `endpoint-seen` journal line, or the network request the app made:

## Proposed rule

```json
{
  "id": "",
  "match": { "method": "", "path": "" },
  "action": ""
}
```

## App version

Which ADCode build introduced it, and whether the old paths still work.
