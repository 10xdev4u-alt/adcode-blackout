import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
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

before(async () => {
  hits = { serve: 0, receipts: 0, config: 0, balance: 0, other: 0 };
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/serve") { hits.serve++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ creatives: [] })); return; }
      if (req.url === "/v1/receipts") { hits.receipts++; res.writeHead(200); res.end("{}"); return; }
      if (req.url === "/v1/config") { hits.config++; seenConfigAuth = req.headers.authorization ?? null; res.writeHead(200); res.end(JSON.stringify({ killSwitch: false, caps: { dailyCap: 40, minIntervalMs: 1000 }, projections: { off: "0", light: "10", standard: "20", max: "30" }, extra: "ignored" })); return; }
      if (req.url === "/v1/balance") { hits.balance++; res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" }); res.end(JSON.stringify({ availableMicros: "1080000", lifetimeMicros: "5400000" })); return; }
      hits.other++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body: body || null, auth: req.headers.authorization ?? null }));
    });
  });
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

test("an unreachable upstream is a 502 with a journal entry", async () => {
  upstream.closeAllConnections?.();
  await new Promise((resolve) => upstream.close(resolve));
  const res = await fetch(`${proxy.url}/v1/balance`);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "upstream-unreachable" });
  assert.ok(journal.entries.some((e) => e.kind === "upstream-error"));
  upstream = createServer((req, res) => res.end("{}"));
  await new Promise((resolve) => upstream.listen(Number(new URL(upstreamOrigin).port), "127.0.0.1", resolve));
});

test("a body over the limit is refused rather than buffered", async () => {
  const res = await fetch(`${proxy.url}/v1/receipts`, { method: "POST", body: "x".repeat(2 * 1024 * 1024 + 1) });
  assert.equal(res.status, 413);
});
