# adcode-blackout

A path-scoped ad blocker for ADCode. It runs a local server where ADCode expects
its ad server, answers the two money endpoints itself, and streams everything
else through untouched.

- **No sponsored cards.** `/v1/serve` returns an empty inventory.
- **No receipts.** `/v1/receipts` is acknowledged locally and never forwarded.
- **No broken features.** Auth, balance, assets and AI calls stream through.
- **Proof, not promises.** Every blocked call is written to a hash-chained
  journal and summarized by `blackout report`.

Linux AppImage first. Web extension and other platforms next.

> Independent project. Not affiliated with ADCode. Apache-2.0.
