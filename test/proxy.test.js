import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxy } from "../src/proxy.js";
import { createJournal } from "../src/journal.js";
import { parsePolicy } from "../src/policy.js";
import { loadRulePack } from "../src/rules.js";

const rules = loadRulePack("core");
let upstream;
let upstreamOrigin;
let hits;
let seenConfigAuth = null;

/**
 * The upstream fixture, named so a test can restore it.
 *
 * One test has to take the upstream away to test a 502; rebuilding it with the
 * same handler is what keeps every test after it honest. A stand-in that only
 * answers `{}` silently changes what all of them are measuring.
 */
function handleUpstream(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/v1/serve") { hits.serve++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ creatives: [] })); return; }
    if (req.url === "/v1/receipts") { hits.receipts++; res.writeHead(200); res.end("{}"); return; }
    if (req.url === "/v1/config") { hits.config++; seenConfigAuth = req.headers.authorization ?? null; res.writeHead(200); res.end(JSON.stringify({ killSwitch: false, caps: { dailyCap: 40, minIntervalMs: 1000 }, projections: { off: "0", light: "10", standard: "20", max: "30" }, extra: "ignored" })); return; }
    if (req.url === "/v1/balance") { hits.balance++; res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" }); res.end(JSON.stringify({ availableMicros: "1080000", lifetimeMicros: "5400000" })); return; }
    // Byte-exact and pre-compressed payloads: the "piped byte for byte" claim.
    if (req.url === "/v1/binary") { res.writeHead(200, { "content-type": "application/octet-stream", etag: '"abc"' }); res.end(Buffer.from([0, 1, 2, 3, 255, 254])); return; }
    if (req.url === "/v1/gzip") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); res.end(gzipSync(Buffer.from("hello hello hello"))); return; }
    hits.other++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ method: req.method, url: req.url, body: body || null, auth: req.headers.authorization ?? null }));
  });
}

before(async () => {
  hits = { serve: 0, receipts: 0, config: 0, balance: 0, other: 0 };
  upstream = createServer(handleUpstream);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
});

after(async () => {
  upstream.closeAllConnections?.();
  await new Promise((resolve) => upstream.close(resolve));
});

let dir;
let journal;
let proxy;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "blackout-proxy-"));
  journal = createJournal(join(dir, "journal.jsonl"));
  const policy = parsePolicy({ upstream: upstreamOrigin, dashboard: true });
  proxy = createProxy({ policy, journal, rules });
  await proxy.listen(0, "127.0.0.1");
});

afterEach(async () => {
  await proxy.close();
  rmSync(dir, { recursive: true, force: true });
});

test("serve is answered locally and never reaches the upstream", async () => {
  const before = hits.serve;
  const res = await fetch(`${proxy.url}/v1/serve`, { method: "POST", body: JSON.stringify({ tags: [], themeKind: "dark", count: 2 }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { creatives: [] });
  assert.equal(hits.serve, before);
});

test("receipts are acked so the client queue drains, and are not forwarded", async () => {
  const before = hits.receipts;
  const res = await fetch(`${proxy.url}/v1/receipts`, {
    method: "POST",
    body: JSON.stringify({ receipts: [{ receiptId: "abc-123" }, { receiptId: "def_456" }] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { acked: ["abc-123", "def_456"] });
  assert.equal(hits.receipts, before);
});

test("a malformed receipt id is never acked", async () => {
  const res = await fetch(`${proxy.url}/v1/receipts`, { method: "POST", body: JSON.stringify({ receipts: [{ receiptId: "bad id!" }] }) });
  assert.deepEqual(await res.json(), { acked: [] });
  assert.equal(res.status, 200);
});

test("malformed receipts body is a 400, not a crash", async () => {
  const res = await fetch(`${proxy.url}/v1/receipts`, { method: "POST", body: "{not json" });
  assert.equal(res.status, 400);
});

test("config is rewritten off, with only the keys the client validates", async () => {
  const res = await fetch(`${proxy.url}/v1/config`, { headers: { authorization: "Bearer test-token" } });
  const body = await res.json();
  assert.equal(body.killSwitch, true);
  assert.deepEqual(body.caps, { minIntervalMs: 1000, dailyCap: 0 });
  // Projections are repaired, not invented: a number the client can render survives,
  // anything else becomes zero. The kill switch is what stops the ad.
  assert.deepEqual(body.projections, { off: "0", light: "10", standard: "20", max: "30" });
  assert.deepEqual(Object.keys(body).sort(), ["caps", "killSwitch", "projections"]);
  assert.equal(body.extra, undefined);
  assert.equal(seenConfigAuth, "Bearer test-token");
});

test("balance passes through byte for byte and keeps upstream headers", async () => {
  const res = await fetch(`${proxy.url}/v1/balance`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-upstream"), "yes");
  assert.deepEqual(await res.json(), { availableMicros: "1080000", lifetimeMicros: "5400000" });
});

test("unknown endpoints pass through with method, body and auth intact", async () => {
  const res = await fetch(`${proxy.url}/v1/chat?stream=1`, {
    method: "POST",
    headers: { authorization: "Bearer user-token" },
    body: JSON.stringify({ prompt: "hi" }),
  });
  const body = await res.json();
  assert.equal(body.method, "POST");
  assert.equal(body.url, "/v1/chat?stream=1");
  assert.equal(body.auth, "Bearer user-token");
  assert.equal(body.body, JSON.stringify({ prompt: "hi" }));
});

test("an ad-like path outside the rule pack is recorded once", async () => {
  await fetch(`${proxy.url}/v1/sponsors`, { method: "GET" }).then((r) => r.text());
  await fetch(`${proxy.url}/v1/sponsors`, { method: "GET" }).then((r) => r.text());
  const seen = journal.entries.filter((e) => e.kind === "endpoint-seen");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.path, "/v1/sponsors");
});

test("discovery stops recording endpoints at a fixed limit", async () => {
  // Any page can POST to loopback with a loopback Host, and each new ad-like
  // path would otherwise cost a Set entry and a journal line of its choosing.
  const before = journal.entries.filter((entry) => entry.kind === "endpoint-seen").length;
  for (let index = 0; index < 300; index++) await fetch(`${proxy.url}/v1/ads/${index}`);
  const seen = journal.entries.filter((entry) => entry.kind === "endpoint-seen").length;
  assert.ok(seen - before <= 256, `recorded ${seen - before} endpoints`);
  assert.equal(journal.entries.filter((entry) => entry.kind === "discovery-capped").length, 1);

  await fetch(`${proxy.url}/v1/ads/one-more`);
  assert.equal(journal.entries.filter((entry) => entry.kind === "endpoint-seen").length, seen);
});

test("setRules swaps the pack without restarting the server", async () => {
  const before = await fetch(`${proxy.url}/v1/extra`, { method: "POST", body: "{}" });
  assert.equal(before.status, 200, "core has no rule for this path, so it passes");

  proxy.setRules({
    name: "test",
    version: 1,
    rules: [{ id: "extra", action: "block", method: "POST", path: "/v1/extra", pattern: null, since: null, note: "" }],
  });
  const after = await fetch(`${proxy.url}/v1/extra`, { method: "POST", body: "{}" });
  assert.equal(after.status, 403);
  assert.equal(journal.entries.at(-1).kind, "request-blocked");
});

test("the AI path is never mistaken for an ad endpoint", async () => {
  await fetch(`${proxy.url}/v1/chat`, { method: "POST", body: "{}" }).then((r) => r.text());
  assert.equal(journal.entries.filter((e) => e.kind === "endpoint-seen").length, 0);
});

test("an unwritable journal still blocks, and names the failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blackout-unwritable-"));
  const path = join(dir, "journal.jsonl");
  const unwritable = createJournal(path);
  mkdirSync(path); // every append now fails with EISDIR, for any user id

  const degraded = createProxy({ policy: parsePolicy({ upstream: upstreamOrigin }), journal: unwritable, rules });
  await degraded.listen(0, "127.0.0.1");
  try {
    // The whole point: the ad is still stopped even though the record cannot be kept.
    const res = await fetch(`${degraded.url}/v1/serve`, { method: "POST", body: JSON.stringify({ count: 1 }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { creatives: [] });

    const health = await (await fetch(`${degraded.url}/_blackout/health`)).json();
    assert.match(health.journalWriteError.message, /EISDIR/);

    const report = await (await fetch(`${degraded.url}/_blackout/report`)).json();
    assert.equal(report.totals.servesBlocked, 1);
    assert.match(report.journalWriteError.message, /EISDIR/);
  } finally {
    await degraded.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pause forwards ads again, and resume blocks them again", async () => {
  const denied = await fetch(`${proxy.url}/_blackout/pause`, { method: "POST" });
  assert.equal(denied.status, 403);

  const before = hits.serve;
  const paused = await fetch(`${proxy.url}/_blackout/pause`, { method: "POST", headers: { "x-blackout-control": "1" } });
  assert.deepEqual(await paused.json(), { enabled: false });
  const forwarded = await fetch(`${proxy.url}/v1/serve`, { method: "POST", body: "{}" });
  assert.equal(forwarded.status, 200);
  assert.equal(hits.serve, before + 1);

  const resumed = await fetch(`${proxy.url}/_blackout/resume`, { method: "POST", headers: { "x-blackout-control": "1" } });
  assert.deepEqual(await resumed.json(), { enabled: true });
});

test("a non-loopback Host is refused, even for local endpoints", async () => {
  const port = proxy.server.address().port;
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/_blackout/pause",
      method: "POST",
      headers: { host: "evil.example", "x-blackout-control": "attacker" },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 421);
  assert.equal(proxy.enabled, true, "the pause must not have been applied");

  const rejected = journal.entries.filter((entry) => entry.kind === "host-rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].data.host, "evil.example");
});

test("localhost is a loopback Host too", async () => {
  const port = proxy.server.address().port;
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/_blackout/health",
      headers: { host: `localhost:${port}` },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 200);
});

test("health reports integrity and version", async () => {
  const body = await (await fetch(`${proxy.url}/_blackout/health`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.enabled, true);
  assert.match(body.version, /^\d+\.\d+\.\d+/);
  assert.match(body.journalHead, /^[0-9a-f]{64}$/);
});

test("dashboard renders and carries no remote assets", async () => {
  const res = await fetch(`${proxy.url}/_blackout/dashboard`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(html, /Blackout/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:js|css)/i);
});

test("the event stream sends the journal as it happens", async () => {
  const ac = new AbortController();
  const res = await fetch(`${proxy.url}/_blackout/events`, { signal: ac.signal });
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /retry: 3000/);
  await fetch(`${proxy.url}/v1/serve`, { method: "POST", body: "{}" });
  let text = "";
  for (let i = 0; i < 5 && !text.includes("serve-blocked"); i++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  assert.match(text, /serve-blocked/);
  ac.abort();
});

test("the replay can be narrowed to one entry, or none", async () => {
  for (let i = 0; i < 3; i++) journal.append("probe", { i });

  const newest = new AbortController();
  const one = await fetch(`${proxy.url}/_blackout/events?tail=1`, { signal: newest.signal });
  const reader = one.body.getReader();
  let text = "";
  for (let reads = 0; reads < 5 && !text.includes("data: "); reads++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  assert.match(text, /"i":2/, "the single replayed entry is the latest");
  assert.doesNotMatch(text, /"i":1,/);
  assert.doesNotMatch(text, /"i":0,/);
  newest.abort();

  // `slice(-0)` is the whole array, so zero has to be handled before slicing.
  const noneAbort = new AbortController();
  const none = await fetch(`${proxy.url}/_blackout/events?tail=0`, { signal: noneAbort.signal });
  const noneReader = none.body.getReader();
  text = new TextDecoder().decode((await noneReader.read()).value);
  assert.equal(text.trim(), "retry: 3000", "only the retry hint, no history");
  noneAbort.abort();
});

test("a subscriber that stops reading is cut off, not buffered forever", async () => {
  // The dashboard and `blackout events` both read this stream. A suspended tab
  // sends nothing and closes nothing, so an unchecked `res.write` on a full
  // socket turns every later decision into heap that is never given back.
  const socket = connect(Number(new URL(proxy.url).port), "127.0.0.1");
  socket.on("error", () => {});
  socket.write("GET /_blackout/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n");
  await new Promise((resolve) => socket.once("data", resolve));
  assert.equal(journal.subscribers, 1);
  socket.pause();

  // Well past any kernel socket buffer, so only the stream limit can stop it.
  const payload = "x".repeat(4_000);
  for (let i = 0; i < 8_000 && journal.subscribers > 0; i++) {
    journal.append("probe", { i, payload });
    if (i % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(journal.subscribers, 0, "a stalled subscriber should be disconnected and dropped");
  socket.destroy();
});

test("a subscriber that keeps reading is not cut off", async () => {
  const ac = new AbortController();
  const res = await fetch(`${proxy.url}/_blackout/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  await reader.read();
  const payload = "x".repeat(4_000);
  let text = "";
  const decoder = new TextDecoder();
  for (let i = 0; i < 300; i++) {
    journal.append("probe", { i, payload });
    for (let reads = 0; reads < 20 && !text.includes(`"i":${i},`); reads++) {
      const chunk = await reader.read(); // drain as a real client would
      assert.equal(chunk.done, false, "a reading subscriber should stay connected");
      text = (text + decoder.decode(chunk.value)).slice(-8_000);
    }
    assert.match(text, new RegExp(`"i":${i},`));
    assert.equal(journal.subscribers, 1, "a reading subscriber should stay subscribed");
  }
  ac.abort();
});

test("close lets an answer that is already in flight land", async () => {
  // SIGTERM is `uninstall`, Ctrl-C and `systemctl restart`. Destroying the
  // connection on the spot turned a request the app was waiting on into "fetch
  // failed" 26 ms after the signal.
  const slow = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ made: "it" }));
    }, 300);
  });
  await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));

  const journal = createJournal();
  const own = createProxy({ policy: parsePolicy({ port: 0, upstream: `http://127.0.0.1:${slow.address().port}` }), journal, rules });
  const url = await own.listen(0, "127.0.0.1");
  try {
    const inFlight = fetch(`${url}/v1/balance`).then(async (response) => ({ status: response.status, body: await response.text() }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedAt = Date.now();
    const closing = own.close({ graceMs: 2_000 });
    const answer = await inFlight;
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body), { made: "it" });
    await closing;
    // And it did not wait out the grace period for a socket that was already done.
    assert.ok(Date.now() - startedAt < 1_500, `close took ${Date.now() - startedAt}ms`);
  } finally {
    slow.closeAllConnections?.();
    await new Promise((resolve) => slow.close(resolve));
  }
});

test("close does not wait forever on a subscriber that never reads", async () => {
  const journal = createJournal();
  const own = createProxy({ policy: parsePolicy({ port: 0, upstream: upstreamOrigin }), journal, rules });
  const url = await own.listen(0, "127.0.0.1");
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write("GET /_blackout/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await new Promise((resolve) => socket.once("data", resolve));
  socket.pause();

  const startedAt = Date.now();
  await own.close({ graceMs: 300 });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 250, `close gave up too early (${elapsed}ms)`);
  assert.ok(elapsed < 2_000, `close took ${elapsed}ms`);
  socket.destroy();
});

test("an IPv6 loopback policy answers instead of failing to parse", async (t) => {
  // The request URL used to be parsed against `http://${policy.host}`, which is
  // `http://::1` for an IPv6 host: `new URL` throws, and every request came back
  // 500 "Invalid URL".
  const journal = createJournal();
  const own = createProxy({ policy: parsePolicy({ host: "::1", port: 0, upstream: upstreamOrigin }), journal, rules });
  let url;
  try {
    url = await own.listen(0, "::1");
  } catch (error) {
    t.skip(`no IPv6 loopback here: ${error.code ?? error.message}`);
    return;
  }
  try {
    assert.match(url, /^http:\/\/\[::1\]:\d+$/);
    const health = await fetch(`${url}/_blackout/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const served = await fetch(`${url}/v1/serve`, { method: "POST", body: "{}" });
    assert.equal(served.status, 200);
    assert.deepEqual(await served.json(), { creatives: [] });
  } finally {
    await own.close();
  }
});

test("an unreachable upstream is a 502 with a journal entry", async () => {
  upstream.closeAllConnections?.();
  await new Promise((resolve) => upstream.close(resolve));
  const res = await fetch(`${proxy.url}/v1/balance`);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "upstream-unreachable" });
  assert.ok(journal.entries.some((e) => e.kind === "upstream-error"));
  upstream = createServer(handleUpstream);
  await new Promise((resolve) => upstream.listen(Number(new URL(upstreamOrigin).port), "127.0.0.1", resolve));
});

test("an oversized config response is refused instead of buffered", async () => {
  // A wrong or compromised upstream must not cost the proxy the body it sends:
  // `response.text()` has no limit, and 200 MiB drove peak RSS to 723 MiB just
  // to reach the fallback the proxy was going to use anyway.
  const big = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("x".repeat(2 * 1024 * 1024));
  });
  await new Promise((resolve) => big.listen(0, "127.0.0.1", resolve));
  const bigJournal = createJournal(null);
  const capped = createProxy({
    policy: parsePolicy({ upstream: `http://127.0.0.1:${big.address().port}` }),
    journal: bigJournal,
    rules,
  });
  await capped.listen(0, "127.0.0.1");
  try {
    const res = await fetch(`${capped.url}/v1/config`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-blackout"), "config-safe");
    assert.equal((await res.json()).killSwitch, true);
    const degraded = bigJournal.entries.filter((entry) => entry.kind === "config-degraded");
    assert.equal(degraded.length, 1);
    assert.match(degraded[0].data.reason, /over \d+ bytes/);
  } finally {
    await capped.close();
    big.closeAllConnections?.();
    await new Promise((resolve) => big.close(resolve));
  }
});

test("a client that gives up before the answer closes the upstream request", async () => {
  // A stalled upstream never errors, so nothing else cleans this up: without an
  // explicit teardown each cancelled call leaks one descriptor and one request.
  let opened = 0;
  let closed = 0;
  const stalled = createServer((req) => {
    opened += 1;
    req.socket.on("close", () => { closed += 1; });
  });
  await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  const stalledProxy = createProxy({
    policy: parsePolicy({ upstream: `http://127.0.0.1:${stalled.address().port}` }),
    journal: createJournal(null),
    rules,
  });
  await stalledProxy.listen(0, "127.0.0.1");
  try {
    const socket = connect(Number(new URL(stalledProxy.url).port), "127.0.0.1");
    socket.on("error", () => {});
    socket.write("GET /v1/balance HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    socket.destroy();
    for (let i = 0; i < 100 && closed === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(opened, 1);
    assert.equal(closed, 1, "the upstream socket should close with the client");
  } finally {
    await stalledProxy.close();
    stalled.closeAllConnections?.();
    await new Promise((resolve) => stalled.close(resolve));
  }
});

test("a client that aborts a blocked request mid-body does not disturb the proxy", async () => {
  const socket = connect(Number(new URL(proxy.url).port), "127.0.0.1");
  socket.on("error", () => {});
  // An announced body that never arrives: the drain finishes on the abort, and
  // the answer it then tries to send has nowhere to go.
  socket.write("POST /v1/serve HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-length: 1048576\r\n\r\nxxxxx");
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 150));

  const res = await fetch(`${proxy.url}/v1/serve`, { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { creatives: [] });
});

test("a body over the limit is refused rather than buffered", async () => {
  const res = await fetch(`${proxy.url}/v1/receipts`, { method: "POST", body: "x".repeat(2 * 1024 * 1024 + 1) });
  assert.equal(res.status, 413);
});

test("a large serve body is consumed, so the connection can be reused", async () => {
  // The client posts its context with the serve call. If the proxy answers
  // without reading that body, Node destroys the socket afterwards: every
  // request costs a new connection, and a response can be cut off mid-flight.
  const { Agent } = await import("node:http");
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const body = "x".repeat(8 * 1024 * 1024);

  const post = () => new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: proxy.server.address().port, path: "/v1/serve", method: "POST", agent, headers: { "content-length": body.length } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, reused: req.reusedSocket }));
    });
    req.on("error", reject);
    req.end(body);
  });

  try {
    const first = await post();
    const second = await post();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.reused, true, "the second request should reuse the connection");
  } finally {
    agent.destroy();
  }
});

test("a client that never finishes its body cannot hold the answer forever", async () => {
  const started = Date.now();
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: proxy.server.address().port,
      path: "/v1/serve",
      method: "POST",
      // Promises a body, sends one byte. The proxy waits, but only so long.
      headers: { "content-length": 1_000_000 },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write("x");
  });

  assert.equal(status, 200);
  assert.ok(Date.now() - started < 4_000, `took ${Date.now() - started}ms to answer`);
});

test("a client that disappears mid-request leaves the proxy serving", async () => {
  await new Promise((resolve) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: proxy.server.address().port,
      path: "/v1/serve",
      method: "POST",
      headers: { "content-length": 1_000_000 },
    });
    req.on("error", () => resolve());
    req.write("x");
    setTimeout(() => { req.destroy(); resolve(); }, 30);
  });

  const health = await fetch(`${proxy.url}/_blackout/health`);
  assert.equal(health.status, 200);
});

test("concurrent serves are all answered, counted and chained", async () => {
  const before = journal.entries.filter((entry) => entry.kind === "serve-blocked").length;
  const responses = await Promise.all(
    Array.from({ length: 100 }, () => fetch(`${proxy.url}/v1/serve`, { method: "POST", body: JSON.stringify({ tags: [] }) })),
  );

  assert.equal(responses.filter((res) => res.status === 200).length, 100);
  const after = journal.entries.filter((entry) => entry.kind === "serve-blocked").length;
  assert.equal(after - before, 100);

  const { verifyChain } = await import("../src/journal.js");
  assert.deepEqual(verifyChain(journal.entries), { ok: true, brokenAt: null });
});

test("hostile receipt bodies are refused without touching the queue", async () => {
  const bodies = ["null", "[]", "{}", '{"receipts":{}}', '{"receipts":"x"}', '{"receipts":[null,1,"x",{}]}'];
  for (const body of bodies) {
    const res = await fetch(`${proxy.url}/v1/receipts`, { method: "POST", body });
    const json = await res.json();
    if (body === '{"receipts":[null,1,"x",{}]}') {
      // An array of junk is still an array: nothing is acked, nothing crashes.
      assert.equal(res.status, 200);
      assert.deepEqual(json, { acked: [] });
    } else {
      assert.equal(res.status, 400, `${body} should be a 400`);
    }
  }
});

const rawGet = (path) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: "127.0.0.1", port: proxy.server.address().port, path }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on("error", reject);
  req.end();
});

test("binary responses pass through byte for byte, headers intact", async () => {
  const { status, headers, body } = await rawGet("/v1/binary");
  assert.equal(headers["content-type"], "application/octet-stream");
  assert.equal(headers["etag"], '"abc"');
  assert.deepEqual([...body], [0, 1, 2, 3, 255, 254]);
});

test("a pre-compressed response is not decoded, re-encoded or relabelled", async () => {
  const { headers, body } = await rawGet("/v1/gzip");
  assert.equal(headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(body).toString("utf8"), "hello hello hello");
});
