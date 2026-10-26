/**
 * The test the README promises: install, launch, look, uninstall.
 *
 * Everything here runs through the real CLI in a real child process, against a
 * temporary HOME, so it exercises the same path a person does - including the
 * detached proxy that `launch` starts and the wrapper that survives it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/blackout.js", import.meta.url));
const PORT = 18793;
const homes = [];

after(() => {
  for (const home of homes) {
    stopProxy(home);
    rmSync(home, { recursive: true, force: true });
  }
});

/** A listener left by an interrupted run would silently answer for this one. */
function portFree(port) {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

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
  if (!(await portFree(port))) {
    throw new Error(`127.0.0.1:${port} is already in use; a stale proxy from an interrupted test?`);
  }
  const home = await mkdtemp(join(tmpdir(), "blackout-cli-"));
  homes.push(home);
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

function runAsync(home, args) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      HOME: home,
      BLACKOUT_HOME: join(home, ".config", "blackout"),
      BLACKOUT_STATE: join(home, ".local", "state", "blackout"),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, exited };
}

function withTimeout(promise, ms, child) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "timeout" });
    }, ms)),
  ]);
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

test("install --desktop repoints an older AppImage entry, and uninstall restores it", async () => {
  const { home, app } = await setup(18801);
  const dir = join(home, ".local", "share", "applications");
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "adcode.desktop");
  const original = `[Desktop Entry]\nType=Application\nName=ADCode\nExec=/old/ADCode-2.3.0.AppImage %U\n`;
  writeFileSync(entry, original);

  const installed = run(home, ["install", "--app", app, "--desktop"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /desktop\s+.*adcode\.desktop/);
  assert.match(readFileSync(entry, "utf8"), new RegExp(`Exec="${join(home, ".local", "bin", "adcode")}" %U`));

  const removed = run(home, ["uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(readFileSync(entry, "utf8"), original);
});

test("doctor warns when the launcher points at another checkout", async () => {
  const { home } = await setup(18802);
  const wrapper = join(home, ".local", "bin", "adcode");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(wrapper, "#!/bin/sh\n# adcode-blackout launcher\nNODE='node'\nexec \"$NODE\" '/old/checkout/bin/blackout.js' launch -- \"$@\"\n");

  const result = run(home, ["doctor"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /warn\s+launcher\s+.*points at \/old\/checkout/);
});

test("events follows a decision, and --once exits after it", async () => {
  const { home } = await setup(18805);
  const started = run(home, ["serve", "--detach"]);
  assert.equal(started.status, 0, started.stderr);
  try {
    const { child, exited } = runAsync(home, ["events", "--once", "--json"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fetch("http://127.0.0.1:18805/v1/serve", { method: "POST", body: "{}" });

    const result = await withTimeout(exited, 5_000, child);
    assert.equal(result.code, 0, result.stderr);
    const entry = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(entry.kind, "serve-blocked");
    assert.equal(entry.data.path, "/v1/serve");
    assert.equal(entry.data.rule, "serve-v1");

    // With history on disk, `--once` answers immediately with the newest entry.
    // It used to print the oldest of the replayed 20, so a script asking for
    // "the next decision" got one from before it started.
    await fetch("http://127.0.0.1:18805/v1/serve", { method: "POST", body: "{}" });
    const latest = runAsync(home, ["events", "--once", "--json"]);
    const after = await withTimeout(latest.exited, 5_000, latest.child);
    assert.equal(after.code, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout.trim().split("\n").at(-1)).seq, entry.seq + 1);
  } finally {
    stopProxy(home);
  }
});

test("events follows the proxy across a restart", async () => {
  // A restart is ordinary: an update, a crash, `systemctl restart`. The follower
  // used to end there with `blackout: terminated` and exit 1 - while the stream
  // advertised `retry: 3000` as if something would reconnect.
  const port = 18813;
  const { home } = await setup(port);
  const started = run(home, ["serve", "--detach"]);
  assert.equal(started.status, 0, started.stderr);

  let out = "";
  let err = "";
  const follower = spawn(process.execPath, [CLI, "events"], {
    env: {
      ...process.env,
      HOME: home,
      BLACKOUT_HOME: join(home, ".config", "blackout"),
      BLACKOUT_STATE: join(home, ".local", "state", "blackout"),
    },
  });
  follower.stdout.on("data", (chunk) => { out += chunk; });
  follower.stderr.on("data", (chunk) => { err += chunk; });

  const answering = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/_blackout/health`, { signal: AbortSignal.timeout(200) })).ok;
    } catch {
      return false;
    }
  };
  const decide = () => fetch(`http://127.0.0.1:${port}/v1/serve`, { method: "POST", body: "{}" });

  try {
    assert.equal(await waitFor(answering), true, "the proxy should be up");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await decide();
    assert.equal(await waitFor(async () => /serve-blocked/.test(out)), true, `no first decision in ${JSON.stringify(out)}`);

    stopProxy(home);
    assert.equal(await waitFor(async () => !(await answering())), true, "the proxy should be gone");
    assert.equal(follower.exitCode, null, "the follower should still be running");

    const restarted = run(home, ["serve", "--detach"]);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(await waitFor(answering), true);
    await decide();

    // The retry is every three seconds.
    assert.equal(await waitFor(async () => /reconnecting/.test(err), 8_000), true, `no reconnect notice in ${JSON.stringify(err)}`);
    assert.equal(await waitFor(async () => (out.match(/serve-blocked/g) ?? []).length >= 2, 8_000), true, `no second decision in ${JSON.stringify(out)}`);
  } finally {
    follower.kill("SIGKILL");
    await new Promise((resolve) => follower.once("exit", resolve));
    stopProxy(home);
  }
});

test("a read-only config directory does not stop the editor", { skip: process.platform === "win32" }, async () => {
  const port = 18808;
  const { home, app, out } = await setup(port);
  const configDir = join(home, ".config", "blackout");
  chmodSync(configDir, 0o500);
  try {
    const launched = run(home, ["launch", "--app", app]);
    assert.equal(launched.status, 0, launched.stderr);
    // The AppImage record could not be written; the editor still came up
    // pointed at the proxy, which is the whole promise of the launcher.
    assert.match(launched.stderr, /cannot record/);
    assert.equal(readFileSync(out, "utf8").split("\n")[0], `http://127.0.0.1:${port}`);
  } finally {
    chmodSync(configDir, 0o700);
    stopProxy(home);
  }
});

test("uninstall stops the proxy it started", async () => {
  const { home, app } = await setup(18803);
  try {
    const launched = run(home, ["launch", "--app", app]);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(await waitFor(async () => {
      try {
        return (await fetch("http://127.0.0.1:18803/_blackout/health")).ok;
      } catch {
        return false;
      }
    }), true);

    const removed = run(home, ["uninstall"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /proxy\s+stopped pid \d+/);
    assert.equal(await waitFor(async () => {
      try {
        await fetch("http://127.0.0.1:18803/_blackout/health", { signal: AbortSignal.timeout(200) });
        return false;
      } catch {
        return true;
      }
    }), true);
  } finally {
    stopProxy(home);
  }
});

test("uninstall stops the proxy, not the process a stale pid file names", { skip: process.platform !== "linux" }, async () => {
  const port = 18804;
  const { home } = await setup(port);
  let bystander;
  try {
    const serving = runAsync(home, ["serve", "--foreground", "--port", String(port)]);
    assert.equal(await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/_blackout/health`, { signal: AbortSignal.timeout(200) })).ok;
      } catch {
        return false;
      }
    }), true, "the proxy never came up");

    // A pid file that survived a reboot can name anything. This one names a
    // reader of the tool's own log - a command line that contains "blackout"
    // and would have been killed by a substring test.
    const log = join(home, ".local", "state", "blackout", "blackout.log");
    writeFileSync(log, "log\n");
    bystander = spawn("tail", ["-f", log], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(join(home, ".local", "state", "blackout", "blackout.pid"), `${bystander.pid}\n`);

    const removed = run(home, ["uninstall"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.ok(!removed.stdout.includes(`stopped pid ${bystander.pid}`), removed.stdout);
    assert.match(removed.stdout, /stopped pid \d+ \(ignored a stale pid/);
    assert.equal(bystander.exitCode, null, "the bystander must still be running");
    assert.equal(bystander.signalCode, null, `the bystander was killed by ${bystander.signalCode}`);

    assert.equal(await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/_blackout/health`, { signal: AbortSignal.timeout(200) });
        return false;
      } catch {
        return true;
      }
    }), true, "the proxy it started is still answering");
    await withTimeout(serving.exited, 5_000, serving.child);
  } finally {
    if (bystander && bystander.exitCode === null && bystander.signalCode === null) bystander.kill("SIGKILL");
    stopProxy(home);
  }
});

test("uninstall refuses to purge while a proxy it cannot prove is still serving", { skip: process.platform !== "linux" }, async () => {
  const port = 18806;
  const { home } = await setup(port);
  // Answers the health path, so it looks running, but it is not the proxy: no
  // pid file names it and it is not a blackout process. It runs in a child
  // because `run` blocks this event loop, and a server here could not answer.
  const blocker = spawn(process.execPath, ["-e", `require("node:http").createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); }).listen(${port}, "127.0.0.1")`], { stdio: "ignore" });
  try {
    assert.equal(await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/_blackout/health`, { signal: AbortSignal.timeout(200) })).ok;
      } catch {
        return false;
      }
    }), true, "the stand-in listener never came up");
    mkdirSync(join(home, ".local", "state", "blackout"), { recursive: true });
    writeFileSync(join(home, ".local", "state", "blackout", "journal.jsonl"), "{\n");

    const result = run(home, ["uninstall", "--purge"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not started by blackout/);
    assert.match(result.stdout, /data\s+kept:/);
    assert.ok(existsSync(join(home, ".local", "state", "blackout", "journal.jsonl")), "nothing was deleted under a live listener");
  } finally {
    if (blocker.exitCode === null && blocker.signalCode === null) blocker.kill("SIGKILL");
  }
});

test("uninstall finishes the rest when the launcher is not ours", async () => {
  const { home, app } = await setup(18810);
  const wrapper = join(home, ".local", "bin", "adcode");
  const installed = run(home, ["install", "--app", app, "--desktop"]);
  assert.equal(installed.status, 0, installed.stderr);
  // The user replaced our launcher with their own. Uninstall must not delete
  // it, and must not stop before the steps that have nothing to do with it.
  writeFileSync(wrapper, "#!/bin/sh\n# mine\nexit 0\n");

  const removed = run(home, ["uninstall"]);
  assert.equal(removed.status, 1, "a refusal is worth reporting");
  assert.match(removed.stderr, /refusing to remove/);
  assert.match(removed.stdout, /launcher\s+left in place/);
  assert.match(removed.stdout, /proxy\s+not running/, "the summary still prints");
  assert.equal(readFileSync(wrapper, "utf8"), "#!/bin/sh\n# mine\nexit 0\n");
  assert.ok(!existsSync(join(home, ".config", "blackout", "appimage")), "the AppImage record is still forgotten");
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

test("a second proxy cannot share the state directory", async () => {
  const port = 18818;
  const { home } = await setup(port);
  const started = run(home, ["serve", "--detach"]);
  assert.equal(started.status, 0, started.stderr);
  try {
    assert.equal(await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/_blackout/health`)).ok;
      } catch {
        return false;
      }
    }), true);

    // Both processes used to append to one journal, each with its own chain, and
    // `verify` reported a break at the first interleaved entry - caused by the
    // tool, not by tampering. The second start is now refused.
    const second = run(home, ["serve", "--detach", "--port", String(port + 1)]);
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.match(second.stderr, /another proxy is writing/);
    assert.match(second.stderr, new RegExp(String(port)));

    for (let index = 0; index < 5; index += 1) {
      await fetch(`http://127.0.0.1:${port}/v1/serve`, { method: "POST", body: "{}" });
    }
    const verify = run(home, ["verify"]);
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);

    // Starting the proxy that is already answering stays a no-op, not an error.
    const again = run(home, ["serve", "--detach"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already running/);
  } finally {
    stopProxy(home);
  }
});

test("SIGHUP reloads a user rule pack and keeps the old one on a bad edit", async () => {
  const { home } = await setup(18814);
  const started = run(home, ["serve", "--detach"]);
  assert.equal(started.status, 0, started.stderr);
  try {
    assert.equal(await waitFor(async () => {
      try {
        return (await fetch("http://127.0.0.1:18814/_blackout/health")).ok;
      } catch {
        return false;
      }
    }), true);

    const before = await fetch("http://127.0.0.1:18814/v1/extra", { method: "POST", body: "{}" });
    assert.equal(before.status, 502, "with the core pack this path goes upstream, which is unreachable here");

    const rulesDir = join(home, ".config", "blackout", "rules");
    mkdirSync(rulesDir, { recursive: true });
    const pack = join(rulesDir, "core.json");
    writeFileSync(pack, JSON.stringify({
      name: "core",
      version: 2,
      rules: [{ id: "extra", match: { method: "POST", path: "/v1/extra" }, action: "block" }],
    }));

    const pid = Number(readFileSync(join(home, ".local", "state", "blackout", "blackout.pid"), "utf8").trim());
    process.kill(pid, "SIGHUP");
    assert.equal(await waitFor(async () => {
      const response = await fetch("http://127.0.0.1:18814/v1/extra", { method: "POST", body: "{}" });
      return response.status === 403;
    }), true, "the reloaded pack should block the new path");

    writeFileSync(pack, "{ broken");
    process.kill(pid, "SIGHUP");
    assert.equal(await waitFor(() => {
      return readFileSync(join(home, ".local", "state", "blackout", "journal.jsonl"), "utf8").includes("rules-rejected");
    }), true, "a rejected reload should be journaled");
    const after = await fetch("http://127.0.0.1:18814/v1/extra", { method: "POST", body: "{}" });
    assert.equal(after.status, 403, "the old pack must still be active after a rejected reload");
  } finally {
    stopProxy(home);
  }
});

test("a broken core override falls back to the bundled pack at startup", async () => {
  const { home } = await setup(18815);
  const rulesDir = join(home, ".config", "blackout", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "core.json"), "{ this will not parse");

  const started = run(home, ["serve", "--detach"]);
  assert.equal(started.status, 0, started.stderr);
  try {
    assert.equal(await waitFor(async () => {
      try {
        return (await fetch("http://127.0.0.1:18815/_blackout/health")).ok;
      } catch {
        return false;
      }
    }), true);
    const serve = await fetch("http://127.0.0.1:18815/v1/serve", { method: "POST", body: "{}" });
    assert.equal(serve.status, 200);
    assert.deepEqual(await serve.json(), { creatives: [] });

    const journal = readFileSync(join(home, ".local", "state", "blackout", "journal.jsonl"), "utf8");
    assert.match(journal, /rules-rejected/);
    assert.match(journal, /fallback/);
  } finally {
    stopProxy(home);
  }
});

test("doctor fails when the active rule pack cannot load", async () => {
  const { home } = await setup(18816);
  const rulesDir = join(home, ".config", "blackout", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "core.json"), "{ broken");

  const result = run(home, ["doctor", "--json"]);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "rules").state, "fail");
  assert.match(report.checks.find((check) => check.name === "rules").detail, /core\.json/);
});

test("a custom pack with no fallback refuses to start", async () => {
  const { home } = await setup(18817);
  const configPath = join(home, ".config", "blackout", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.rules = "missing";
  writeFileSync(configPath, JSON.stringify(config));
  const result = run(home, ["serve", "--detach"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing\.json/);
});

test("config shows the effective policy", async () => {
  const { home } = await setup(18810);
  const result = run(home, ["config"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /listen\s+127\.0\.0\.1:18810/);
  assert.match(result.stdout, /dashboard\s+on/);
  assert.match(result.stdout, /rules\s+core/);
});

test("config writes only after validation, and persists", async () => {
  const { home } = await setup(18811);
  const changed = run(home, ["config", "--port", "18812", "--dashboard", "off", "--rules", "core"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /listen\s+127\.0\.0\.1:18812/);
  assert.match(changed.stdout, /dashboard\s+off/);

  const file = join(home, ".config", "blackout", "config.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.port, 18812);
  assert.equal(saved.dashboard, false);
  assert.equal(saved.upstream, "http://127.0.0.1:9");

  const shown = run(home, ["config", "--show"]);
  assert.match(shown.stdout, /127\.0\.0\.1:18812/);
});

test("config refuses an invalid value and leaves the file alone", async () => {
  const { home } = await setup(18813);
  const before = readFileSync(join(home, ".config", "blackout", "config.json"), "utf8");
  for (const args of [["--port", "70000"], ["--upstream", "not a url"], ["--dashboard", "maybe"]]) {
    const result = run(home, ["config", ...args]);
    assert.ok([1, 2].includes(result.status), `expected failure for ${args.join(" ")}`);
    assert.match(result.stderr, /blackout:/);
  }
  assert.equal(readFileSync(join(home, ".config", "blackout", "config.json"), "utf8"), before);
});

test("doctor reports an unreadable journal instead of dying on it", async () => {
  const { home } = await setup(18809);
  const journal = join(home, ".local", "state", "blackout", "journal.jsonl");
  mkdirSync(join(home, ".local", "state", "blackout"), { recursive: true });
  // Unparseable in the middle, where the truncated-tail tolerance does not
  // apply: the read throws, and doctor used to print only that. A bad *last*
  // line would be dropped as a torn write instead, which is why there is a
  // third line after it.
  const line = (seq) => `${JSON.stringify({ seq, at: seq + 1, kind: "x", data: {}, prev: "0".repeat(64), hash: "x" })}\n`;
  writeFileSync(journal, `${line(0)}not json\n${line(2)}`);

  const result = run(home, ["doctor", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const parsed = JSON.parse(result.stdout);
  const journalCheck = parsed.checks.find((check) => check.name === "journal");
  assert.equal(journalCheck.state, "fail");
  assert.match(journalCheck.detail, /corrupt at line 2/);
  // The rest of the diagnosis is still there, which is the point.
  assert.ok(parsed.checks.some((check) => check.name === "node" && check.state === "ok"));
  assert.ok(parsed.checks.length >= 6, `${parsed.checks.length} checks`);
});

test("doctor --json is a stable object with one entry per check", async () => {
  const { home, app } = await setup(18806);
  const installed = run(home, ["install", "--app", app]);
  assert.equal(installed.status, 0, installed.stderr);

  const result = run(home, ["doctor", "--json"]);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.name, "adcode-blackout");
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.checks));
  const names = report.checks.map((check) => check.name);
  assert.ok(names.includes("appimage"));
  assert.ok(names.includes("launcher"));
  const appimage = report.checks.find((check) => check.name === "appimage");
  assert.equal(appimage.state, "ok");
  assert.match(appimage.detail, /^(.*\(recorded\)|.*\(explicit\))$/);
  for (const check of report.checks) assert.match(check.state, /^(ok|warn|fail)$/);
});

test("doctor --json fails the process when a check fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "blackout-cli-empty-"));
  homes.push(home);
  const result = run(home, ["doctor", "--json"]);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "appimage").state, "fail");
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
  homes.push(home);
  const result = run(home, ["launch"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no ADCode AppImage found/);
});

test("compat refuses an unusable --app instead of judging another build", async () => {
  const { home } = await setup(18794);
  const tiny = join(home, "Applications", "ADCode-tiny.AppImage");
  writeFileSync(tiny, "not really");

  const result = run(home, ["compat", "--app", tiny]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /is not a usable AppImage/);
  assert.ok(result.stderr.includes(tiny), result.stderr);
});

test("compat refuses a window outside its bounds before launching anything", async () => {
  const { home, app } = await setup(18795);

  const result = run(home, ["compat", "--app", app, "--seconds", "0"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /between 1 and 3600/);
});

test("a broken config names the file and refuses to serve", async () => {
  const { home } = await setup(18796);
  writeFileSync(join(home, ".config", "blackout", "config.json"), "{not json");

  const status = run(home, ["status"]);
  assert.equal(status.status, 1);
  assert.match(status.stderr, /config\.json/);

  // Refusing is the whole behaviour: nothing may start on the port.
  const serve = run(home, ["serve", "--foreground", "--port", "18796"]);
  assert.equal(serve.status, 1);
  assert.match(serve.stderr, /config\.json/);
  assert.equal(await portFree(18796), true);
});

test("report falls back to the journal on disk when nothing is listening", async () => {
  const { home } = await setup(18799);
  const result = run(home, ["report"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ads stopped\s+0/);
  assert.match(result.stdout, /proxy not running; this report is from the journal on disk/);
  assert.doesNotMatch(result.stderr, /fetch failed/);
});

test("events names the address when nothing is listening", async () => {
  const { home } = await setup(18797);
  const result = run(home, ["events", "--once"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /proxy is not running at http:\/\/127\.0\.0\.1:18797/);
  assert.doesNotMatch(result.stderr, /fetch failed/);
});
