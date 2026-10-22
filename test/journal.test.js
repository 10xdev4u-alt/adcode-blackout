import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal, GENESIS, readJournal, summarize, verifyChain } from "../src/journal.js";

function tempJournal() {
  return join(mkdtempSync(join(tmpdir(), "blackout-journal-")), "journal.jsonl");
}

test("a fresh chain starts at genesis and verifies", () => {
  const journal = createJournal();
  journal.append("serve-blocked", { path: "/v1/serve" });
  assert.equal(journal.entries[0].prev, GENESIS);
  assert.deepEqual(verifyChain(journal.entries), { ok: true, brokenAt: null });
});

test("a chain survives a restart and continues from the last hash", () => {
  const path = tempJournal();
  const first = createJournal(path);
  first.append("serve-blocked", { n: 1 });
  first.append("receipt-blocked", { n: 2 });

  const second = createJournal(path);
  assert.equal(second.entries.length, 2);
  assert.equal(second.head(), first.head());
  second.append("serve-blocked", { n: 3 });

  const entries = readJournal(path);
  assert.equal(entries.length, 3);
  assert.equal(entries[2].seq, 2);
  assert.deepEqual(verifyChain(entries), { ok: true, brokenAt: null });
});

test("editing a line breaks the chain at that line", () => {
  const journal = createJournal();
  journal.append("a", { n: 1 });
  journal.append("b", { n: 2 });
  journal.append("c", { n: 3 });

  const tampered = structuredClone(journal.entries);
  tampered[1].data.n = 99;
  assert.deepEqual(verifyChain(tampered), { ok: false, brokenAt: 1 });
});

test("deleting a line breaks the chain at the gap", () => {
  const journal = createJournal();
  journal.append("a", { n: 1 });
  journal.append("b", { n: 2 });
  journal.append("c", { n: 3 });

  assert.deepEqual(verifyChain([journal.entries[0], journal.entries[2]]), { ok: false, brokenAt: 1 });
});

test("a truncated final line is dropped, not fatal", () => {
  const path = tempJournal();
  const journal = createJournal(path);
  journal.append("a", { n: 1 });
  journal.append("b", { n: 2 });
  const { appendFileSync } = require("node:fs");
  appendFileSync(path, '{"seq":2,"at":');

  const entries = readJournal(path);
  assert.equal(entries.length, 2);
  assert.deepEqual(verifyChain(entries), { ok: true, brokenAt: null });
});

test("summarize counts each kind", () => {
  const journal = createJournal();
  journal.append("serve-blocked", {});
  journal.append("serve-blocked", {});
  journal.append("receipt-blocked", {});
  assert.deepEqual(summarize(journal.entries), { "serve-blocked": 2, "receipt-blocked": 1 });
});
