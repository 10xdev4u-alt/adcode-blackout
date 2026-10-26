#!/usr/bin/env node
/**
 * Every command, in every state it can meet.
 *
 *   node scripts/surface.js [--keep]
 *
 * The unit tests check commands one at a time, each with a fixture it built for
 * itself. This walks the whole surface the way a person meets it - nothing
 * running, running, paused - and asks three things of each answer: an exit code
 * that means what the README says, JSON that parses when the flag promises JSON,
 * and no stack trace where a sentence belongs.
 *
 * A command that throws a `TypeError` at the user, or exits 0 when it did
 * nothing, is indistinguishable from a broken tool. That is what this is for.
 *
 * Exit 0 when every check held, 1 otherwise. No dependencies, like the rest.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/blackout.js", import.meta.url));
const keep = process.argv.includes("--keep");

/** A port the kernel says is free right now, so runs do not collide. */
function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const root = mkdtempSync(join(tmpdir(), "blackout-surface-"));
const home = join(root, "home");
const state = join(home, ".local", "state", "blackout");
const config = join(home, ".config", "blackout");
const port = await freePort();
const env = { ...process.env, HOME: home, BLACKOUT_HOME: config, BLACKOUT_STATE: state };

mkdirSync(config, { recursive: true });
mkdirSync(join(home, "Applications"), { recursive: true });
writeFileSync(join(config, "config.json"), `${JSON.stringify({ port, upstream: "http://127.0.0.1:9" }, null, 2)}\n`);

/*
 * A stand-in build that behaves like the real one where it counts: it reads
 * ADCODE_AD_SERVER and asks for an ad and a config, then stays open. A fixture
 * that makes no calls would only ever exercise compat's failure path, and the
 * pass verdict - the one a user acts on - would stay untested.
 */
const app = join(home, "Applications", "ADCode-2.4.0.AppImage");
writeFileSync(
  app,
  `#!/bin/sh\nnode -e 'const u = process.env.ADCODE_AD_SERVER; fetch(u + "/v1/serve", { method: "POST", body: "{}" }).catch(() => {}); fetch(u + "/v1/config").catch(() => {});'\nsleep 5\n${"#".repeat(1_100_000)}\n`,
);
chmodSync(app, 0o755);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `  (${detail})`}`);
}

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 40_000 });
  return { code: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
}

/** A message, not a stack trace. */
function sentence(text) {
  return !/\n\s+at (?:file:|node:|node_modules)/.test(text) && !/^Error:/m.test(text);
}

function json(result) {
  try {
    return JSON.parse(result.out);
  } catch {
    return null;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function healthy() {
  try {
    return (await fetch(`http://127.0.0.1:${port}/_blackout/health`, { signal: AbortSignal.timeout(300) })).ok;
  } catch {
    return false;
  }
}

/** Run one command and hold it to its exit code and its manners. */
function expect(name, args, codes) {
  const result = run(args);
  check(name, codes.includes(result.code) && sentence(result.out + result.err), `${result.code}: ${(result.err || result.out).trim().split("\n").at(-1) ?? ""}`);
  if (args.includes("--json")) check(`${name}: JSON`, json(result) !== null);
  return result;
}

try {
  // ── nothing running ─────────────────────────────────────────────────────
  expect("help", ["help"], [0]);
  expect("--version", ["--version"], [0]);
  expect("status (cold)", ["status"], [1]);
  check("status --json (cold) says so", json(expect("status --json (cold)", ["status", "--json"], [1]))?.running === false);
  expect("report (cold)", ["report"], [0]);
  expect("report --json (cold)", ["report", "--json"], [0]);
  expect("verify (cold)", ["verify"], [0]);
  expect("rules", ["rules"], [0]);
  check("rules --json lists rules", (json(expect("rules --json", ["rules", "--json"], [0]))?.rules ?? []).length > 0);
  expect("config (show)", ["config"], [0]);
  expect("doctor (cold)", ["doctor", "--json"], [0]);
  expect("events (cold)", ["events"], [1]);
  expect("pause (cold)", ["pause"], [1]);
  expect("resume (cold)", ["resume"], [1]);
  expect("launch --dry-run", ["launch", "--app", app, "--dry-run"], [0]);
  expect("unknown command", ["nonsense"], [2]);
  expect("unknown flag", ["status", "--nope"], [2]);
  expect("bad port", ["config", "--port", "70000"], [1]);

  // ── running ─────────────────────────────────────────────────────────────
  check("serve --detach", run(["serve", "--detach"]).code === 0);
  for (let attempt = 0; attempt < 40 && !(await healthy()); attempt++) await wait(100);
  check("the detached proxy is up", await healthy());

  // One state directory, one writer. The refusal has to reach the user as a
  // message naming the holder, not as a journal broken at entry 1 later.
  let otherPort = await freePort();
  while (otherPort === port) otherPort = await freePort();
  const second = expect("serve (second, other port)", ["serve", "--detach", "--port", String(otherPort)], [1]);
  check("the second proxy names the state directory", /another proxy is writing/.test(second.err), second.err.trim().split("\n")[0]);

  expect("status", ["status"], [0]);
  expect("report", ["report"], [0]);
  expect("verify", ["verify"], [0]);
  check("doctor says the proxy is up", json(expect("doctor --json", ["doctor", "--json"], [0]))?.checks.find((one) => one.name === "proxy")?.state === "ok");
  check("status --json sees the proxy", json(run(["status", "--json"]))?.running === true);

  // A decision first: `events --once` waits for one rather than inventing it.
  check("a decision is accepted", (await fetch(`http://127.0.0.1:${port}/v1/serve`, { method: "POST", body: "{}" }).then((response) => response.status).catch(() => 0)) === 200);
  check("events --once prints a decision", /serve-blocked/.test(expect("events --once", ["events", "--once"], [0]).out));
  check("events --once --json parses", json(run(["events", "--once", "--json"]))?.kind === "serve-blocked");

  // ── paused ──────────────────────────────────────────────────────────────
  check("pause", /paused/.test(run(["pause"]).out));
  check("status --json sees the pause", json(run(["status", "--json"]))?.enabled === false);
  check("report --json sees the pause", json(run(["report", "--json"]))?.enabled === false);
  check("report text says paused", /state\s+paused/.test(run(["report"]).out));
  check("resume", /blocking/.test(run(["resume"]).out));

  // ── config writes ───────────────────────────────────────────────────────
  const written = run(["config", "--upstream", "https://example.test/"]);
  check("config --upstream normalises the url", written.code === 0 && /^upstream\s+https:\/\/example\.test$/m.test(written.out), written.out.trim().split("\n")[1]);
  check("config --dashboard off", /dashboard\s+off/.test(run(["config", "--dashboard", "off"]).out));
  const policy = JSON.parse(readFileSync(join(config, "config.json"), "utf8"));
  check("the file has the new values", policy.upstream === "https://example.test" && policy.dashboard === false);
  const refused = run(["config", "--upstream", "file:///etc/passwd"]);
  check("an invalid upstream is refused", refused.code === 1 && /http/.test(refused.err), refused.err.trim());
  check("a refused write leaves the file alone", JSON.parse(readFileSync(join(config, "config.json"), "utf8")).upstream === "https://example.test");
  // The running proxy keeps what it started with: a config write is not a reload.
  check("a rewritten config does not move the running proxy", (await fetch(`http://127.0.0.1:${port}/_blackout/dashboard`).then((response) => response.status)) === 200);

  // ── compat, launch, install, uninstall ──────────────────────────────────
  const compat = expect("compat", ["compat", "--app", app, "--seconds", "2", "--json"], [0]);
  const compatResult = json(compat);
  check("compat passes a build that speaks the contract", compatResult?.verdict === "pass", compatResult?.verdict);
  check("compat saw the serve it could empty", (compatResult?.observed?.serves ?? 0) > 0);
  check("a passing compat run keeps no journal behind", compatResult?.journalPath === null);
  // The failure path shares `judge` with the unit tests, but the retained
  // artifacts are the CLI's job: a silent build must leave something to read.
  const silent = join(root, "silent.AppImage");
  writeFileSync(silent, `#!/bin/sh\nsleep 5\n${"#".repeat(1_100_000)}\n`);
  chmodSync(silent, 0o755);
  const failed = expect("compat (silent app)", ["compat", "--app", silent, "--seconds", "1", "--json"], [2]);
  const failedResult = json(failed);
  check("compat fails a build that never calls", failedResult?.verdict === "fail");
  check("compat keeps the journal of a failure", existsSync(failedResult?.journalPath ?? ""));
  if (failedResult?.journalPath) rmSync(join(failedResult.journalPath, ".."), { recursive: true, force: true });

  expect("launch", ["launch", "--app", app], [0]);
  expect("install", ["install", "--app", app], [0]);
  check("the launcher exists", existsSync(join(home, ".local", "bin", "adcode")));
  const uninstall = expect("uninstall", ["uninstall"], [0]);
  check("uninstall stopped the proxy", !(await healthy()), uninstall.out.trim().split("\n")[0]);
  check("uninstall removed the launcher", !existsSync(join(home, ".local", "bin", "adcode")));
} finally {
  // Whatever survived on this port is from this run: stop it by its own pid.
  try {
    process.kill(Number(readFileSync(join(state, "blackout.pid"), "utf8").trim()), "SIGKILL");
  } catch {
    // Already stopped, which is the usual case.
  }
  if (!keep) rmSync(root, { recursive: true, force: true });
  else console.log(`\nkept ${root}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length} failed of ${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
