/**
 * The numbers a person actually wants: how many ads were stopped, how much
 * attention that bought back, and what the blocker chose not to earn.
 *
 * The last one is deliberate. A blocker that only says "42 ads blocked" hides
 * the trade it made. `microsForgone` is an estimate from the policy, not a
 * measurement from the server; the report says so in the same breath.
 */
import { summarize, verifyChain } from "./journal.js";

function usd(micros) {
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? `$${whole}` : `$${whole}.${fraction}`;
}

export function buildReport(entries, { policy, version = "0.0.0", now = Date.now(), enabled = true, journalWriteError = null } = {}) {
  const counts = summarize(entries);
  const serves = counts["serve-blocked"] ?? 0;
  const receipts = entries
    .filter((entry) => entry.kind === "receipt-blocked")
    .reduce((total, entry) => total + (Number.isSafeInteger(entry.data?.count) ? entry.data.count : 1), 0);
  const configs = counts["config-rewritten"] ?? 0;

  const endpoints = [];
  const seen = new Set();
  for (const entry of entries) {
    if (entry.kind !== "endpoint-seen") continue;
    const key = `${entry.data?.method ?? "?"} ${entry.data?.path ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({
      method: entry.data?.method ?? "?",
      path: entry.data?.path ?? "?",
      firstSeenAt: entry.at,
    });
  }

  const seconds = serves * (policy?.estimates?.secondsPerAd ?? 0);
  const microsForgone = BigInt(serves) * BigInt(policy?.estimates?.microsPerView ?? 0);
  const firstAt = entries.length > 0 ? entries[0].at : null;
  const lastAt = entries.length > 0 ? entries[entries.length - 1].at : null;

  return {
    name: "adcode-blackout",
    version,
    generatedAt: now,
    upstream: policy?.upstream ?? null,
    enabled,
    window: { entries: entries.length, firstAt, lastAt },
    totals: {
      servesBlocked: serves,
      receiptsBlocked: receipts,
      configsRewritten: configs,
      endpointsSeen: endpoints.length,
    },
    attention: {
      seconds,
      minutes: Math.round(seconds / 60),
      hours: Number((seconds / 3600).toFixed(2)),
    },
    estimates: {
      microsForgone: microsForgone.toString(),
      usdForgone: usd(microsForgone),
      note: "estimated from policy.estimates, not from the server's clearing price",
    },
    endpoints,
    integrity: verifyChain(entries),
    journalHead: entries.length > 0 ? entries[entries.length - 1].hash : null,
    journalWriteError,
  };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`adcode-blackout ${report.version}`);
  lines.push(`upstream   ${report.upstream}`);
  lines.push(`state      ${report.enabled ? "blocking" : "paused"}`);
  lines.push("");
  lines.push(`ads stopped        ${report.totals.servesBlocked}`);
  lines.push(`receipts acked     ${report.totals.receiptsBlocked}`);
  lines.push(`configs rewritten  ${report.totals.configsRewritten}`);
  lines.push(`attention returned ${report.attention.minutes} min (${report.attention.hours} h)`);
  lines.push(`earnings forgone   ${report.estimates.usdForgone} (${report.estimates.note})`);
  if (report.endpoints.length > 0) {
    lines.push("");
    lines.push("endpoints seen outside the rules");
    for (const endpoint of report.endpoints) lines.push(`  ${endpoint.method} ${endpoint.path}`);
  }
  lines.push("");
  lines.push(report.integrity.ok
    ? `journal chain ok, head ${String(report.journalHead).slice(0, 12)}…`
    : `journal chain BROKEN at entry ${report.integrity.brokenAt}`);
  if (report.journalWriteError != null) {
    lines.push(`journal file NOT writable since ${new Date(report.journalWriteError.at).toISOString()}: ${report.journalWriteError.message}`);
    lines.push("decisions from that point are in memory only and will not survive a restart");
  }
  return lines.join("\n");
}
