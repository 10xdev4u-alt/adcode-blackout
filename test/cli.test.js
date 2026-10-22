/**
 * The test the README promises: install, launch, look, uninstall.
 *
 * Everything here runs through the real CLI in a real child process, against a
 * temporary HOME, so it exercises the same path a person does - including the
 * detached proxy that `launch` starts and the wrapper that survives it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/blackout.js", import.meta.url));
const PORT = 18793;

function run(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      BLACKOUT_HOME: join(home, ".config", "blackout"),
      BLACKOUT_STATE: join(home, ".local", "state", "blackout"),
      ...extraEnv,
    },
  });
}

async function setup(port = PORT) {
  const home = await mkdtemp(join(tmpdir(), "blackout-cli-"));
  mkdirSync(join(home, "Applications"), { recursive: true });
  mkdirSync(join(home, ".config", "blackout"), { recursive: true });
  writeFileSync(
    join(home, ".config", "blackout", "config.json"),
    `${JSON.stringify({ port, upstream: "http://127.0.0.1:9" }, null, 2)}\n`,
  );

  const out = join(home, "launched.txt");
  const app = join(home, "Applications", "ADCode-2.4.0.AppImage");
  writeFileSync(
    app,
    `#!/bin/sh\nprintf '%s\\n' "$ADCODE_AD_SERVER" > '${out}'\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${out}'; done\n${"#".repeat(1_200_000)}`,
  );
  chmodSync(app, 0o755);
  return { home, app, out };
}

function stopProxy(home) {
  const pidFile = join(home, ".local", "state", "blackout", "blackout.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("install, launch, pause, report, verify, uninstall", async () => {
  const { home, app, out } = await setup();
  try {
    const installed = run(home, ["install", "--app", app]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /launcher/);
    const wrapper = join(home, ".local", "bin", "adcode");
    assert.ok(existsSync(wrapper));
    assert.match(readFileSync(wrapper, "utf8"), /adcode-blackout launcher/);

    const launched = run(home, ["launch", "--app", app, "--", "--no-sandbox"]);
    assert.equal(launched.status, 0, launched.stderr);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    assert.equal(lines[0], `http://127.0.0.1:${PORT}`);
    assert.deepEqual(lines.slice(1), ["--no-sandbox"]);

    const health = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${PORT}/_blackout/health`)).ok;
      } catch {
        return false;
      }
    });
    assert.equal(health, true, "the detached proxy should answer");

    const status = run(home, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /blocking/);

    const scriptable = run(home, ["status", "--json"]);
    assert.equal(scriptable.status, 0, scriptable.stderr);
    const statusObject = JSON.parse(scriptable.stdout);
    assert.equal(statusObject.running, true);
    assert.equal(statusObject.url, `http://127.0.0.1:${PORT}`);
    assert.equal(typeof statusObject.totals.servesBlocked, "number");
    assert.equal(statusObject.integrity.ok, true);

    const paused = run(home, ["pause"]);
    assert.equal(paused.status, 0, paused.stderr);
    assert.match(paused.stdout, /paused/);

    const resumed = run(home, ["resume"]);
    assert.match(resumed.stdout, /blocking/);

    const report = run(home, ["report", "--json"]);
    assert.equal(report.status, 0, report.stderr);
    const parsed = JSON.parse(report.stdout);
    assert.equal(parsed.name, "adcode-blackout");
    assert.equal(parsed.integrity.ok, true);

    const verified = run(home, ["verify"]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /^ok:/);

    const doctor = run(home, ["doctor"]);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /ok\s+appimage/);
  } finally {
    stopProxy(home);
    const stopped = await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${PORT}/_blackout/health`, { signal: AbortSignal.timeout(200) });
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(stopped, true, "the proxy should stop when asked");
  }

  const removed = run(home, ["uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(join(home, ".local", "bin", "adcode")), false);
  assert.ok(existsSync(join(home, ".local", "state", "blackout", "journal.jsonl")), "uninstall keeps the journal");
  assert.ok(existsSync(join(home, ".config", "blackout", "config.json")), "uninstall keeps the config");

  const purged = run(home, ["uninstall", "--purge"]);
  assert.equal(purged.status, 0, purged.stderr);
  assert.equal(existsSync(join(home, ".local", "state", "blackout", "journal.jsonl")), false);
  assert.equal(existsSync(join(home, ".config", "blackout", "config.json")), false);
});

test("purge refuses to follow a symlink out of the state directory", async () => {
  const { home } = await setup(18800);
  const target = join(home, "outside.txt");
  writeFileSync(target, "keep me");
  mkdirSync(join(home, ".local", "state", "blackout"), { recursive: true });
  symlinkSync(target, join(home, ".local", "state", "blackout", "journal.jsonl"));

  const result = run(home, ["uninstall", "--purge"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to delete the symlink/);
  assert.equal(readFileSync(target, "utf8"), "keep me");
  assert.ok(existsSync(join(home, ".config", "blackout", "config.json")), "nothing was deleted");
});

test("doctor names the process holding the proxy port", { skip: process.platform !== "linux" }, async () => {
  const { home } = await setup(18799);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(18799, "127.0.0.1", resolve));
  try {
    const result = run(home, ["doctor"], { BLACKOUT_STATE: join(home, ".local", "state", "blackout") });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /FAIL\s+proxy\s+.*is held by pid \d+/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("rules prints the active pack, and --json prints it whole", async () => {
  const { home } = await setup(18797);
  const text = run(home, ["rules"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /pack\s+core v1/);
  assert.match(text.stdout, /serve-v1\s+POST\s+empty-serve\s+\/v1\/serve/);

  const json = run(home, ["rules", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const pack = JSON.parse(json.stdout);
  assert.equal(pack.name, "core");
  assert.ok(pack.rules.some((rule) => rule.id === "receipts-v1"));
  assert.ok(pack.rules.every((rule) => typeof rule.action === "string"));
});

test("version is printed without starting anything", async () => {
  const { home } = await setup(18798);
  for (const args of [["--version"], ["version"]]) {
    const result = run(home, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
  }
});

test("an unknown command is a usage error, not a stack trace", async () => {
  const { home } = await setup();
  const result = run(home, ["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test("status --json is explicit about not running", async () => {
  const { home } = await setup(18795);
  const result = run(home, ["status", "--json"]);
  assert.equal(result.status, 1);
  const object = JSON.parse(result.stdout);
  assert.equal(object.running, false);
  assert.equal(object.url, "http://127.0.0.1:18795");
});

test("launch --dry-run starts nothing and prints what it would do", async () => {
  const { home, app, out } = await setup(18796);
  const result = run(home, ["launch", "--dry-run", "--app", app, "--", "--flag"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`appimage\\s+${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result.stdout, /resolved\s+explicit/);
  assert.match(result.stdout, /env\s+ADCODE_AD_SERVER=http:\/\/127\.0\.0\.1:18796/);
  assert.match(result.stdout, /argv\s+.*--flag/);
  assert.equal(existsSync(out), false, "the app must not run");
  await assert.rejects(fetch("http://127.0.0.1:18796/_blackout/health"), /fetch failed/);
});

test("launch without an AppImage says how to point at one", async () => {
  const home = await mkdtemp(join(tmpdir(), "blackout-cli-empty-"));
  const result = run(home, ["launch"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no ADCode AppImage found/);
});
