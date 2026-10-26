import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostPort, loadPolicy, parsePolicy, savePolicy } from "../src/policy.js";

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("defaults are loopback, production origin, dashboard on", () => {
  const policy = parsePolicy({});
  assert.equal(policy.host, "127.0.0.1");
  assert.equal(policy.upstream, "https://adcode.bluethenics.com");
  assert.equal(policy.dashboard, true);
});

test("a non-loopback host is refused, not clamped", () => {
  assert.throws(() => parsePolicy({ host: "0.0.0.0" }), /loopback/);
  assert.throws(() => parsePolicy({ host: "192.168.1.10" }), /loopback/);
});

test("ports and estimates are bounded integers", () => {
  assert.throws(() => parsePolicy({ port: 70_000 }), /port/);
  assert.throws(() => parsePolicy({ port: 3.5 }), /port/);
  assert.throws(() => parsePolicy({ estimates: { secondsPerAd: -1 } }), /secondsPerAd/);
});

test("a bad upstream scheme is refused", () => {
  assert.throws(() => parsePolicy({ upstream: "file:///etc/passwd" }), /http/);
  assert.throws(() => parsePolicy({ upstream: "not a url" }), /absolute URL/);
});

test("an IPv6 loopback host is bracketed wherever a port follows it", () => {
  // `http://::1:8790` is not a URL. Without this, `status` said "not running"
  // against a serving proxy and the app got an unusable ADCODE_AD_SERVER.
  assert.equal(hostPort("::1", 8790), "[::1]:8790");
  assert.equal(hostPort("127.0.0.1", 8790), "127.0.0.1:8790");
  assert.equal(hostPort("localhost", 80), "localhost:80");
});

test("a setting nothing reads cannot stop the tool", () => {
  // `team` was parsed, validated and never used. The failure mode was worse
  // than dead code: a config carrying it stopped every command on a validation
  // error for a feature that does not exist.
  const policy = parsePolicy({ team: { url: "adcode.example.com" } });
  assert.equal(policy.team, undefined);
  assert.equal(policy.upstream, "https://adcode.bluethenics.com");
});

test("a policy round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "blackout-policy-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  const saved = savePolicy({ port: 8791, estimates: { secondsPerAd: 10 } }, path);
  const loaded = loadPolicy(path);
  assert.deepEqual(loaded, saved);
  assert.equal(loaded.port, 8791);
});

test("a policy that is not an object is refused by name", () => {
  // The config file is JSON, but `parsePolicy` is also the validator every
  // caller passes a merged object through: an array or a scalar arriving here
  // means a bug upstream, and the message says which one it is.
  for (const value of [null, [], 42, "core"]) {
    assert.throws(() => parsePolicy(value), (error) => {
      assert.equal(error.message, "policy must be an object");
      return true;
    });
  }
  assert.equal(parsePolicy({}).port, 8790, "and the absent argument still means defaults");
});
