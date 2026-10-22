#!/usr/bin/env node
/**
 * A smoke test that needs no AppImage: start the proxy on a free port, speak the
 * four contract calls, print the report. This is the check to run after a rule
 * change, before touching a real install.
 */
import { createProxy } from "../src/proxy.js";
import { createJournal } from "../src/journal.js";
import { parsePolicy } from "../src/policy.js";
import { loadRulePack } from "../src/rules.js";
import { formatReport } from "../src/report.js";

const policy = parsePolicy({ port: 0, upstream: "http://127.0.0.1:9" });
const journal = createJournal();
const proxy = createProxy({ policy, journal, rules: loadRulePack("core") });
const url = await proxy.listen(0, "127.0.0.1");

const call = async (path, options) => {
  const response = await fetch(`${url}${path}`, options);
  return { status: response.status, body: await response.json() };
};

const results = [];
results.push(["serve", await call("/v1/serve", { method: "POST", body: JSON.stringify({ tags: [], themeKind: "dark", count: 2 }) })]);
results.push(["receipts", await call("/v1/receipts", { method: "POST", body: JSON.stringify({ receipts: [{ receiptId: "smoke-1" }] }) })]);
results.push(["config", await call("/v1/config")]);
results.push(["balance", await call("/v1/balance")]);

const ok =
  results[0][1].body.creatives.length === 0 &&
  results[1][1].body.acked[0] === "smoke-1" &&
  results[2][1].body.killSwitch === true &&
  results[3][1].status === 502;

console.log(formatReport(proxy.report()));
console.log("");
for (const [name, result] of results) console.log(`${name.padEnd(9)} ${result.status} ${JSON.stringify(result.body)}`);
console.log("");
console.log(ok ? "smoke: ok" : "smoke: FAILED");
await proxy.close();
process.exit(ok ? 0 : 1);
