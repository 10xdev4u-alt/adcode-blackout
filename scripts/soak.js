#!/usr/bin/env node
/**
 * Run the proxy at a steady rate and look for the things unit tests cannot see:
 * a descriptor leak, a journal that stops verifying, counters that drift from
 * what was actually sent, memory that only goes one way.
 *
 *   node scripts/soak.js [--seconds 60] [--rate 25] [--json]
 *
 * Exit 0 when every sample held, 1 when something drifted. The thresholds are
 * deliberately loose: this is a smoke detector for a leak, not a benchmark.
 */
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal, readJournalChain, verifyChain } from "../src/journal.js";
import { createProxy } from "../src/proxy.js";
import { parsePolicy } from "../src/policy.js";
import { loadRulePack } from "../src/rules.js";

const MAX_FD_GROWTH = 16;
const MAX_SECOND_HALF_HEAP_BYTES = 32 * 1024 * 1024;
/** The app makes a handful of calls at once; more than this measures the pool. */
const MAX_INFLIGHT = 4;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value)) throw new TypeError(`--${name} needs an integer`);
  return value;
}

const seconds = option("seconds", 60);
const rate = option("rate", 25);
// Small enough to force rotations, large enough to keep the segment count sane.
const segmentBytes = option("segment-bytes", 5 * 1024 * 1024);

if (segmentBytes < 1024) throw new TypeError("--segment-bytes must be at least 1024");
const json = process.argv.includes("--json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function descriptors() {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

const upstream = createServer((req, res) => {
  if (req.url === "/v1/config") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ killSwitch: false, caps: { dailyCap: 40, minIntervalMs: 1_000 }, projections: { off: "0", light: "10", standard: "20", max: "30" } }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

const dir = await mkdtemp(join(tmpdir(), "blackout-soak-"));
const journal = createJournal(join(dir, "journal.jsonl"), { maxBytes: segmentBytes });
const proxy = createProxy({
  policy: parsePolicy({ port: 0, upstream: upstreamOrigin, dashboard: false }),
  journal,
  rules: loadRulePack("core"),
});
const url = await proxy.listen(0, "127.0.0.1");

const startUsage = process.memoryUsage();
const before = { rss: startUsage.rss, heapUsed: startUsage.heapUsed, fds: descriptors() };
const sent = { serve: 0, receipts: 0, config: 0, chat: 0 };
const failures = [];

const work = async (tick) => {
  // A little of each path a real session uses: blocked, acked, rewritten and
  // forwarded. The forwarded one matters most - it is the one with a socket on
  // both sides.
  const kind = tick % 4;
  try {
    if (kind === 0) {
      const res = await fetch(`${url}/v1/serve`, { method: "POST", body: JSON.stringify({ tags: ["src"], count: 2 }) });
      sent.serve++;
      if (res.status !== 200) failures.push(`serve ${res.status}`);
      const body = await res.json();
      if (body.creatives.length !== 0) failures.push("serve returned creatives");
    } else if (kind === 1) {
      const res = await fetch(`${url}/v1/receipts`, { method: "POST", body: JSON.stringify({ receipts: [{ receiptId: `r-${tick}` }] }) });
      sent.receipts++;
      if (res.status !== 200) failures.push(`receipts ${res.status}`);
      await res.json();
    } else if (kind === 2) {
      const res = await fetch(`${url}/v1/config`);
      sent.config++;
      if (res.status !== 200) failures.push(`config ${res.status}`);
      await res.json();
    } else {
      const res = await fetch(`${url}/v1/chat`, { method: "POST", body: JSON.stringify({ prompt: "hi" }) });
      sent.chat++;
      if (res.status !== 200) failures.push(`chat ${res.status}`);
      await res.text();
    }
  } catch (error) {
    failures.push(`${kind}: ${String(error?.message ?? error)}`);
  }
};

const samples = [];
const startedAt = Date.now();
let tick = 0;
let inflight = 0;
// One request per tick, so `--rate` is the rate of requests, not of batches.
// Four kinds cycle, which gives an even mix without multiplying the load.
const interval = Math.max(1, Math.round(1_000 / rate));

while (Date.now() - startedAt < seconds * 1_000) {
  const due = Math.floor((Date.now() - startedAt) / interval);
  while (tick < due) {
    // Never outrun the proxy: an unbounded queue would measure this script's
    // memory, not the proxy's.
    if (inflight >= MAX_INFLIGHT) break;
    inflight++;
    void work(tick++).finally(() => { inflight--; });
  }
  // Sleep only until the next tick is due, never a whole interval: a fixed
  // interval sleep loses its own overshoot on every iteration, so a run that
  // falls behind can never catch up.
  await sleep(Math.min(25, Math.max(1, startedAt + (tick + 1) * interval - Date.now())));
  if (samples.length < Math.floor((Date.now() - startedAt) / 1_000)) {
    const usage = process.memoryUsage();
    samples.push({ rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal, external: usage.external, arrayBuffers: usage.arrayBuffers, fds: descriptors() });
  }
}

// The load window ends here. Everything after this is measurement, and counting
// it as load time made a 60/s run report 44/s: the rate was divided by the
// settle sleep as well as by the run.
const loadedAt = Date.now();

// Let the last requests finish, then give the client pool a moment to close its
// idle sockets: descriptors measured while keep-alive is still holding them are
// not a proxy leak.
const drainBy = Date.now() + 10_000;
while (inflight > 0 && Date.now() < drainBy) await sleep(20);
await sleep(5_000);

const loadSeconds = (loadedAt - startedAt) / 1_000;
const missed = Math.floor((loadedAt - startedAt) / interval) - tick;
const settled = process.memoryUsage();
const settledDetail = { heapTotal: settled.heapTotal, external: settled.external, arrayBuffers: settled.arrayBuffers };
const after = { rss: settled.rss, heapUsed: settled.heapUsed, fds: descriptors() };
await proxy.close();
await new Promise((resolve) => upstream.close(resolve));

const onDisk = readJournalChain(join(dir, "journal.jsonl"));
const chain = verifyChain(onDisk);
const elapsed = (Date.now() - startedAt) / 1_000;

const peakRss = Math.max(before.rss, after.rss, ...samples.map((sample) => sample.rss));
const peakFds = Math.max(before.fds ?? 0, after.fds ?? 0, ...samples.map((sample) => sample.fds ?? 0));
const rssGrowth = peakRss - before.rss;
// Descriptors are judged on the settled count, not the peak: sockets that were
// open during a burst are not a leak. The per-second samples above are there to
// show the shape in --json.
const fdGrowth = (after.fds ?? 0) - (before.fds ?? 0);
// A leak grows with work; a healthy process plateaus. Compare the heap at the
// midpoint with the heap at the end, after the pool has settled.
const midpoint = samples[Math.floor(samples.length / 2)] ?? null;
const secondHalfHeapGrowth = midpoint === null ? 0 : after.heapUsed - midpoint.heapUsed;

// Totals from the journal's counters, not from the retained tail: the point of
// the tail is that it stops growing, so counting it would undercount the run.
const totals = journal.summary();
const blocked = totals.counts["serve-blocked"] ?? 0;
const acked = totals.receipts;
const rewritten = totals.counts["config-rewritten"] ?? 0;

const problems = [...failures.slice(0, 5)];
if (failures.length > 5) problems.push(`... and ${failures.length - 5} more`);
if (!chain.ok) problems.push(`journal chain broken at ${chain.brokenAt}`);
if (blocked !== sent.serve) problems.push(`blocked ${blocked} of ${sent.serve} serves`);
if (acked !== sent.receipts) problems.push(`acked ${acked} of ${sent.receipts} receipts`);
if (rewritten !== sent.config) problems.push(`rewrote ${rewritten} of ${sent.config} configs`);
if (secondHalfHeapGrowth > MAX_SECOND_HALF_HEAP_BYTES) problems.push(`heap kept growing in the second half: ${(secondHalfHeapGrowth / 1024 / 1024).toFixed(1)} MiB`);
if (totals.total !== totals.retained && journal.entries.length > 6_000) problems.push(`journal retained ${journal.entries.length} entries`);
if (totals.total !== onDisk.length) problems.push(`journal counted ${totals.total} but wrote ${onDisk.length}`);
if (fdGrowth > MAX_FD_GROWTH) problems.push(`descriptors grew by ${fdGrowth}`);
const achievedRate = tick / loadSeconds;
if (achievedRate < rate * 0.8) problems.push(`only ${achievedRate.toFixed(1)} of ${rate}/s achieved`);

const summary = {
  loadSeconds: Number(loadSeconds.toFixed(1)),
  seconds: elapsed,
  requests: sent,
  decisions: { blocked, acked, rewritten, entries: totals.total, retained: journal.entries.length, onDisk: onDisk.length, segments: journal.segments.length },
  rssMiB: { start: Number((before.rss / 1024 / 1024).toFixed(1)), peak: Number((peakRss / 1024 / 1024).toFixed(1)), growth: Number((rssGrowth / 1024 / 1024).toFixed(1)) },
  detailMiB: { heapTotal: Math.round(settledDetail.heapTotal / 1048576), external: Math.round(settledDetail.external / 1048576), arrayBuffers: Math.round(settledDetail.arrayBuffers / 1048576) },
  heapMiB: { start: Number((before.heapUsed / 1024 / 1024).toFixed(1)), end: Number((after.heapUsed / 1024 / 1024).toFixed(1)), secondHalf: Number((secondHalfHeapGrowth / 1024 / 1024).toFixed(1)) },
  missed,
  achievedRate: Number(achievedRate.toFixed(1)),
  samples: samples.map((sample) => ({ rss: Math.round(sample.rss / 1048576), heap: Math.round(sample.heapUsed / 1048576), total: Math.round(sample.heapTotal / 1048576), ext: Math.round(sample.external / 1048576), bufs: Math.round(sample.arrayBuffers / 1048576), fds: sample.fds })),
  fds: { start: before.fds, peak: peakFds, growth: fdGrowth },
  ok: problems.length === 0,
  problems,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`soak ${summary.loadSeconds.toFixed(1)}s of load at ${rate}/s (${summary.seconds.toFixed(1)}s including settle)`);
  console.log(`requests   ${sent.serve} serve, ${sent.receipts} receipts, ${sent.config} config, ${sent.chat} chat`);
  console.log(`decisions  ${blocked} blocked, ${acked} acked, ${rewritten} rewritten (${totals.total} total, ${journal.entries.length} retained, ${onDisk.length} on disk, ${journal.segments.length} segment(s))`);
  // RSS is reported, not judged: V8 reserves heap and does not hand it back, so
  // a growing RSS during warm-up is normal. A real leak shows up as heap that
  // keeps climbing in the second half, and that is what fails the run.
  console.log(`memory     ${summary.rssMiB.start} MiB -> peak ${summary.rssMiB.peak} MiB (reserved, not judged)`);
  // Used *and* reserved: V8 grows the reservation while the load ramps, then
  // plateaus. A reservation that keeps climbing is the shape of a leak; the
  // used figure alone just shows the GC sawtooth.
  console.log(`heap       ${summary.heapMiB.start} MiB -> ${summary.heapMiB.end} MiB used of ${summary.detailMiB.heapTotal} MiB reserved (second half ${summary.heapMiB.secondHalf >= 0 ? "+" : ""}${summary.heapMiB.secondHalf})`);
  console.log(`fds        ${before.fds} -> peak ${peakFds}, settled ${after.fds}`);
  console.log(`chain      ${chain.ok ? "ok" : `BROKEN at ${chain.brokenAt}`}`);
  for (const problem of problems) console.log(`  ! ${problem}`);
  console.log(problems.length === 0 ? "soak: ok" : "soak: FAILED");
}

await rm(dir, { recursive: true, force: true });
process.exit(problems.length === 0 ? 0 : 1);
