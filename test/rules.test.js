import test from "node:test";
import assert from "node:assert/strict";
import { loadRulePack, matchRule, coveredTargets, userRulePath, validatePack } from "../src/rules.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const pack = loadRulePack("core");

test("the v1 ad endpoints match their rules", () => {
  assert.equal(matchRule(pack, "POST", "/v1/serve")?.action, "empty-serve");
  assert.equal(matchRule(pack, "POST", "/v1/receipts")?.action, "ack-receipts");
  assert.equal(matchRule(pack, "GET", "/v1/config")?.action, "rewrite-config");
});

test("a future version of the same path matches the tolerant rule", () => {
  assert.equal(matchRule(pack, "POST", "/v2/serve")?.id, "serve-vnext");
  assert.equal(matchRule(pack, "POST", "/v12/receipts")?.id, "receipts-vnext");
});

test("method matters: a GET on serve is not the inventory call", () => {
  assert.equal(matchRule(pack, "GET", "/v1/serve"), null);
});

test("an unrelated endpoint does not match", () => {
  assert.equal(matchRule(pack, "POST", "/v1/chat"), null);
  assert.equal(matchRule(pack, "POST", "/v1/receipts/extra"), null);
});

test("coverage lists every target once", () => {
  const targets = coveredTargets(pack);
  assert.ok(targets.includes("/v1/serve"));
  assert.ok(targets.includes("/v1/receipts"));
  assert.equal(new Set(targets).size, targets.length);
});

test("an unknown action is refused at load", () => {
  const bad = { name: "x", rules: [{ id: "a", match: { method: "POST", path: "/x" }, action: "delete" }] };
  assert.throws(() => validatePack(bad), /unknown action/);
});

test("a bad pattern is refused with the rule name", () => {
  const bad = { name: "x", rules: [{ id: "oops", match: { method: "POST", pathPattern: "(" }, action: "block" }] };
  assert.throws(() => validatePack(bad), /oops/);
});

test("a duplicate rule id is refused", () => {
  const rule = { id: "same", match: { method: "POST", path: "/x" }, action: "block" };
  assert.throws(() => validatePack({ name: "x", rules: [rule, rule] }), /duplicate/);
});

test("a user pack overrides the bundled one, and says where it came from", () => {
  const home = mkdtempSync(join(tmpdir(), "blackout-rules-"));
  const previous = process.env["BLACKOUT_HOME"];
  process.env["BLACKOUT_HOME"] = home;
  try {
    const path = userRulePath("custom");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      name: "custom",
      version: 3,
      rules: [{ id: "extra", match: { method: "POST", path: "/v1/extra" }, action: "block" }],
    }));

    const pack = loadRulePack("custom");
    assert.equal(pack.name, "custom");
    assert.equal(pack.version, 3);
    assert.equal(pack.source, path);
    const matched = matchRule(pack, "POST", "/v1/extra");
    assert.equal(matched.action, "block");
  } finally {
    if (previous === undefined) delete process.env["BLACKOUT_HOME"];
    else process.env["BLACKOUT_HOME"] = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an invalid user pack is refused with its path, not silently ignored", () => {
  const home = mkdtempSync(join(tmpdir(), "blackout-rules-bad-"));
  const previous = process.env["BLACKOUT_HOME"];
  process.env["BLACKOUT_HOME"] = home;
  try {
    const path = userRulePath("core");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ this is not json");
    assert.throws(() => loadRulePack("core"), (error) => error.message.includes(path));
  } finally {
    if (previous === undefined) delete process.env["BLACKOUT_HOME"];
    else process.env["BLACKOUT_HOME"] = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
