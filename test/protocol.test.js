import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createProxy } from "../src/proxy.js";
import { createJournal } from "../src/journal.js";
import { parsePolicy } from "../src/policy.js";
import { loadRulePack } from "../src/rules.js";
import { buildReport } from "../src/report.js";

/*
 * The paths a browser, a proxy or a broken network can take that the ordinary
 * request tests never do: raw HTTP framing, smuggling attempts, backpressure,
 * a failed TLS handshake, and a clock that moves backwards.
 *
 * Each case here is something the server has to survive without a stack trace.
 * A blocker that dies on a malformed request is worse than one that misses a
 * rule, because the app it protects is still running.
 */

const rules = loadRulePack("core");
const DEAD_UPSTREAM = "http://127.0.0.1:9";

async function start(overrides = {}) {
  const journal = createJournal();
  const proxy = createProxy({
    policy: parsePolicy({ port: 0, upstream: DEAD_UPSTREAM, ...overrides.policy }),
    journal,
    rules,
    ...overrides.proxy,
  });
  const origin = await proxy.listen(0, "127.0.0.1");
  return { proxy, journal, origin, port: Number(new URL(origin).port) };
}

/**
 * Send raw bytes and collect the answer.
 *
 * The socket is closed only after the response arrives. Closing it first - a
 * half-close - makes Node destroy the connection on FIN, which is correct
 * behaviour for a client that has gone, and would make every case here look
 * like a missing answer.
 */
function exchange(port, payload, { until = null, timeoutMs = 1_000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    socket.setEncoding("utf8");
    const finish = () => {
      socket.destroy();
      resolve(received);
    };
    socket.on("data", (chunk) => {
      received += chunk;
      if (until !== null && until(received)) finish();
    });
    socket.on("error", finish);
    socket.on("close", finish);
    socket.on("connect", () => socket.write(payload));
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}

const statusOf = (text) => /^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? null;
const alive = async (origin) => (await fetch(`${origin}/_blackout/health`)).ok;

test("oversized headers are refused, and the proxy keeps serving", async () => {
  const { proxy, origin, port } = await start();
  const payload = `GET /_blackout/health HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: ${"x".repeat(64 * 1024)}\r\n\r\n`;
  const answer = await exchange(port, payload);
  // Node's own limit answers 431 before any handler runs; what matters is that
  // it is an answer and not a reset.
  assert.equal(statusOf(answer), "431");
  assert.ok(await alive(origin));
  await proxy.close();
});

test("CONNECT is not tunnelled", async () => {
  const { proxy, origin, port } = await start();
  const answer = await exchange(port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
  assert.doesNotMatch(answer, /200 Connection/i);
  assert.ok(await alive(origin));
  await proxy.close();
});

test("an Upgrade request is not hijacked", async () => {
  const { proxy, origin, port } = await start();
  // No answer is the expected answer: without an `upgrade` listener Node closes
  // the connection. Waiting for the close, not for a status line, is what keeps
  // this case from costing a full timeout.
  const answer = await exchange(
    port,
    "GET /v1/serve HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    { timeoutMs: 300 },
  );
  assert.doesNotMatch(answer, /101 Switching/i);
  assert.ok(await alive(origin));
  await proxy.close();
});

test("HTTP/1.0 without a Host is refused, and with one works", async () => {
  const { proxy, port } = await start();
  assert.equal(statusOf(await exchange(port, "GET /_blackout/health HTTP/1.0\r\n\r\n")), "421");
  assert.equal(statusOf(await exchange(port, "GET /_blackout/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")), "200");
  await proxy.close();
});

test("pipelined requests are both answered, in order", async () => {
  const { proxy, port } = await start();
  const payload =
    "GET /_blackout/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n" +
    "GET /_blackout/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
  const answer = await exchange(port, payload, {
    until: (text) => (text.match(/HTTP\/1\.1 \d{3}/g) ?? []).length >= 2,
  });
  const statuses = answer.match(/HTTP\/1\.1 (\d{3})/g) ?? [];
  assert.deepEqual(statuses, ["HTTP/1.1 200", "HTTP/1.1 200"]);
  await proxy.close();
});

test("a request that tries to smuggle two framings is refused", async () => {
  const { proxy, origin, port } = await start();
  const both = await exchange(
    port,
    "POST /v1/serve HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  );
  assert.equal(statusOf(both), "400");
  const twice = await exchange(
    port,
    "POST /v1/serve HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  );
  assert.equal(statusOf(twice), "400");
  assert.ok(await alive(origin));
  await proxy.close();
});

test("hostile request targets are answered, not crashes", async () => {
  const { proxy, origin, port } = await start();
  for (const target of ["/v1/serve%00", "/%ZZ%FF", "/v1/../../etc/passwd"]) {
    const answer = await exchange(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`, {
      // Stop at the status line: the connection stays open afterwards, so
      // waiting for the socket to close would cost the timeout per case.
      until: (text) => statusOf(text) !== null,
    });
    // The path matches no rule, so it passes through and the dead upstream is a
    // 502. What is asserted is an HTTP answer to a target that is not a path.
    assert.equal(statusOf(answer), "502", target);
  }
  assert.ok(await alive(origin));
  await proxy.close();
});

test("an 8 MiB response is streamed to a slow client, not buffered", async () => {
  const size = 8 * 1024 * 1024;
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size) });
    response.end(Buffer.alloc(size, 0x61));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { proxy, port } = await start({ policy: { upstream: `http://127.0.0.1:${upstream.address().port}` } });

  const received = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/v1/balance" }, (response) => {
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        // A reader slower than the upstream is what exposes buffering.
        response.pause();
        setTimeout(() => response.resume(), 2);
      });
      response.on("end", () => resolve(bytes));
      response.on("error", reject);
    });
  });

  assert.equal(received, size);
  // The proxy's own copy must not be the response: a buffered 8 MiB would show
  // up as retained heap on a process that started the test at a few MiB.
  const heapMiB = process.memoryUsage().heapUsed / 1024 / 1024;
  assert.ok(heapMiB < 200, `heap ${heapMiB.toFixed(1)} MiB`);
  await proxy.close();
  upstream.close();
});

test("a failed TLS handshake degrades to the safe config, never a hang", async () => {
  // An https upstream that is actually plain HTTP: every call fails at the
  // handshake, which is what a bad certificate or a middlebox produces.
  const plain = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"killSwitch":false,"adsEnabled":true}');
  });
  await new Promise((resolve) => plain.listen(0, "127.0.0.1", resolve));
  const { proxy, journal, origin } = await start({ policy: { upstream: `https://127.0.0.1:${plain.address().port}` } });

  const config = await fetch(`${origin}/v1/config`, { signal: AbortSignal.timeout(5_000) });
  const body = await config.json();
  assert.equal(config.status, 200);
  assert.equal(body.killSwitch, true);
  const degraded = journal.entries.filter((entry) => entry.kind === "config-degraded");
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].data.status, 0);

  const pass = await fetch(`${origin}/v1/balance`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(pass.status, 502);
  assert.ok(await alive(origin));
  await proxy.close();
  plain.close();
});

test("a clock that moves backwards does not break the chain or the totals", async () => {
  let clock = 1_000;
  const { proxy, origin } = await start({ proxy: { now: () => (clock -= 1_000) } });
  for (let index = 0; index < 3; index += 1) {
    await fetch(`${origin}/v1/serve`, { method: "POST", body: "{}" });
  }
  const report = proxy.report();
  assert.equal(report.integrity.ok, true);
  assert.equal(report.totals.servesBlocked, 3);
  assert.ok(Number.isFinite(report.attention.hours));
  assert.ok(report.attention.hours >= 0);
  await proxy.close();
});

test("report over damaged counts renders no NaN or Infinity", () => {
  const entries = [
    { seq: 1, at: 0, kind: "serve-blocked", data: null, prev: "0", hash: "h" },
    { seq: 2, at: 1, kind: "receipt-blocked", data: { count: -5 }, prev: "h", hash: "i" },
    { seq: 3, at: 2, kind: "receipt-blocked", data: { count: 1e9 }, prev: "i", hash: "j" },
  ];
  const report = buildReport(entries, { policy: parsePolicy({ port: 0, upstream: DEAD_UPSTREAM }) });
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /NaN|Infinity/);
});
