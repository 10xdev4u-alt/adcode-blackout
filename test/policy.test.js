import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, parsePolicy, savePolicy } from "../src/policy.js";

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

test("a policy round-trips through disk", () => {
  const path = join(mkdtempSync(join(tmpdir(), "blackout-policy-")), "config.json");
  const saved = savePolicy({ port: 8791, estimates: { secondsPerAd: 10 } }, path);
  const loaded = loadPolicy(path);
  assert.deepEqual(loaded, saved);
  assert.equal(loaded.port, 8791);
});
