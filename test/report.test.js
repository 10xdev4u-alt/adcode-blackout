import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, formatReport } from "../src/report.js";

function entry(kind, data = {}, at = 1_000) {
  return { seq: 0, at, kind, data, prev: "0".repeat(64), hash: "f".repeat(64) };
}

const policy = { upstream: "https://example.test", estimates: { secondsPerAd: 8, microsPerView: 1500 } };

test("counts serves, the receipts inside a batch, and config rewrites", () => {
  const report = buildReport([
    entry("serve-blocked"),
    entry("serve-blocked"),
    entry("receipt-blocked", { count: 3 }),
    entry("config-rewritten"),
  ], { policy, now: 2_000 });
  assert.equal(report.totals.servesBlocked, 2);
  assert.equal(report.totals.receiptsBlocked, 3);
  assert.equal(report.totals.configsRewritten, 1);
});

test("attention and forgone earnings come from the stated estimates", () => {
  const report = buildReport([entry("serve-blocked"), entry("serve-blocked")], { policy, now: 2_000 });
  assert.equal(report.attention.seconds, 16);
  assert.equal(report.estimates.microsForgone, "3000");
  assert.equal(report.estimates.usdForgone, "$0.003");
  assert.match(report.estimates.note, /not from the server/);
});

test("unique unclassified endpoints are listed once", () => {
  const report = buildReport([
    entry("endpoint-seen", { method: "POST", path: "/v1/ads" }),
    entry("endpoint-seen", { method: "POST", path: "/v1/ads" }),
    entry("endpoint-seen", { method: "GET", path: "/v1/config" }),
  ], { policy, now: 2_000 });
  assert.equal(report.totals.endpointsSeen, 2);
  assert.deepEqual(report.endpoints.map((item) => item.path), ["/v1/ads", "/v1/config"]);
});

test("an empty journal is a valid, zeroed report", () => {
  const report = buildReport([], { policy, now: 2_000 });
  assert.equal(report.totals.servesBlocked, 0);
  assert.equal(report.attention.seconds, 0);
  assert.equal(report.estimates.usdForgone, "$0");
  assert.equal(report.integrity.ok, true);
});

test("the text report names the state and the chain", () => {
  const text = formatReport(buildReport([entry("serve-blocked")], { policy, now: 2_000, enabled: false }));
  assert.match(text, /paused/);
  assert.match(text, /ads stopped\s+1/);
  assert.match(text, /journal chain/);
});

test("the text report lists the endpoints seen outside the rules", () => {
  const withEndpoints = formatReport(buildReport([
    entry("serve-blocked"),
    entry("endpoint-seen", { method: "POST", path: "/v1/ads" }),
    entry("endpoint-seen", { method: "GET", path: "/v1/extra" }),
  ], { policy, now: 2_000 }));
  assert.match(withEndpoints, /endpoints seen outside the rules/);
  assert.match(withEndpoints, /POST \/v1\/ads/);
  assert.match(withEndpoints, /GET \/v1\/extra/);

  // The section is a finding, not a fixture: with nothing unclassified the
  // report has no heading for an empty list.
  const plain = formatReport(buildReport([entry("serve-blocked")], { policy, now: 2_000 }));
  assert.doesNotMatch(plain, /endpoints seen outside the rules/);
});

test("the text report says when the journal file stopped accepting writes", () => {
  const text = formatReport(buildReport([entry("serve-blocked")], {
    policy,
    now: 2_000,
    journalWriteError: { at: 1_000, message: "EISDIR: illegal operation on a directory" },
  }));
  assert.match(text, /journal file NOT writable/);
  assert.match(text, /EISDIR/);
  assert.match(text, /in memory only/);
});
