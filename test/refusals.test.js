/**
 * The refusals at the library edges, and what a claim is when it is not one.
 *
 * Each of these fires only when something is already wrong: a rule pack nobody
 * can honour, a policy flag that is not a flag, a lock file naming a process
 * that is not the proxy, a journal that cannot be written. They are never on the
 * happy path and each one decides whether the tool stops, degrades, or does the
 * wrong thing quietly - which is why they are pinned here rather than trusted.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validatePack } from "../src/rules.js";
import { parsePolicy } from "../src/policy.js";
import { describePid, isBlackoutPid, listenerPid } from "../src/netinfo.js";
import { acquireLock, inspectLock, releaseLock } from "../src/lock.js";
import { createJournal, readJournalChain } from "../src/journal.js";
import { unitEnabled } from "../src/desktop.js";

const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `blackout-${name}-`));
  dirs.push(dir);
  return dir;
}

const isLinux = process.platform === "linux";

const oneRule = (over = {}) => ({
  id: "serve",
  match: { method: "POST", path: "/v1/serve" },
  action: "block",
  ...over,
});

test("a rule pack that cannot be honoured is refused by name, not by a stack trace", () => {
  const refuses = (pack, pattern) => assert.throws(() => validatePack(pack), pattern);
  refuses(null, /rule pack must be an object/);
  refuses({ name: "Core Pack", rules: [oneRule()] }, /rule pack name is invalid/);
  refuses({ name: "core", rules: [] }, /rule pack needs at least one rule/);
  refuses({ name: "core", rules: [null] }, /rule 0 is not an object/);
  refuses({ name: "core", rules: [oneRule({ id: "Serve!" })] }, /rule 0 has an invalid id/);
  refuses({ name: "core", rules: [oneRule({ action: "vanish" })] }, /unknown action: vanish/);
  refuses({ name: "core", rules: [oneRule({ match: null })] }, /rule serve needs a match/);
  refuses({ name: "core", rules: [oneRule({ match: { method: "TRACE", path: "/v1/serve" } })] }, /invalid method/);
  refuses({ name: "core", rules: [oneRule({ match: { method: "POST" } })] }, /exactly one of path or pathPattern/);
  refuses(
    { name: "core", rules: [oneRule({ match: { method: "POST", path: "/v1/serve", pathPattern: "^/v2/serve$" } })] },
    /exactly one of path or pathPattern/,
  );
  refuses({ name: "core", rules: [oneRule({ match: { method: "POST", path: "v1/serve" } })] }, /path must start with \//);
  // Two rules with one id make "which rule matched" unanswerable in the journal.
  refuses(
    { name: "core", rules: [oneRule(), oneRule({ match: { method: "POST", path: "/v1/receipts" } })] },
    /duplicate rule id: serve/,
  );
});

test("a rule pack that states no version is version 1", () => {
  const pack = validatePack({ name: "core", rules: [oneRule()] });
  assert.equal(pack.version, 1);
  assert.equal(validatePack({ name: "core", version: 3, rules: [oneRule()] }).version, 3);
});

test("a policy flag that is not a flag is refused by name", () => {
  assert.throws(() => parsePolicy({ enabled: "yes" }), /enabled must be boolean/);
  assert.throws(() => parsePolicy({ dashboard: 1 }), /dashboard must be boolean/);
  // The pack name becomes a path in the config directory; only its own shape.
  assert.throws(() => parsePolicy({ rules: "../../etc/passwd" }), /rules must be a rule pack name/);
  assert.throws(() => parsePolicy({ rules: "" }), /rules must be a rule pack name/);
});

test("a pid that is not a process is not the proxy", { skip: !isLinux }, () => {
  // Above any pid_max: readFileSync throws ENOENT, and "I cannot look" is not
  // "this is the proxy" - a recycled pid number would otherwise be a licence to
  // kill whatever now holds it.
  const missing = 9_999_999;
  assert.equal(isBlackoutPid(missing), false);
  assert.equal(describePid(missing), `pid ${missing}`);
});

test("a pid that is a process, but not serving, is not the proxy", { skip: !isLinux }, () => {
  // This very process: a command line that mentions nothing of blackout's.
  assert.equal(isBlackoutPid(process.pid), false);
  assert.match(describePid(process.pid), /^pid \d+: .*node/);
});

test("a port that cannot exist has no owner", () => {
  assert.equal(listenerPid(0), null);
  assert.equal(listenerPid(65_536), null);
  assert.equal(listenerPid(1.5), null);
  assert.equal(listenerPid("8790"), null);
});

test("a lock file that is not a claim is stale, and one with junk fields keeps its pid", () => {
  const path = join(tempDir("lock-junk"), "blackout.lock");
  const live = () => true;
  for (const body of ["null", "42", '"4242"', "[]"]) {
    writeFileSync(path, body);
    assert.equal(inspectLock({ path, isProxy: live }), null, `${body} is not a claim`);
  }
  // A pid is the part that decides; the port and the time are decoration, and a
  // garbled one must not turn a claim into no claim at all.
  writeFileSync(path, JSON.stringify({ pid: 4242, port: "8790", at: 1.5 }));
  assert.deepEqual(inspectLock({ path, isProxy: live }), { pid: 4242, port: null, at: null });
});

test("a claim naming a process that is no longer the proxy is not a claim", () => {
  const path = join(tempDir("lock-dead"), "blackout.lock");
  assert.equal(acquireLock({ path, port: 8790, pid: 4242 }).ok, true);
  assert.equal(inspectLock({ path, isProxy: () => false }), null);
  assert.equal(inspectLock({ path, isProxy: () => true }).pid, 4242);
});

test("a claim that cannot be removed says so instead of pretending it was", () => {
  const dir = tempDir("lock-readonly");
  const path = join(dir, "blackout.lock");
  assert.equal(acquireLock({ path, port: 8790, pid: 4242 }).ok, true);
  // The state directory turned read-only under a stop: the file is still the
  // claim it was, and a caller told `true` would believe the next start is free.
  chmodSync(dir, 0o500);
  try {
    assert.equal(releaseLock({ path, pid: 4242 }), false);
    assert.equal(existsSync(path), true);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(releaseLock({ path, pid: 4242 }), true);
});

test("a journal that cannot be written keeps the entry and says the file is behind", () => {
  const path = join(tempDir("journal-readonly"), "journal.jsonl");
  const journal = createJournal(path);
  journal.append("serve-blocked", { count: 1 });
  assert.equal(journal.writeError, null);

  chmodSync(path, 0o400);
  try {
    journal.append("serve-blocked", { count: 1 });
    assert.notEqual(journal.writeError, null, "the failure is reported rather than swallowed");
    assert.match(journal.writeError.message, /EACCES|permission/i);
    // The decision was still made, still counted, and still in the record: what
    // was lost is the file, not the audit trail in this process.
    assert.equal(journal.summary().counts["serve-blocked"], 2);
    assert.equal(journal.entries.length, 2);
  } finally {
    chmodSync(path, 0o600);
  }

  const onDisk = readJournalChain(path);
  assert.equal(onDisk.length, 1, "the file holds what it managed to write");
  assert.equal(journal.writeError.message.includes("EACCES"), true);
});

test("a state directory that was never created reads as an empty journal", () => {
  const missing = join(tempDir("journal-missing"), "state", "journal.jsonl");
  assert.deepEqual(readJournalChain(missing), []);
  assert.deepEqual(readJournalChain(join(dirname(missing), "gone.jsonl")), []);
});

test("a unit that was never installed is not enabled", () => {
  const home = tempDir("home");
  assert.equal(unitEnabled(home), false);
});
