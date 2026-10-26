import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJournal, GENESIS, readJournal, readJournalChain, summarize, verifyChain } from "../src/journal.js";
import { buildReport } from "../src/report.js";

const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempJournal() {
  const path = join(mkdtempSync(join(tmpdir(), "blackout-journal-")), "journal.jsonl");
  dirs.push(dirname(path));
  return path;
}

test("a crash between the rotation rename and the new live file resumes cleanly", () => {
  /*
   * Rotation is two syscalls: rename the live file to a segment, then create an
   * empty one. A process killed between them leaves no live file at all, and
   * the next start has to continue the chain from the segment rather than treat
   * the history as missing and begin again at genesis.
   */
  const path = tempJournal();
  const first = createJournal(path, { maxBytes: 200 });
  for (let index = 0; index < 4; index += 1) first.append("serve-blocked", { index });
  renameSync(path, join(dirname(path), "journal.9999.jsonl"));

  const resumed = createJournal(path, { maxBytes: 200 });
  resumed.append("resumed", {});

  const chain = readJournalChain(path);
  assert.deepEqual(verifyChain(chain), { ok: true, brokenAt: null });
  // Sequence numbers keep counting across the gap in the file names, and the
  // high-numbered segment sorts after the ones that came before it.
  assert.equal(chain.at(-1).seq, chain.length - 1);
  assert.equal(chain.at(-1).kind, "resumed");
  assert.equal(resumed.head(), chain.at(-1).hash);
});

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
  appendFileSync(path, '{"seq":2,"at":');

  const entries = readJournal(path);
  assert.equal(entries.length, 2);
  assert.deepEqual(verifyChain(entries), { ok: true, brokenAt: null });
});

test("two decisions after a torn write do not corrupt the journal", () => {
  const path = tempJournal();
  const first = createJournal(path);
  first.append("a", { n: 1 });
  appendFileSync(path, '{"seq":1,"at":');

  // The crash is over; the next process appends twice. An unrepaired fragment
  // would glue itself to the first of these and leave a broken line in the
  // middle of the file, where the truncation tolerance no longer applies.
  const second = createJournal(path);
  assert.equal(second.entries.length, 1, "the half-written line is dropped");
  second.append("b", { n: 2 });
  second.append("c", { n: 3 });

  const onDisk = readJournal(path);
  assert.deepEqual(onDisk.map((entry) => entry.kind), ["a", "b", "c"]);
  assert.deepEqual(verifyChain(onDisk), { ok: true, brokenAt: null });

  // And it keeps loading: the same file after another restart.
  const third = createJournal(path);
  assert.equal(third.entries.length, 3);
  assert.equal(third.head(), second.head());
});

test("a complete final line without its newline is kept, not dropped", () => {
  const path = tempJournal();
  const first = createJournal(path);
  first.append("a", { n: 1 });
  // A crash between the write and the newline: the entry itself is whole.
  writeFileSync(path, readJournal(path).map((entry) => JSON.stringify(entry)).join("\n"));

  const second = createJournal(path);
  assert.equal(second.entries.length, 1);
  second.append("b", { n: 2 });

  const onDisk = readJournal(path);
  assert.deepEqual(onDisk.map((entry) => entry.kind), ["a", "b"]);
  assert.deepEqual(verifyChain(onDisk), { ok: true, brokenAt: null });
});

test("rotation keeps one file bounded and the chain intact", () => {
  const path = tempJournal();
  const journal = createJournal(path, { maxBytes: 600 });
  for (let index = 0; index < 12; index++) journal.append("serve-blocked", { index });

  assert.ok(journal.segments.length > 0, "at least one segment should exist");
  assert.match(journal.segments[0], /journal\.0001\.jsonl$/);

  const all = readJournalChain(path);
  assert.equal(all.length, 12);
  assert.deepEqual(all.map((entry) => entry.seq), [...Array(12).keys()]);
  assert.deepEqual(verifyChain(all), { ok: true, brokenAt: null });

  // The live file is the complement of the segments, and is smaller than the
  // segments plus the one entry that crossed the threshold.
  const live = readJournal(path);
  assert.equal(live.length + journal.segments.reduce((total, file) => total + readJournal(file).length, 0), 12);
});

test("a rotated journal resumes with the next sequence number", () => {
  const path = tempJournal();
  const first = createJournal(path, { maxBytes: 500 });
  for (let index = 0; index < 8; index++) first.append("a", { index });

  const second = createJournal(path, { maxBytes: 500 });
  assert.equal(second.entries.length, 8);
  assert.equal(second.head(), first.head());
  second.append("b", { after: true });

  const all = readJournalChain(path);
  assert.equal(all.length, 9);
  assert.equal(all.at(-1).seq, 8);
  assert.deepEqual(verifyChain(all), { ok: true, brokenAt: null });
});

test("tampering in a rotated segment is named at its absolute index", () => {
  const path = tempJournal();
  const journal = createJournal(path, { maxBytes: 500 });
  for (let index = 0; index < 8; index++) journal.append("a", { index });

  const segment = journal.segments[0];
  assert.ok(segment);
  const lines = readJournal(segment).map((entry) => JSON.stringify(entry));
  lines[1] = JSON.stringify({ ...JSON.parse(lines[1]), data: { index: 999 } });
  writeFileSync(segment, `${lines.join("\n")}\n`);

  const all = readJournalChain(path);
  assert.deepEqual(verifyChain(all), { ok: false, brokenAt: 1 });
});

test("a journal that cannot be written keeps the decision and reports the failure", () => {
  const path = tempJournal();
  const journal = createJournal(path);
  // The target becomes a directory, so every append fails with EISDIR whatever
  // user the tests run as - a chmod-based simulation passes as root.
  mkdirSync(path);

  const entry = journal.append("serve-blocked", { path: "/v1/serve" });
  assert.equal(entry.seq, 0);
  assert.equal(journal.entries.length, 1);
  assert.deepEqual(verifyChain(journal.entries), { ok: true, brokenAt: null });

  assert.notEqual(journal.writeError, null);
  assert.match(journal.writeError.message, /EISDIR/);
  assert.ok(Number.isSafeInteger(journal.writeError.at));

  // The first failure is the moment the record stopped being complete, so a
  // later failure must not move that timestamp.
  const firstFailure = journal.writeError;
  journal.append("serve-blocked", { path: "/v1/serve" });
  assert.equal(journal.entries.length, 2);
  assert.equal(journal.writeError, firstFailure);
});

test("a long journal keeps exact totals while retaining only a tail", () => {
  const journal = createJournal(null, { retainEntries: 4 });
  const payload = "x".repeat(500);
  for (let index = 0; index < 40; index++) {
    journal.append(index % 2 === 0 ? "serve-blocked" : "receipt-blocked", { index, payload, count: 2 });
  }

  const summary = journal.summary();
  assert.equal(summary.total, 40);
  assert.equal(summary.counts["serve-blocked"], 20);
  assert.equal(summary.counts["receipt-blocked"], 20);
  assert.equal(summary.receipts, 40, "quantities inside a batch are summed, not dropped");
  assert.ok(journal.entries.length <= 8, `retained ${journal.entries.length} entries`);
  assert.equal(journal.entries.at(-1).seq, 39);

  // The tail must stay a valid continuation of the chain, not a renumbering.
  const tail = journal.entries;
  assert.equal(tail[0].seq, 39 - tail.length + 1);
});

test("a report built on a tail still counts the whole journal", () => {
  const journal = createJournal(null, { retainEntries: 2 });
  for (let index = 0; index < 10; index++) journal.append("serve-blocked", { index });

  const report = buildReport(journal.entries, {
    summary: journal.summary(),
    integrity: journal.integrity,
    policy: { estimates: { secondsPerAd: 8, microsPerView: 1_500 } },
    now: 2_000,
  });
  assert.equal(report.totals.servesBlocked, 10);
  assert.equal(report.window.entries, 10);
  assert.ok(report.window.retained <= 4);
  assert.equal(report.integrity.ok, true);
});

test("a restart keeps the totals that no longer fit in memory", () => {
  const path = tempJournal();
  const first = createJournal(path, { retainEntries: 3 });
  for (let index = 0; index < 12; index++) first.append("serve-blocked", { index });

  const second = createJournal(path, { retainEntries: 3 });
  assert.equal(second.summary().total, 12);
  assert.equal(second.summary().counts["serve-blocked"], 12);
  assert.ok(second.entries.length <= 6, `retained ${second.entries.length} entries`);
  assert.equal(second.head(), first.head(), "the chain resumes where the file ends");
  assert.deepEqual(second.integrity, { ok: true, brokenAt: null });
});

test("summarize counts each kind", () => {
  const journal = createJournal();
  journal.append("serve-blocked", {});
  journal.append("serve-blocked", {});
  journal.append("receipt-blocked", {});
  assert.deepEqual(summarize(journal.entries), { "serve-blocked": 2, "receipt-blocked": 1 });
});

test("an unreadable journal names the file it could not read", () => {
  const path = tempJournal();
  mkdirSync(path);
  assert.throws(() => createJournal(path), (error) => {
    assert.match(error.message, /cannot read journal/);
    assert.ok(error.message.includes(path), error.message);
    return true;
  });
});

test("a write failure leaves a gap that verify reports after a restart", () => {
  const path = tempJournal();
  const journal = createJournal(path);
  // The target becomes a directory, so every append fails with EISDIR whatever
  // user the tests run as - a chmod-based simulation passes as root.
  mkdirSync(path);
  journal.append("lost", { n: 1 });
  journal.append("lost", { n: 2 });
  assert.notEqual(journal.writeError, null);
  assert.equal(journal.entries.length, 2, "both decisions are still in memory");

  // Writing works again; the next entry keeps its real sequence number.
  rmSync(path, { recursive: true });
  journal.append("after", { n: 3 });

  const onDisk = readJournalChain(path);
  assert.deepEqual(onDisk.map((entry) => entry.seq), [2]);
  // Entries 0 and 1 never reached disk. Renumbering would hide that; naming the
  // gap is the honest reading, and `verify` does exactly that.
  assert.deepEqual(verifyChain(onDisk), { ok: false, brokenAt: 0 });
});
