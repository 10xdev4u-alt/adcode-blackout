import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatCompat, judge, runCompat } from "../src/compat.js";
import { parsePolicy } from "../src/policy.js";
import { loadRulePack } from "../src/rules.js";

const rules = loadRulePack("core");
const entry = (kind, data = {}) => ({ seq: 0, at: 0, kind, data, prev: "0".repeat(64), hash: "x" });
const stayed = { timedOut: true };
const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "blackout-compat-test-"));
  dirs.push(dir);
  return dir;
}

/** A stand-in for the real ad server: a config the proxy can rewrite. */
let upstream;
let upstreamOrigin;

before(async () => {
  upstream = createServer((req, res) => {
    if (req.url === "/v1/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        killSwitch: false,
        caps: { dailyCap: 40, minIntervalMs: 1_000 },
        projections: { off: "0", light: "10", standard: "20", max: "30" },
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
});

after(async () => {
  upstream.closeAllConnections?.();
  await new Promise((resolve) => upstream.close(resolve));
});

test("a build that is served and rewritten passes", () => {
  const result = judge({
    entries: [entry("serve-blocked", { path: "/v1/serve" }), entry("config-rewritten", { observed: {} })],
    exit: stayed,
    seconds: 60,
  });
  assert.equal(result.verdict, "pass");
  assert.equal(result.observed.serves, 1);
  assert.equal(result.observed.configs, 1);
  assert.deepEqual(result.checks.filter((check) => check.state === "fail"), []);
});

test("a build that never calls the proxy fails, and says which variable to check", () => {
  const result = judge({ entries: [], exit: stayed, seconds: 60 });
  assert.equal(result.verdict, "fail");
  const contact = result.checks.find((check) => check.name === "contact");
  assert.equal(contact.state, "fail");
  assert.match(contact.detail, /ADCODE_AD_SERVER/);
});

test("a new ad-like endpoint is a failure, and is named", () => {
  const result = judge({
    entries: [
      entry("serve-blocked"),
      entry("config-rewritten"),
      entry("endpoint-seen", { method: "POST", path: "/v1/ads/v2" }),
    ],
    exit: stayed,
    seconds: 60,
  });
  assert.equal(result.verdict, "fail");
  const drift = result.checks.find((check) => check.name === "drift");
  assert.equal(drift.state, "fail");
  assert.match(drift.detail, /POST \/v1\/ads\/v2/);
  assert.deepEqual(result.observed.endpoints, [{ method: "POST", path: "/v1/ads/v2" }]);
});

test("a config response that fell back to safe defaults is a failure", () => {
  const result = judge({
    entries: [entry("serve-blocked"), entry("config-degraded", { path: "/v1/config", reason: "config response is not JSON" })],
    exit: stayed,
    seconds: 60,
  });
  assert.equal(result.verdict, "fail");
  const config = result.checks.find((check) => check.name === "config");
  assert.equal(config.state, "fail");
  assert.match(config.detail, /the schema moved/);
  assert.match(config.detail, /not JSON/);
});

test("an unverified rewrite does not stand between a blocking build and a pass", () => {
  // The stock build's real behaviour: ADCODE_AD_SERVER makes it send dev-token,
  // production answers 401, and the proxy serves SAFE_CONFIG. The block holds,
  // so this is a pass with a warning - see docs/EVIDENCE.md.
  const result = judge({
    entries: [entry("serve-blocked"), entry("config-degraded", { path: "/v1/config", status: 401 })],
    exit: stayed,
    seconds: 60,
  });
  assert.equal(result.verdict, "pass");
  const config = result.checks.find((check) => check.name === "config");
  assert.equal(config.state, "warn");
  assert.match(config.detail, /rewrite not verified/);
  assert.match(config.detail, /safe config served/);
});

test("an unreachable upstream is the same warning, not a different verdict", () => {
  const result = judge({
    entries: [entry("serve-blocked"), entry("config-degraded", { path: "/v1/config", status: 0 })],
    exit: stayed,
    seconds: 60,
  });
  assert.equal(result.verdict, "pass");
  assert.equal(result.checks.find((check) => check.name === "config").state, "warn");
});

test("a refused Host is a failure, not a warning", () => {
  const result = judge({
    entries: [entry("serve-blocked"), entry("config-rewritten"), entry("host-rejected", { host: "evil.example" })],
    exit: stayed,
    seconds: 60,
  });
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.observed.hostRejected, ["evil.example"]);
});

test("contact without an ad opportunity is inconclusive, not a pass", () => {
  const result = judge({ entries: [entry("config-rewritten")], exit: stayed, seconds: 60 });
  assert.equal(result.verdict, "inconclusive");
  assert.match(formatCompat(result), /Not proven either way/);
});

test("a build that dies during the window fails the launch check", () => {
  const result = judge({
    entries: [entry("serve-blocked"), entry("config-rewritten")],
    exit: { timedOut: false, code: 1 },
    seconds: 60,
  });
  assert.equal(result.verdict, "fail");
  assert.equal(result.checks.find((check) => check.name === "launch").state, "fail");
});

test("receipts are not required: their absence is not a warning", () => {
  const result = judge({
    entries: [entry("serve-blocked"), entry("config-rewritten")],
    exit: stayed,
    seconds: 60,
  });
  assert.equal(result.checks.find((check) => check.name === "receipts").state, "ok");
});

/** A retained run is kept for the user, not for the test suite. */
function discardRetained(result) {
  if (result.journalPath !== null && result.journalPath !== undefined) {
    rmSync(dirname(result.journalPath), { recursive: true, force: true });
  }
}

function fakeApp(body) {
  const dir = tempDir();
  const path = join(dir, "fake.AppImage");
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

test("a build that speaks the contract is judged pass by the runner", async () => {
  const appImage = fakeApp(
    'curl -s -X POST -d "{}" "$ADCODE_AD_SERVER/v1/serve" > /dev/null\n' +
      'curl -s "$ADCODE_AD_SERVER/v1/config" > /dev/null\n' +
      "exec sleep 30\n",
  );

  const result = await runCompat({
    appImage,
    seconds: 1,
    policy: parsePolicy({ upstream: upstreamOrigin }),
    rules,
  });

  assert.equal(result.verdict, "pass", JSON.stringify(result.checks));
  assert.equal(result.observed.serves, 1);
  assert.equal(result.observed.configs, 1);
  // A clean pass leaves nothing behind.
  assert.equal(result.journalPath, null);
});

test("a build that dies is judged fail by the runner, and keeps its log", async () => {
  const appImage = fakeApp("exit 3\n");

  const result = await runCompat({
    appImage,
    seconds: 1,
    policy: parsePolicy({ upstream: upstreamOrigin }),
    rules,
  });

  assert.equal(result.verdict, "fail");
  const launch = result.checks.find((check) => check.name === "launch");
  assert.match(launch.detail, /code 3/);
  assert.ok(result.journalPath !== null);
  assert.ok(result.appLogPath !== null);
  discardRetained(result);
});

test("traffic that never touches an ad path is inconclusive, not 'never called'", () => {
  const result = judge({ entries: [], requests: 4, exit: stayed, seconds: 60 });
  assert.equal(result.verdict, "inconclusive");
  const contact = result.checks.find((check) => check.name === "contact");
  assert.equal(contact.state, "ok");
  assert.match(contact.detail, /none of them ad calls/);
});

test("a build that only makes pass-through calls is judged inconclusive by the runner", async () => {
  const appImage = fakeApp('curl -s "$ADCODE_AD_SERVER/v1/chat" > /dev/null\nexec sleep 30\n');

  const result = await runCompat({
    appImage,
    seconds: 1,
    policy: parsePolicy({ upstream: upstreamOrigin }),
    rules,
  });

  assert.equal(result.verdict, "inconclusive", JSON.stringify(result.checks));
  assert.ok(result.observed.requests > 0);
  assert.equal(result.observed.serves, 0);
  discardRetained(result);
});

test("arguments after -- reach the app, not the harness", async () => {
  const dir = tempDir();
  const out = join(dir, "args.txt");
  const appImage = fakeApp(
    `printf '%s\\n' "$@" > '${out}'\n` +
      'curl -s -X POST -d "{}" "$ADCODE_AD_SERVER/v1/serve" > /dev/null\n' +
      'curl -s "$ADCODE_AD_SERVER/v1/config" > /dev/null\n' +
      "exec sleep 30\n",
  );

  const result = await runCompat({
    appImage,
    args: ["--no-sandbox", "--flag"],
    seconds: 1,
    policy: parsePolicy({ upstream: upstreamOrigin }),
    rules,
  });

  assert.equal(result.verdict, "pass");
  assert.deepEqual(readFileSync(out, "utf8").trim().split("\n"), ["--no-sandbox", "--flag"]);
});
