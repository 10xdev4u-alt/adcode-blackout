/**
 * The soak is a gate, so it has to be honest about what it measured.
 *
 * It once divided the achieved rate by wall time that included its own
 * five-second settle sleep, and a 60/s run that actually delivered 58.8/s
 * reported 44/s and failed. A gate that cries wolf gets ignored, so the rate
 * denominator is pinned here: the load window, not the whole run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOAK = fileURLToPath(new URL("../scripts/soak.js", import.meta.url));
const SECONDS = 3;
const RATE = 40;

function runSoak() {
  const result = spawnSync(process.execPath, [SOAK, "--seconds", String(SECONDS), "--rate", String(RATE), "--json"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `soak exited ${result.status}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

test("the soak reports the rate it actually sustained, and excludes its own settle", () => {
  const summary = runSoak();
  assert.equal(summary.ok, true, `soak failed: ${summary.problems.join("; ")}`);
  // The load window is the run; the settle comes after it and must not count.
  assert.ok(summary.loadSeconds >= SECONDS && summary.loadSeconds < SECONDS + 2, `load window ${summary.loadSeconds}s`);
  assert.ok(summary.seconds > summary.loadSeconds, `total ${summary.seconds}s should include the settle`);
  // 80% is the gate's own floor; the point is that it holds at a rate the
  // machine can push, with ~58/60 in the real runs.
  assert.ok(summary.achievedRate >= RATE * 0.8, `achieved ${summary.achievedRate}/s of ${RATE}/s`);
  assert.ok(summary.missed >= 0, `missed ${summary.missed}`);
  // Counters come from the journal, not the client, so a drift shows up here.
  assert.equal(summary.decisions.blocked, summary.requests.serve, "blocked count matches the serves sent");
  assert.equal(summary.decisions.acked, summary.requests.receipts, "acked count matches the receipt batches sent");
  assert.equal(summary.decisions.rewritten, summary.requests.config, "rewrite count matches the configs sent");
  assert.equal(summary.decisions.entries, summary.decisions.onDisk, "every journal entry reached the file");
});
