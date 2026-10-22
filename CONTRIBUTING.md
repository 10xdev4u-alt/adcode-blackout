# Contributing

The project has no dependencies and no build step. Clone it, run `npm test`,
and you have the whole development loop.

## The invariants worth protecting

1. **An ad failure never costs an editor.** Any new code on the request path
   must degrade, not throw. `contain()` in the ad service and the try/catch in
   `launch` exist for this reason; do not remove them.
2. **Only matched paths are parsed.** Pass-through stays a pipe. If a change
   needs to buffer a request to do its job, it needs a rule and a test that
   says why.
3. **A receipt is acked, never claimed.** The queue drains locally; no receipt
   is forwarded upstream, ever.
4. **The journal says what happened.** New decision points get a journal kind
   and a report total, or they are invisible.

## Tests

- Every rule has a matching test in `test/rules.test.js`.
- Every response shape is tested against the *client's* validator, not a shape
  we invented; see `test/proxy.test.js`.
- A CLI change goes through `test/cli.test.js`, which runs the real binary in a
  temporary HOME.
- Desktop resolution is tested with real files and mtimes in
  `test/desktop.test.js`; do not mock the filesystem there.

Run `node scripts/smoke.js` before touching a real install.

For a change to request handling, run the soak as well:

```sh
node scripts/soak.js --seconds 60 --rate 25
```

It drives a mixed load (blocked, acked, rewritten and forwarded calls) against
a proxy in the same process and fails on a broken chain, a counter that drifts
from what was sent, a descriptor count that does not settle after the run, or a
heap that keeps growing in the second half. RSS is printed but not judged: V8
reserves heap and does not give it back, so warm-up growth is not a leak.

The heap figure to watch is *reserved*, not used: V8 grows the reservation while
the load ramps and then plateaus, while `heapUsed` shows the GC sawtooth either
way. A reservation that keeps climbing over a long run is the shape of a leak.
`--json` includes the per-second samples so the shape is visible.

Add `--segment-bytes 8000` to force rotation every few entries and verify the
chain across dozens of segments under the same load.

## Rule changes

Rules are data. Adding an endpoint is a `rules/core.json` change plus:

- a case in `test/rules.test.js`,
- a response test in `test/proxy.test.js`,
- a line in `docs/RULES.md` if the action is new.

Prefer an exact path. Use a version-tolerant pattern only when the version is
the only thing that moves, and anchor it.

## Style

- Node ESM, no TypeScript in this repo.
- Comments explain *why*, especially where a choice looks odd.
- Keep the CLI's output aligned and lowercase; scripts consume it.
- No new runtime dependency without a very good reason. The whole tool is
  standard library.

## Commits and PRs

Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), one concern
per commit. Open an issue for anything larger than a typo; the issue templates
ask for the two things that matter (a reproduction and a rule/journal excerpt).

By contributing you agree your work is licensed under Apache-2.0.
