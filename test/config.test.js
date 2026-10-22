import test from "node:test";
import assert from "node:assert/strict";
import { rewriteConfig, SAFE_CONFIG, serializeConfig } from "../src/config.js";

test("a real config is forced off while its projections survive", () => {
  const body = {
    killSwitch: false,
    caps: { minIntervalMs: 300_000, dailyCap: 24 },
    projections: { off: "0", light: "12000", standard: "36000", max: "90000" },
  };
  const { config } = rewriteConfig(JSON.stringify(body));
  assert.equal(config.killSwitch, true);
  assert.equal(config.caps.dailyCap, 0);
  assert.equal(config.caps.minIntervalMs, 300_000);
  assert.deepEqual(config.projections, body.projections);
});

test("the rewritten object has exactly the keys the client validates", () => {
  const { config } = rewriteConfig(JSON.stringify({ killSwitch: false, caps: {}, projections: {}, extra: "no" }));
  assert.deepEqual(Object.keys(config).sort(), ["caps", "killSwitch", "projections"]);
  assert.deepEqual(Object.keys(config.caps), ["dailyCap"]);
  assert.deepEqual(Object.keys(config.projections).sort(), ["light", "max", "off", "standard"]);
});

test("missing or non-decimal projections fall back to zero, not to a crash", () => {
  const { config } = rewriteConfig(JSON.stringify({ killSwitch: false, projections: { off: 0, light: "abc" } }));
  assert.deepEqual(config.projections, SAFE_CONFIG.projections);
});

test("an unexpected caps shape becomes the safe cap", () => {
  const { config } = rewriteConfig(JSON.stringify({ killSwitch: false, caps: "none" }));
  assert.deepEqual(config.caps, { dailyCap: 0 });
});

test("a non-object or non-JSON body is refused", () => {
  assert.throws(() => rewriteConfig("not json"), /not JSON/);
  assert.throws(() => rewriteConfig("[]"), /not an object/);
  assert.throws(() => rewriteConfig("null"), /not an object/);
});

test("the serialized config is valid JSON with the four presets", () => {
  const { config } = rewriteConfig("{}");
  const parsed = JSON.parse(serializeConfig(config));
  assert.equal(parsed.killSwitch, true);
  for (const preset of ["off", "light", "standard", "max"]) {
    assert.match(parsed.projections[preset], /^\d+$/);
  }
});
