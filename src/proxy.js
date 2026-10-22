/**
 * The proxy ADCode talks to when ADCODE_AD_SERVER points at it.
 *
 * Three rules govern this file:
 *
 * 1. Only the endpoints in the rule pack are parsed. Everything else is piped
 *    byte for byte, because a proxy that rewrites more than it must is a new
 *    attack surface rather than a defence.
 * 2. A blocked request is acknowledged, not dropped. The client's receipt
 *    queue only drains on an ack; a dropped body is a queue that retries
 *    forever.
 * 3. Nothing here knows the user's code. The ad client never sends it, and
 *    this proxy would not have anywhere to put it.
 */
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { matchRule } from "./rules.js";
import { rewriteConfig, SAFE_CONFIG } from "./config.js";
import { buildReport } from "./report.js";
import { renderDashboard } from "./dashboard.js";
import { VERSION } from "./version.js";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const BODY_LIMIT = 2 * 1024 * 1024;
const CONFIG_TIMEOUT_MS = 8_000;
/** The client rejects an ack outside this shape, so never send one. */
const ACKABLE = /^[A-Za-z0-9_-]{1,64}$/;
/** Paths that look like advertising, for discovery only. */
const AD_LIKE = /(?:^|\/)(ad|ads|advert|adverts|advertising|serve|serves|receipt|receipts|impression|impressions|sponsor|sponsors|sponsored|promo|promos|promotion|promotions|offer|offers|bid|bids|auction|auctions|campaign|campaigns|creative|creatives)(?:\/|$)/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let stopped = false;
    req.on("data", (chunk) => {
      if (stopped) return;
      size += chunk.length;
      if (size > limit) {
        // Keep draining rather than destroying the socket: the caller still owes
        // the client a 413, and a reset looks like a network fault instead.
        stopped = true;
        chunks.length = 0;
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!stopped) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...extra,
  });
  res.end(text);
}

function upstreamHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || HOP_BY_HOP.has(key)) continue;
    if (value !== undefined) headers[key] = value;
  }
  return headers;
}

export function createProxy({ policy, journal, rules, now = () => Date.now() }) {
  let enabled = policy.enabled;
  const startedAt = now();
  const discovered = new Set();

  function report() {
    return buildReport(journal.entries, { policy, version: VERSION, now: now(), enabled });
  }

  function discover(method, path) {
    if (!path.startsWith("/v1/") || !AD_LIKE.test(path)) return;
    const key = `${method} ${path}`;
    if (discovered.has(key)) return;
    discovered.add(key);
    journal.append("endpoint-seen", { method, path });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", `http://${policy.host}`);

    if (url.pathname.startsWith("/_blackout/")) {
      await local(req, res, url);
      return;
    }

    if (!enabled) {
      pass(req, res, url);
      return;
    }

    const rule = matchRule(rules, req.method, url.pathname);
    if (rule === null) {
      discover(req.method, url.pathname);
      pass(req, res, url);
      return;
    }

    switch (rule.action) {
      case "empty-serve":
        await req.resume().on("end", () => undefined);
        journal.append("serve-blocked", { path: url.pathname, rule: rule.id });
        sendJson(res, 200, { creatives: [] }, { "x-blackout": "serve-empty" });
        return;

      case "ack-receipts": {
        const body = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          sendJson(res, 400, { error: "malformed-receipts" });
          return;
        }
        if (!isRecord(parsed) || !Array.isArray(parsed["receipts"])) {
          sendJson(res, 400, { error: "malformed-receipts" });
          return;
        }
        // Ack only what the client's own validation will accept: `acked` is parsed
        // against [A-Za-z0-9_-]{1,64}, and one malformed entry fails the whole
        // response, which would leave the queue stuck forever.
        const ids = parsed["receipts"]
          .map((item) => (isRecord(item) && typeof item["receiptId"] === "string" ? item["receiptId"] : null))
          .filter((id) => id !== null && ACKABLE.test(id));
        const unique = [...new Set(ids)];
        journal.append("receipt-blocked", {
          path: url.pathname,
          rule: rule.id,
          count: unique.length,
          ids: unique.slice(0, 32),
        });
        sendJson(res, 200, { acked: unique }, { "x-blackout": "receipts-acked" });
        return;
      }

      case "rewrite-config": {
        const upstream = await fetchUpstream(url.pathname);
        if (!upstream.ok) {
          journal.append("config-degraded", { path: url.pathname, status: upstream.status });
          sendJson(res, 200, SAFE_CONFIG, { "x-blackout": "config-safe" });
          return;
        }
        try {
          const { config, observed } = rewriteConfig(upstream.text);
          journal.append("config-rewritten", { path: url.pathname, rule: rule.id, status: upstream.status, observed });
          sendJson(res, 200, config, { "x-blackout": "config-rewritten" });
        } catch (error) {
          journal.append("config-degraded", { path: url.pathname, reason: String(error.message ?? error) });
          sendJson(res, 200, SAFE_CONFIG, { "x-blackout": "config-safe" });
        }
        return;
      }

      case "block":
        journal.append("request-blocked", { path: url.pathname, rule: rule.id });
        sendJson(res, 403, { error: "blocked-by-blackout" }, { "x-blackout": "blocked" });
        return;

      case "pass":
        pass(req, res, url);
        return;
    }
  }

  async function fetchUpstream(path) {
    try {
      const response = await fetch(`${policy.upstream}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) {
      return { ok: false, status: 0, text: "", reason: String(error?.message ?? error) };
    }
  }

  function pass(req, res, url) {
    let target;
    try {
      target = new URL(`${policy.upstream}${url.pathname}${url.search}`);
    } catch {
      sendJson(res, 502, { error: "bad-upstream" });
      return;
    }
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    // No shared agent: a pooled socket would outlive the request and make shutdown
    // wait on a connection nobody is using.
    const upstream = request(target, { method: req.method, headers: upstreamHeaders(req), agent: false }, (response) => {
      if (res.destroyed) {
        response.destroy();
        return;
      }
      const headers = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key)) continue;
        headers[key] = value;
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
    });

    upstream.on("error", (error) => {
      journal.append("upstream-error", { path: url.pathname, reason: String(error?.message ?? error) });
      if (!res.headersSent) sendJson(res, 502, { error: "upstream-unreachable" });
      else res.destroy();
    });

    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  }

  async function local(req, res, url) {
    const path = url.pathname;

    if (path === "/_blackout/health") {
      sendJson(res, 200, {
        ok: true,
        name: "adcode-blackout",
        version: VERSION,
        enabled,
        uptimeMs: now() - startedAt,
        upstream: policy.upstream,
        integrity: journal.integrity,
        journalHead: journal.head(),
      });
      return;
    }

    if (path === "/_blackout/report") {
      sendJson(res, 200, report());
      return;
    }

    if (path === "/_blackout/dashboard" && policy.dashboard) {
      const html = renderDashboard(report());
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(html);
      return;
    }

    if (path === "/_blackout/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      for (const entry of journal.entries.slice(-20)) {
        res.write(`event: journal\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      const unsubscribe = journal.subscribe((entry) => {
        if (!res.writableEnded) res.write(`event: journal\ndata: ${JSON.stringify(entry)}\n\n`);
      });
      const timer = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
      timer.unref?.();
      res.on("close", () => {
        clearInterval(timer);
        unsubscribe();
      });
      return;
    }

    if ((path === "/_blackout/pause" || path === "/_blackout/resume") && req.method === "POST") {
      if (typeof req.headers["x-blackout-control"] !== "string") {
        sendJson(res, 403, { error: "control-header-required" });
        return;
      }
      enabled = path.endsWith("resume");
      journal.append(enabled ? "resumed" : "paused", {});
      sendJson(res, 200, { enabled });
      return;
    }

    sendJson(res, 404, { error: "not-found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = Number.isSafeInteger(error?.status) ? error.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: "blackout-failure", detail: String(error?.message ?? error) });
      else res.destroy();
    });
  });

  let origin = null;
  return {
    server,
    get url() { return origin; },
    get enabled() { return enabled; },
    setEnabled(value) { enabled = Boolean(value); },
    report,
    async listen(port = policy.port, host = policy.host) {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve();
        });
      });
      origin = `http://${host}:${server.address().port}`;
      return origin;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
