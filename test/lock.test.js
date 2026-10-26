import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock, inspectLock, releaseLock } from "../src/lock.js";

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function lockFile() {
  const path = join(mkdtempSync(join(tmpdir(), "blackout-lock-")), "blackout.lock");
  dirs.push(dirname(path));
  return path;
}

const isLiveProxy = () => true;

test("a free state directory is claimed, and the claim names the port", () => {
  const path = lockFile();
  const claim = acquireLock({ path, port: 8790, pid: 4242 });
  assert.equal(claim.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { pid: 4242, port: 8790, at: claim.holder.at });
});

test("a live claim is refused, and names who holds it", () => {
  const path = lockFile();
  acquireLock({ path, port: 8790, pid: 4242 });
  const second = acquireLock({ path, port: 8791, pid: 4343, isProxy: isLiveProxy });
  assert.equal(second.ok, false);
  assert.equal(second.holder.pid, 4242);
  assert.equal(second.holder.port, 8790);
  // The refused starter must not have overwritten the claim.
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 4242);
});

test("a claim left by a dead pid is taken over", () => {
  const path = lockFile();
  acquireLock({ path, port: 8790, pid: 4242 });
  // `isProxy` is the liveness test: a pid that is no longer the proxy is stale,
  // which is what a crash leaves behind.
  const second = acquireLock({ path, port: 8791, pid: 4343, isProxy: () => false });
  assert.equal(second.ok, true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 4343);
});

test("a garbled claim is taken over instead of wedging every start", () => {
  const path = lockFile();
  writeFileSync(path, "{ this is not json");
  const claim = acquireLock({ path, port: 8790, pid: 4242, isProxy: isLiveProxy });
  assert.equal(claim.ok, true);
  assert.equal(inspectLock({ path, isProxy: isLiveProxy }).pid, 4242);
});

test("a claim with an impossible pid is treated as stale", () => {
  const path = lockFile();
  writeFileSync(path, JSON.stringify({ pid: 0, port: 8790 }));
  assert.equal(inspectLock({ path, isProxy: isLiveProxy }), null);
  assert.equal(acquireLock({ path, port: 8791, pid: 4343, isProxy: isLiveProxy }).ok, true);
});

test("release removes only its own claim", () => {
  const path = lockFile();
  acquireLock({ path, port: 8790, pid: 4242 });
  assert.equal(releaseLock({ path, pid: 4343 }), false);
  assert.equal(inspectLock({ path, isProxy: isLiveProxy }).pid, 4242);
  assert.equal(releaseLock({ path, pid: 4242 }), true);
  assert.equal(inspectLock({ path, isProxy: isLiveProxy }), null);
});

test("releasing an absent claim is not an error", () => {
  const path = lockFile();
  assert.equal(releaseLock({ path, pid: 4242 }), false);
});
