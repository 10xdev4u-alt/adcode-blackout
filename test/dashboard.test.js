import test from "node:test";
import assert from "node:assert/strict";
import { renderDashboard } from "../src/dashboard.js";

const report = {
  version: "0.1.0",
  enabled: true,
  upstream: "https://adcode.test",
  totals: { servesBlocked: 7, receiptsBlocked: 3, configsRewritten: 1, endpointsSeen: 1 },
  attention: { seconds: 56, minutes: 1, hours: 0.02 },
  estimates: { usdForgone: "$0.0105", microsForgone: "10500", note: "estimated from policy.estimates, not from the server's clearing price" },
  endpoints: [{ method: "POST", path: "/v1/ads", firstSeenAt: 1 }],
  integrity: { ok: true, brokenAt: null },
};

test("the dashboard renders the counters and the endpoint", () => {
  const html = renderDashboard(report);
  assert.match(html, />7</);
  assert.match(html, />3</);
  assert.match(html, /\$0\.0105/);
  assert.match(html, /\/v1\/ads/);
  assert.match(html, /chain ok/);
});

test("every dynamic value is escaped", () => {
  const evil = structuredClone(report);
  evil.upstream = '"><script>alert(1)</script>';
  evil.endpoints = [{ method: "<b>", path: "</code><script>x</script>" }];
  const html = renderDashboard(evil);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("the page makes no external request", () => {
  const html = renderDashboard(report);
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:/);
  assert.doesNotMatch(html, /fetch\(["']https?:/);
  assert.doesNotMatch(html, /@import/);
  assert.match(html, /fetch\("\/_blackout\/report"/);
});

test("a broken chain is shown as broken, not hidden", () => {
  const broken = { ...report, integrity: { ok: false, brokenAt: 4 } };
  assert.match(renderDashboard(broken), /chain broken at 4/);
});
