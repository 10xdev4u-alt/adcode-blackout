import test from "node:test";
import assert from "node:assert/strict";
import { loadRulePack, matchRule, coveredTargets } from "../src/rules.js";

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
  assert.throws(() => {
    const bad = structuredClone(pack);
    bad.rules[0].action = "delete";
    // validatePack runs on the raw object; re-validate through the public path
    return import("../src/rules.js").then(({ validatePack }) => validatePack(bad));
  });
});
