/**
 * Does this build still speak the contract?
 *
 * The manual check in docs/COMPATIBILITY.md is two minutes of watching a
 * report. This is the same check as one command: start a private proxy on an
 * ephemeral port, launch the build against it with `ADCODE_AD_SERVER`, watch
 * the journal for a fixed window, and say what happened.
 *
 * The judgement (`judge`) is separate from the running (`runCompat`) on
 * purpose. It takes journal entries and an exit, so it can be tested without an
 * AppImage and can be pointed at a journal captured somewhere else.
 *
 * The verdict is about the blocker, not about the app being healthy: an app
 * that runs fine but never calls `/v1/serve` has quietly lost its blocker, and
 * that is the failure this exists to catch.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "./journal.js";
import { createProxy } from "./proxy.js";
import { parsePolicy } from "./policy.js";
import { VERSION } from "./version.js";

/** How long a stopped app gets to exit before it is killed outright. */
const KILL_GRACE_MS = 3_000;

const uniqueEndpoints = (entries) => {
  const seen = new Map();
  for (const entry of entries) {
    if (entry.kind !== "endpoint-seen") continue;
    seen.set(`${entry.data?.method ?? "?"} ${entry.data?.path ?? "?"}`, entry.data);
  }
  return [...seen.values()];
};

/**
 * Turn one run's journal into a verdict.
 *
 * `pass` needs the two calls the blocker actually depends on to have happened
 * and been answered: a serve it could empty, and a config it could rewrite.
 * Receipts are not required - they only follow an impression, and a window with
 * no ad opportunity is a normal window.
 *
 * `inconclusive` is not a failure: the app reached the proxy but did not need
 * an ad yet. Running again with the editor open and focused is the answer.
 * `fail` is reserved for the ways the blocker is actually lost: no contact at
 * all, a rejected Host, a config response that fell back to safe defaults, an
 * unclassified ad-like endpoint that was passed through, or an app that died.
 */
export function judge({ entries = [], requests = null, exit = { timedOut: true }, seconds = null, appImage = null } = {}) {
  const count = (kind) => entries.filter((entry) => entry.kind === kind).length;
  const serves = count("serve-blocked");
  const receipts = count("receipt-blocked");
  const configs = count("config-rewritten");
  const degraded = entries.filter((entry) => entry.kind === "config-degraded");
  // Two different things wear the same journal kind. A response we could not
  // check (upstream down, 401, 500) proves nothing about the schema and must not
  // be reported as drift; a 200 we could not parse is drift.
  // Parse failures are journaled without a status; upstream failures carry one.
  const driftDegraded = degraded.filter((entry) => typeof entry.data?.status !== "number");
  const rejected = entries.filter((entry) => entry.kind === "host-rejected");
  const drift = uniqueEndpoints(entries);

  const checks = [];
  const add = (state, name, detail) => checks.push({ state, name, detail });

  if (exit?.error) {
    add("fail", "launch", `cannot start ${appImage}: ${exit.error.message ?? exit.error}`);
  } else if (exit?.timedOut) {
    add("ok", "launch", `alive for the whole ${seconds}s window`);
  } else if (exit?.code === 0) {
    // It quit cleanly, which is not a contract failure but does mean the window
    // was cut short. Say so rather than calling it a pass.
    add("warn", "launch", "exited on its own before the window ended (code 0)");
  } else {
    add("fail", "launch", `exited during the window (${exit?.signal ?? `code ${exit?.code}`})`);
  }

  if (entries.length > 0) {
    add("ok", "contact", `${entries.length} decision${entries.length === 1 ? "" : "s"} recorded`);
  } else if (requests !== null && requests > 0) {
    // It is talking to us, but only about things that are not ads. That is a
    // window without an ad opportunity, not a build that ignored the variable.
    add("ok", "contact", `${requests} request${requests === 1 ? "" : "s"}, none of them ad calls`);
  } else {
    add("fail", "contact", "the app never called the proxy; ADCODE_AD_SERVER is not being read");
  }

  add(serves > 0 ? "ok" : "warn", "serve", serves > 0 ? `${serves} blocked` : "no /v1/serve in this window");
  // Not a warning: receipts only follow an impression, and a window without an
  // ad opportunity is a normal window. Its absence proves nothing either way.
  add("ok", "receipts", receipts > 0 ? `${receipts} acked` : "none this window (normal without an impression)");

  const unverified = degraded.filter((entry) => !driftDegraded.includes(entry));
  if (driftDegraded.length > 0) {
    add("fail", "config", `${driftDegraded.length} response(s) could not be rewritten: ${driftDegraded[0].data?.reason ?? "unparsable"} - the schema moved`);
  } else if (configs > 0) {
    add("ok", "config", `${configs} rewritten`);
  } else if (unverified.length > 0) {
    // Blocking still happens (SAFE_CONFIG), but the rewrite is unproven, so this
    // is not a pass. Usually the upstream is simply unreachable from here.
    add("warn", "config", `upstream answered ${unverified[0].data?.status ?? "nothing"}; rewrite not verified`);
  } else {
    add("warn", "config", "no /v1/config in this window");
  }

  if (rejected.length > 0) {
    const names = [...new Set(rejected.map((entry) => entry.data?.host ?? "?"))].join(", ");
    add("fail", "host", `refused a non-loopback Host: ${names}`);
  }

  if (drift.length > 0) {
    add("fail", "drift", `passed through ad-like endpoints: ${drift.map((item) => `${item.method} ${item.path}`).join(", ")}`);
  } else {
    add("ok", "drift", "no unclassified ad-like endpoints");
  }

  const failed = checks.some((check) => check.state === "fail");
  const launchFailed = Boolean(exit?.error) || (exit?.timedOut === false && exit?.code !== 0);
  const proven = serves > 0 && configs > 0 && degraded.length === 0 && rejected.length === 0 && drift.length === 0 && !launchFailed;
  const verdict = failed ? "fail" : proven ? "pass" : "inconclusive";

  return {
    name: "adcode-blackout",
    version: VERSION,
    verdict,
    appImage,
    seconds,
    checks,
    observed: {
      requests,
      serves,
      receipts,
      configs,
      configDegraded: degraded.length,
      endpoints: drift.map((item) => ({ method: item.method, path: item.path })),
      hostRejected: [...new Set(rejected.map((entry) => entry.data?.host ?? "?"))],
    },
  };
}

/**
 * Run one build against a private proxy and judge it.
 *
 * The proxy is in-process and single-use: ephemeral port, its own journal in a
 * temp directory, no dashboard. Nothing here reads or writes the user's state,
 * so a compat run cannot disturb a real install - and it is safe to run while
 * the normal blocker is up.
 */
export async function runCompat({ appImage, seconds = 60, policy, rules, keep = false, spawnImpl = spawn }) {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3_600) {
    throw new TypeError("seconds must be an integer between 1 and 3600");
  }

  const dir = mkdtempSync(join(tmpdir(), "blackout-compat-"));
  const journalPath = join(dir, "journal.jsonl");
  const logPath = join(dir, "app.log");
  const journal = createJournal(journalPath);
  const compatPolicy = parsePolicy({ ...policy, port: 0, dashboard: false });
  const proxy = createProxy({ policy: compatPolicy, journal, rules });

  let child = null;
  try {
    const url = await proxy.listen(0, compatPolicy.host);
    const log = openSync(logPath, "a");
    child = spawnImpl(appImage, [], {
      // No inherited stdio: a compat run must not fill the terminal with an
      // Electron app's logging, but the tail is kept for a failure.
      stdio: ["ignore", log, log],
      env: { ...process.env, ADCODE_AD_SERVER: url },
    });
    closeSync(log);

    let timer = null;
    const exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (error) => resolve({ error }));
    });
    const window = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), seconds * 1_000);
      timer.unref?.();
    });

    let exit = await Promise.race([exited, window]);
    clearTimeout(timer);

    if (exit.timedOut) {
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited,
        new Promise((resolve) => {
          const grace = setTimeout(() => resolve(null), KILL_GRACE_MS);
          grace.unref?.();
        }),
      ]);
      if (stopped === null) child.kill("SIGKILL");
      // Keep `timedOut: true`: the app survived the window, which is what the
      // launch check is asking about. The signal is how it was stopped, not how
      // it failed.
      exit = { timedOut: true, killed: true };
    }

    const result = judge({ entries: journal.entries, requests: proxy.stats().requests, exit, seconds, appImage });

    // A clean pass is reproducible from the run's output; a failure is worth
    // reading afterwards, so its journal and app log are kept.
    const retained = keep || result.verdict !== "pass";
    result.journalPath = retained ? journalPath : null;
    result.appLogPath = retained ? logPath : null;
    if (!retained) rmSync(dir, { recursive: true, force: true });

    return result;
  } finally {
    if (child !== null && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await proxy.close();
    // Retained runs keep their directory for inspection; a passing run has
    // already removed it above.
  }
}

export function formatCompat(result) {
  const mark = (state) => (state === "ok" ? "ok  " : state === "warn" ? "warn" : "FAIL");
  const lines = [];
  lines.push(`compat ${result.verdict}  ${result.appImage ?? "(no app)"}  ${result.seconds}s window`);
  for (const check of result.checks) lines.push(`  ${mark(check.state)} ${check.name.padEnd(8)} ${check.detail}`);
  if (result.verdict === "inconclusive") {
    lines.push("");
    lines.push("Not proven either way: open the editor, keep it focused, and run again");
    lines.push("with a longer --seconds. Blocking is not confirmed until a /v1/serve is seen.");
  }
  if (result.verdict === "fail" && result.observed?.endpoints?.length > 0) {
    lines.push("");
    lines.push("An unclassified endpoint passed through. Add the narrowest rule that covers it:");
    lines.push("see docs/RULES.md, then reload with SIGHUP - no release needed.");
  }
  if (result.journalPath !== null && result.journalPath !== undefined) {
    lines.push("");
    lines.push(`journal kept   ${result.journalPath}`);
    if (result.appLogPath !== null && result.appLogPath !== undefined) lines.push(`app log kept   ${result.appLogPath}`);
  }
  return lines.join("\n");
}
