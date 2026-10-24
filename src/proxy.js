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
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const BODY_LIMIT = 2 * 1024 * 1024;
const CONFIG_TIMEOUT_MS = 8_000;
/**
 * How much of a config response is worth reading.
 *
 * The real document is a few hundred bytes. `response.text()` has no limit, so
 * a wrong or compromised upstream answering with a huge body used to cost the
 * whole thing in memory before the parse failed: a 200 MiB response drove peak
 * RSS to 723 MiB to reach the same safe fallback.
 */
const CONFIG_LIMIT_BYTES = 1024 * 1024;
/**
 * How far a client may fall behind on the decision stream.
 *
 * `res.write` returns false when the socket is full, and ignoring that turns a
 * paused reader - a suspended browser tab, a `SIGSTOP`ped CLI - into a buffer
 * that grows with every decision. Measured before this limit existed: a stalled
 * subscriber cost about 12 MiB per 10 MiB of journal traffic, forever.
 */
const STREAM_LIMIT_BYTES = 256 * 1024;
/** The client rejects an ack outside this shape, so never send one. */
const ACKABLE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * How many distinct discoveries are recorded.
 *
 * Discovery exists to show a person an endpoint the pack does not match, and a
 * person reads a short list. The limit is here because nothing else bounds the
 * inputs: any page in a browser can POST to loopback with a loopback `Host`, and
 * each new ad-like path would otherwise cost a `Set` entry and a journal line it
 * chooses the size of. Measured before the cap: 5,000 distinct paths, 2 KB each.
 */
const MAX_DISCOVERY = 256;
/**
 * How many recent decisions a new subscriber is replayed.
 *
 * A follower wants the context of what just happened; `?tail=N` narrows it for
 * a caller that wants one entry, which is what `blackout events --once` is.
 */
const REPLAY_ENTRIES = 20;

/** Paths that look like advertising, for discovery only. */
const AD_LIKE = /(?:^|\/)(ad|ads|advert|adverts|advertising|serve|serves|receipt|receipts|impression|impressions|sponsor|sponsors|sponsored|promo|promos|promotion|promotions|offer|offers|bid|bids|auction|auctions|campaign|campaigns|creative|creatives)(?:\/|$)/i;

/**
 * The Host header has to name loopback, not just connect to it.
 *
 * DNS rebinding makes an attacker page same-origin with 127.0.0.1: the browser
 * sends its own hostname in Host and treats the response as same-origin, which
 * is exactly the condition the control header was meant to prevent. Reading the
 * socket address would not catch this; the header is the part the page controls.
 */
function loopbackHost(header) {
  if (typeof header !== "string" || header === "") return false;
  try {
    const hostname = new URL(`http://${header}`).hostname;
    return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

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

/**
 * Read and discard the request body before answering.
 *
 * Node destroys the socket after a response whose request body was never
 * consumed: the client still gets its answer, but on a connection it cannot
 * reuse, and a large response can be cut off while it drains. The bodies this
 * sees are the client's ad context - a few hundred bytes - so waiting costs
 * nothing; the timeout is for a client that never finishes, which must not be
 * able to hold a response forever.
 */
function drain(req, { timeoutMs = 2_000 } = {}) {
  return new Promise((resolve) => {
    if (req.readableEnded) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      req.off("end", finish);
      req.off("error", finish);
      req.off("aborted", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    req.once("end", finish);
    req.once("error", finish);
    req.once("aborted", finish);
    req.resume();
  });
}

function sendJson(res, status, body, extra = {}) {
  // The client can be gone by the time an answer is ready - it aborted during a
  // drain, or while the upstream was being fetched. Writing to that response is
  // at best wasted and at worst an error event nothing is listening for.
  if (res.destroyed || res.writableEnded) return;
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
  let activeRules = rules;
  const startedAt = now();
  const discovered = new Set();
  let discoveryCapped = false;
  /*
   * Application traffic, counted but not journaled.
   *
   * The journal records decisions, so a build that only makes pass-through
   * calls - chat, releases, anything not ad-like - leaves no entry at all. The
   * compatibility harness has to tell that apart from "the app never called us",
   * which is a completely different answer, so the count lives here and not in
   * the log. `/_blackout/*` is excluded: that is the harness and the CLI
   * talking, not the app.
   */
  const stats = { requests: 0, passed: 0 };

  function report() {
    return buildReport(journal.entries, {
      policy,
      version: VERSION,
      now: now(),
      enabled,
      // Totals come from the journal's own counters: `journal.entries` is a
      // bounded tail, so counting it would shrink as the proxy got busier.
      summary: typeof journal.summary === "function" ? journal.summary() : null,
      integrity: journal.integrity,
      // A journal that cannot be written is not a reason to stop blocking, but it
      // is a reason to stop claiming the record is complete.
      journalWriteError: journal.writeError ?? null,
    });
  }

  /** Record a one-off observation, once, up to the discovery limit. */
  function noteOnce(key, kind, data) {
    if (discovered.has(key)) return;
    if (discovered.size >= MAX_DISCOVERY) {
      if (discoveryCapped) return;
      discoveryCapped = true;
      journal.append("discovery-capped", { kind, limit: MAX_DISCOVERY });
      return;
    }
    discovered.add(key);
    journal.append(kind, data);
  }

  function discover(method, path) {
    if (!path.startsWith("/v1/") || !AD_LIKE.test(path)) return;
    noteOnce(`${method} ${path}`, "endpoint-seen", { method, path });
  }

  async function handle(req, res) {
    if (!loopbackHost(req.headers.host)) {
      const key = String(req.headers.host ?? "");
      noteOnce(`host ${key}`, "host-rejected", { host: key });
      sendJson(res, 421, { error: "host-not-loopback" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${policy.host}`);

    if (url.pathname.startsWith("/_blackout/")) {
      await local(req, res, url);
      return;
    }

    stats.requests += 1;

    if (!enabled) {
      pass(req, res, url);
      return;
    }

    const rule = matchRule(activeRules, req.method, url.pathname);
    if (rule === null) {
      discover(req.method, url.pathname);
      pass(req, res, url);
      return;
    }

    switch (rule.action) {
      case "empty-serve":
        await drain(req);
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
        const upstream = await fetchUpstream(url.pathname, req);
        if (!upstream.ok) {
          journal.append("config-degraded", {
            path: url.pathname,
            status: upstream.status,
            ...(upstream.reason === undefined ? {} : { reason: upstream.reason }),
          });
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
        await drain(req);
        journal.append("request-blocked", { path: url.pathname, rule: rule.id });
        sendJson(res, 403, { error: "blocked-by-blackout" }, { "x-blackout": "blocked" });
        return;

      case "pass":
        pass(req, res, url);
        return;
    }
  }

  async function fetchUpstream(path, req) {
    try {
      const response = await fetch(`${policy.upstream}${path}`, {
        // The config call is authenticated like every other call. Dropping the
        // header turned a normal 200 into a 401 and made the rewrite look like a
        // degraded fallback every time.
        headers: { ...upstreamHeaders(req), accept: "application/json" },
        signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
      });
      if (response.body === null) return { ok: false, status: response.status, text: "", reason: "empty body" };

      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > CONFIG_LIMIT_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, status: response.status, text: "", reason: `config body over ${CONFIG_LIMIT_BYTES} bytes` };
        }
        chunks.push(value);
      }
      return { ok: response.ok, status: response.status, text: Buffer.concat(chunks).toString("utf8") };
    } catch (error) {
      return { ok: false, status: 0, text: "", reason: String(error?.message ?? error) };
    }
  }

  function pass(req, res, url) {
    stats.passed += 1;
    let target;
    try {
      target = new URL(`${policy.upstream}${url.pathname}${url.search}`);
    } catch {
      sendJson(res, 502, { error: "bad-upstream" });
      return;
    }
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    const controller = new AbortController();
    // No shared agent: a pooled socket would outlive the request and make shutdown
    // wait on a connection nobody is using.
    const upstream = request(target, { method: req.method, headers: upstreamHeaders(req), agent: false, signal: controller.signal }, (response) => {
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
      // An abort we caused is not an upstream fault, and journaling it would
      // turn every cancelled request into an entry the report cannot explain.
      if (!controller.signal.aborted) {
        journal.append("upstream-error", { path: url.pathname, reason: String(error?.message ?? error) });
      }
      if (!res.headersSent) sendJson(res, 502, { error: "upstream-unreachable" });
      else if (!res.destroyed) res.destroy();
    });

    /*
     * The client hanging up must close the upstream side.
     *
     * `req.pipe(upstream)` alone does not do this: when the socket goes away the
     * request is destroyed, but the outgoing request keeps its socket open. A
     * stalled upstream then holds one descriptor and one request object per
     * abandoned call, and never errors, so nothing else cleans it up. Measured
     * before this: 40 cancelled calls, 40 upstream sockets still open.
     */
    res.on("close", () => {
      // A finished response also closes the connection; only an unfinished one
      // means the client gave up before it had its answer.
      if (res.writableFinished) return;
      req.unpipe(upstream);
      controller.abort();
      upstream.destroy();
    });
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
        // Null while the record is being written; `{ at, message }` afterwards.
        // Blocking continues either way - see `noteWriteError` in journal.js.
        journalWriteError: journal.writeError ?? null,
        requests: stats.requests,
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
      /*
       * `?tail=N` bounds the replay. Without it, `--once` printed the oldest of
       * the last 20 rather than the latest - or the next - decision, which is
       * what a script asking for one entry means. `slice(-0)` is the whole
       * array, so zero is handled before slicing.
       */
      const requested = url.searchParams.has("tail") ? Number(url.searchParams.get("tail")) : REPLAY_ENTRIES;
      const replay = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, REPLAY_ENTRIES) : REPLAY_ENTRIES;
      for (const entry of replay === 0 ? [] : journal.entries.slice(-replay)) {
        res.write(`event: journal\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      let timer = null;
      let live = true;
      const unsubscribe = journal.subscribe((entry) => {
        if (!live || res.writableEnded) return;
        if (res.writableLength > STREAM_LIMIT_BYTES) {
          // End the stream rather than queue for it. The client reconnects on
          // its own (the first frame is `retry: 3000`) and is replayed the
          // tail, so a slow reader loses nothing; a buffer that never drains
          // would cost the whole process.
          stop();
          res.destroy();
          return;
        }
        res.write(`event: journal\ndata: ${JSON.stringify(entry)}\n\n`);
      });
      function stop() {
        if (!live) return;
        live = false;
        unsubscribe();
        if (timer !== null) clearInterval(timer);
      }
      timer = setInterval(() => {
        if (!live) return;
        if (res.writableLength > STREAM_LIMIT_BYTES) {
          stop();
          res.destroy();
          return;
        }
        res.write(": heartbeat\n\n");
      }, 15_000);
      timer.unref?.();
      res.on("close", stop);
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
    /** Swap the pack after a validated reload; matching takes effect immediately. */
    setRules(next) { activeRules = next; },
    /** `{ requests, passed }` for application traffic since listen. */
    stats: () => ({ ...stats }),
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
    /**
     * Stop listening, then let the answers that are already being written land.
     *
     * `uninstall`, `systemctl restart` and Ctrl-C all end with SIGTERM, and the
     * old close destroyed every open connection on the spot: a request in
     * flight came back as "fetch failed" 26 ms after the signal, which is a
     * broken response the app has to interpret. `graceMs` is the longest that
     * wait is allowed to last - a streaming subscriber that never finishes must
     * not turn a stop into a hang.
     *
     * The listening socket closes immediately either way, so a caller polling
     * for "has it stopped" does not have to wait out the grace period.
     */
    async close({ graceMs = 0 } = {}) {
      const closed = new Promise((resolve) => server.close(resolve));
      // A keep-alive socket with nothing in flight will never produce another
      // request, so it must not hold the close open.
      server.closeIdleConnections?.();
      if (graceMs <= 0) {
        server.closeAllConnections?.();
        await closed;
        return;
      }
      const timer = setTimeout(() => server.closeAllConnections?.(), graceMs);
      timer.unref?.();
      /*
       * A connection that was busy when the close started only becomes idle
       * when its response ends, and `server.close()` waits for that socket.
       * Sweeping while we wait is what makes the exit prompt instead of always
       * costing the full grace: measured, one finished response still took the
       * whole 3 s without it.
       */
      const sweep = setInterval(() => server.closeIdleConnections?.(), 50);
      sweep.unref?.();
      await closed;
      clearTimeout(timer);
      clearInterval(sweep);
    },
  };
}
