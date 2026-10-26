/**
 * The edges the happy path never reaches.
 *
 * Everything here is a refusal or a warning: a state directory someone else
 * owns, a port held by a process that is not the proxy, a journal that is empty
 * or tampered with, a launcher blackout did not write, a config it cannot read,
 * a port that moved under a running proxy. They are the commands a person runs
 * when something is already wrong, which is exactly when a wrong exit code or a
 * stack trace costs the most.
 *
 * Each runs the real CLI in a child process against a throwaway HOME, like
 * `cli.test.js`, and uses ports outside the range the other files claim so the
 * suite can keep running its files in parallel.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJournal } from "../src/journal.js";

const CLI = fileURLToPath(new URL("../bin/blackout.js", import.meta.url));
const homes = [];

after(() => {
  for (const home of homes) {
    stopProxy(home);
    rmSync(home, { recursive: true, force: true });
  }
});

const stateDir = (home) => join(home, ".local", "state", "blackout");
const journalFile = (home) => join(stateDir(home), "journal.jsonl");
const pidFile = (home) => join(stateDir(home), "blackout.pid");
const lockFile = (home) => join(stateDir(home), "blackout.lock");

function run(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      BLACKOUT_HOME: join(home, ".config", "blackout"),
      BLACKOUT_STATE: stateDir(home),
      ...extraEnv,
    },
  });
}

/**
 * Like `run`, but without blocking this process.
 *
 * `spawnSync` freezes the test's event loop for the child's whole lifetime, so
 * a server hosted *in this process* - the impostor below - cannot answer a
 * probe it is asked for. The CLI would then see a timeout and report whatever
 * it reports for silence, which is not the thing under test.
 */
function runAsync(home, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: home,
        BLACKOUT_HOME: join(home, ".config", "blackout"),
        BLACKOUT_STATE: stateDir(home),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolve({ status: code, stdout, stderr }));
  });
}

async function setup(port) {
  const home = await mkdtemp(join(tmpdir(), "blackout-edges-"));
  homes.push(home);
  mkdirSync(join(home, "Applications"), { recursive: true });
  mkdirSync(join(home, ".config", "blackout"), { recursive: true });
  writeFileSync(
    join(home, ".config", "blackout", "config.json"),
    `${JSON.stringify({ port, upstream: "http://127.0.0.1:9" }, null, 2)}\n`,
  );
  const app = join(home, "Applications", "ADCode-2.4.0.AppImage");
  writeFileSync(app, `#!/bin/sh\nexit 0\n${"#".repeat(1_200_000)}`);
  chmodSync(app, 0o755);
  return { home, app };
}

function stopProxy(home) {
  const file = pidFile(home);
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function waitFor(check, { timeoutMs = 8_000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

function health(port) {
  return async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/_blackout/health`)).ok;
    } catch {
      return false;
    }
  };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("nothing is a usage error rather than a crash", async () => {
  const { home } = await setup(18840);
  const result = run(home, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^blackout \d+\.\d+\.\d+ - /);
});

test("a foreground start is refused when another proxy owns the state directory", async () => {
  const port = 18841;
  const { home } = await setup(port);
  const started = run(home, ["serve", "--detach"]);
  assert.equal(started.status, 0, started.stderr);
  try {
    assert.equal(await waitFor(health(port)), true, "the first proxy answers");

    // The pre-flight in the parent names the holder. In the foreground there is
    // no parent, so this is the other refusal: the claim itself, taken after the
    // journal path is known but before anything is opened or written.
    const second = run(home, ["serve", "--foreground", "--port", String(port + 1)]);
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.match(second.stderr, /another proxy is writing/);
    assert.match(second.stderr, /pid \d+/);
    assert.match(second.stderr, new RegExp(`port ${port}\\b`));

    // A refused start must not have disturbed the journal it declined to share.
    const verify = run(home, ["verify"]);
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  } finally {
    stopProxy(home);
  }
});

test("a port held by something that is not the proxy is named, and the claim released", async () => {
  const port = 18842;
  const { home } = await setup(port);
  const foreign = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not the proxy");
  });
  await listen(foreign, port);
  try {
    const result = run(home, ["serve", "--foreground"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /is in use by another process/);
    // The claim is dropped on the way out: a start that never served must not
    // leave the directory looking occupied.
    assert.equal(existsSync(lockFile(home)), false);
  } finally {
    await close(foreign);
  }
});

test("uninstall reports a foreign process on the port instead of killing it", async () => {
  const port = 18843;
  const { home } = await setup(port);
  // Something answers the health route but is not this proxy, so ownership has
  // to come from the kernel and not from what the pid file claims.
  const impostor = createServer((req, res) => {
    if (req.url === "/_blackout/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.0.0", enabled: true, upstream: "http://127.0.0.1:9", uptimeMs: 1_000 }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no");
  });
  await listen(impostor, port);
  mkdirSync(stateDir(home), { recursive: true });
  try {
    // A pid file naming something that is not holding the port at all.
    writeFileSync(pidFile(home), "999999\n");
    const stale = await runAsync(home, ["uninstall"]);
    assert.match(stale.stdout, /^proxy {6}/m, stale.stdout + stale.stderr);
    assert.match(stale.stdout, /not a blackout proxy, so nothing was stopped|does not name the proxy/);
    // The important part: it is still there. Nothing was signalled.
    assert.equal((await fetch(`http://127.0.0.1:${port}/_blackout/health`)).ok, true);

    // And a pid file that names this test process: alive, holding the port, but
    // not the proxy, so the second attribution path refuses too.
    writeFileSync(pidFile(home), `${process.pid}\n`);
    const wrongPid = await runAsync(home, ["uninstall"]);
    assert.equal(wrongPid.status, 0, wrongPid.stdout + wrongPid.stderr);
    assert.match(wrongPid.stdout, /not a blackout proxy, so nothing was stopped|does not name the proxy/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/_blackout/health`)).ok, true);
  } finally {
    // The pid file named this process in its second scenario; the cleanup hook
    // signals what it names, so it has to go before the file is read again.
    rmSync(pidFile(home), { force: true });
    await close(impostor);
  }
});

test("a launch whose proxy cannot start still starts the editor", async () => {
  const port = 18860;
  const { home, app } = await setup(port);
  // Something answers on the port that is not the proxy, so the proxy cannot
  // bind and no amount of waiting produces a health answer. Invariant three:
  // an ad failure costs an ad, never an editor.
  const foreign = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not the proxy");
  });
  await listen(foreign, port);
  const started = join(home, "editor-started");
  // Padded past the AppImage size floor, or the launcher would refuse to treat
  // it as a build at all and the test would be measuring the wrong refusal.
  writeFileSync(app, `#!/bin/sh\ntouch "${started}"\n${"#".repeat(1_200_000)}`);
  chmodSync(app, 0o755);
  try {
    const launched = await runAsync(home, ["launch"]);
    assert.equal(launched.status, 0, launched.stdout + launched.stderr);
    assert.equal(existsSync(started), true, "the editor started anyway");
    assert.match(launched.stderr, /unprotected|did not start/);
    assert.match(launched.stderr, /doctor/);
  } finally {
    await close(foreign);
  }
});

test("a proxy that ignores SIGTERM is reported, not waited on forever", async () => {
  const port = 18861;
  const { home } = await setup(port);
  /*
   * The one case the kill path cannot decide on its own: the process is the
   * proxy by command line, holds the port, answers health, and refuses to die.
   * Uninstall must say so and finish; hanging on it would mean a user cannot
   * remove the thing that is in their way.
   */
  const script = [
    `require("node:http").createServer((q, s) => {`,
    `  if (q.url === "/_blackout/health") { s.writeHead(200, { "content-type": "application/json" });`,
    `    s.end(JSON.stringify({ ok: true, version: "0.0.0", enabled: true, upstream: "http://127.0.0.1:9", uptimeMs: 1 })); return; }`,
    `  s.writeHead(404); s.end();`,
    `}).listen(${port}, "127.0.0.1");`,
    `process.on("SIGTERM", () => {});`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
  // `serve` and a path ending in blackout.js are what `isBlackoutPid` looks for.
  const stubborn = spawn(process.execPath, ["-e", script, "serve", join(home, "blackout.js")], { stdio: "ignore" });
  mkdirSync(stateDir(home), { recursive: true });
  writeFileSync(pidFile(home), `${stubborn.pid}\n`);
  try {
    assert.equal(await waitFor(health(port)), true, "the stubborn process answers health");
    const uninstalled = await runAsync(home, ["uninstall"]);
    assert.equal(uninstalled.status, 0, uninstalled.stdout + uninstalled.stderr);
    assert.match(uninstalled.stdout, new RegExp(`pid ${stubborn.pid} did not stop`));
    assert.match(uninstalled.stdout, /check pid/);
  } finally {
    stubborn.kill("SIGKILL");
    await new Promise((resolve) => stubborn.once("exit", resolve));
    rmSync(pidFile(home), { force: true });
  }
});

test("install --autostart without systemd leaves the unit and says what still works", async () => {
  const { home } = await setup(18862);
  // A PATH with nothing in it is the state a container or a headless box is in:
  // systemctl exists nowhere, `daemon-reload` fails, and the install must still
  // be an install - the unit is written and the launcher starts the proxy.
  const emptyBin = join(home, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  const installed = run(home, ["install", "--autostart"], { PATH: emptyBin });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.match(installed.stdout, /^unit {7}/m);
  assert.match(installed.stdout, /systemd {4}could not enable the unit here; the launcher still starts the proxy on demand/);
  assert.equal(existsSync(join(home, ".config", "systemd", "user", "adcode-blackout.service")), true);

  // Uninstall with the same empty PATH must take it away again rather than leave
  // the unit behind, and must not read the missing systemctl as a failure.
  const uninstalled = run(home, ["uninstall"], { PATH: emptyBin });
  assert.equal(uninstalled.status, 0, uninstalled.stdout + uninstalled.stderr);
  assert.match(uninstalled.stdout, /^unit {7}removed$/m);
  assert.equal(existsSync(join(home, ".config", "systemd", "user", "adcode-blackout.service")), false);
});

test("uninstall --keep-wrapper leaves the launcher alone", async () => {
  const { home } = await setup(18863);
  const wrapper = join(home, ".local", "bin", "adcode");
  assert.equal(run(home, ["install"]).status, 0);
  assert.equal(existsSync(wrapper), true);

  // The other half of the launcher decision: a user who wants to keep their own
  // entry point after uninstalling gets to keep it, and is told they have.
  const kept = run(home, ["uninstall", "--keep-wrapper"]);
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /^launcher {3}kept$/m);
  assert.equal(existsSync(wrapper), true);
});

test("events prints the latest decision once, and follows until it is stopped", async () => {
  const port = 18864;
  const { home } = await setup(port);
  const started = run(home, ["serve", "--detach"]);
  assert.equal(started.status, 0, started.stderr);
  try {
    assert.equal(await waitFor(health(port)), true, "the proxy answers");
    const serve = () => fetch(`http://127.0.0.1:${port}/v1/serve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "events" }),
    });
    await serve();
    await serve();

    // `--once` is "the latest, or the next one", not the first of the replay.
    const once = run(home, ["events", "--once"]);
    assert.equal(once.status, 0, once.stdout + once.stderr);
    assert.match(once.stdout, /serve-blocked {4}\/v1\/serve rule=serve-v1/);
    const lines = once.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `one decision, not a replay: ${once.stdout}`);

    // The follower holds the stream open until it is told to stop, and stopping
    // it is an ordinary exit - a person pressing Ctrl-C is not a failure.
    const following = spawn(process.execPath, [CLI, "events"], {
      env: { ...process.env, HOME: home, BLACKOUT_HOME: join(home, ".config", "blackout"), BLACKOUT_STATE: stateDir(home) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    following.stdout.on("data", (chunk) => { stdout += chunk; });
    const exit = new Promise((resolve) => following.once("exit", (code) => resolve(code)));
    const appeared = await waitFor(() => stdout.includes("serve-blocked"), { timeoutMs: 5_000, stepMs: 25 });
    assert.equal(appeared, true, `the follower printed nothing: ${JSON.stringify(stdout)}`);
    following.kill("SIGINT");
    assert.equal(await exit, 0);
  } finally {
    stopProxy(home);
  }
});

test("the event follower survives the proxy going away, and stops when asked", async () => {
  const port = 18866;
  const { home } = await setup(port);
  assert.equal(run(home, ["serve", "--detach"]).status, 0);
  try {
    assert.equal(await waitFor(health(port)), true, "the proxy answers");
    const serve = () => fetch(`http://127.0.0.1:${port}/v1/serve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "follower" }),
    });
    await serve();

    const following = spawn(process.execPath, [CLI, "events"], {
      env: { ...process.env, HOME: home, BLACKOUT_HOME: join(home, ".config", "blackout"), BLACKOUT_STATE: stateDir(home) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    following.stdout.on("data", (chunk) => { stdout += chunk; });
    following.stderr.on("data", (chunk) => { stderr += chunk; });
    const exit = new Promise((resolve) => following.once("exit", (code) => resolve(code)));
    assert.equal(await waitFor(() => stdout.includes("serve-blocked"), { timeoutMs: 5_000, stepMs: 25 }), true, stdout);

    // A restart is ordinary on a desktop - an update, a crash, systemctl. The
    // follower used to end here with "terminated" and exit 1.
    stopProxy(home);
    assert.equal(await waitFor(() => /reconnecting|lost/.test(stderr), { timeoutMs: 5_000, stepMs: 25 }), true, stderr);
    assert.equal(run(home, ["serve", "--detach"]).status, 0);
    assert.equal(await waitFor(health(port)), true, "the proxy answers again");
    await serve();
    assert.equal(
      await waitFor(() => (stdout.match(/serve-blocked/g) ?? []).length >= 2, { timeoutMs: 12_000, stepMs: 50 }),
      true,
      `the follower did not reconnect: ${stdout} ${stderr}`,
    );

    // Ctrl-C on a follower is an exit, not a failure.
    following.kill("SIGINT");
    assert.equal(await exit, 0);
  } finally {
    stopProxy(home);
  }
});

test("compat runs a build against a private proxy and reports the verdict", async () => {
  const port = 18865;
  const { home, app } = await setup(port);
  // The stand-in ad server: a real one has to answer /v1/config, or the private
  // proxy degrades to the safe config and the run is judged on that instead.
  const upstream = createServer((req, res) => {
    if (req.url === "/v1/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ killSwitch: false, caps: { dailyCap: 40, minIntervalMs: 1_000 }, projections: { off: "0", light: "10", standard: "20", max: "30" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await listen(upstream, 0);
  writeFileSync(join(home, ".config", "blackout", "config.json"), `${JSON.stringify({ port, upstream: `http://127.0.0.1:${upstream.address().port}` }, null, 2)}\n`);
  writeFileSync(app, `#!/bin/sh\ncurl -s -X POST -d "{}" "$ADCODE_AD_SERVER/v1/serve" > /dev/null\ncurl -s "$ADCODE_AD_SERVER/v1/config" > /dev/null\nexec sleep 30\n${"#".repeat(1_200_000)}`);
  chmodSync(app, 0o755);
  try {
    // `runAsync`, not `run`: the stand-in upstream lives in this process, and
    // `spawnSync` would freeze the loop it answers from - the compat window
    // would then measure a captive upstream rather than the proxy.
    const passed = await runAsync(home, ["compat", "--app", app, "--seconds", "2"]);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /^compat pass/m);
    assert.match(passed.stdout, /ok {3}serve {4}1 blocked/);
    assert.match(passed.stdout, /ok {3}config {3}1 rewritten/);
    assert.match(passed.stderr, /private proxy for 2s/);

    const machine = await runAsync(home, ["compat", "--app", app, "--seconds", "2", "--json"]);
    assert.equal(machine.status, 0, machine.stdout + machine.stderr);
    const verdict = JSON.parse(machine.stdout);
    assert.equal(verdict.verdict, "pass");
    assert.equal(verdict.appImage, app);
    assert.equal(verdict.observed.serves, 1);
    assert.equal(verdict.observed.configs, 1);
  } finally {
    await close(upstream);
  }
});

test("verify calls an absent journal empty, an intact one ok, and a tampered one broken", async () => {
  const { home } = await setup(18844);
  const absent = run(home, ["verify"]);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /is empty/);

  mkdirSync(stateDir(home), { recursive: true });
  const journal = createJournal(journalFile(home));
  journal.append("serve-blocked", { path: "/v1/serve" });
  journal.append("serve-blocked", { path: "/v1/receipts" });

  const intact = run(home, ["verify"]);
  assert.equal(intact.status, 0, intact.stdout + intact.stderr);
  assert.match(intact.stdout, /ok: 2 entries/);

  // One edited decision, hashes left alone: the chain is what notices.
  const lines = readFileSync(journalFile(home), "utf8").trimEnd().split("\n");
  lines[0] = lines[0].replace('"/v1/serve"', '"/v1/extra"');
  assert.notEqual(lines[0].includes("/v1/extra"), false, "the edit landed");
  writeFileSync(journalFile(home), `${lines.join("\n")}\n`);

  const broken = run(home, ["verify"]);
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stderr, /BROKEN at entry 0 of 2/);
});

test("status says the proxy is not running, and says so for a script too", async () => {
  const { home } = await setup(18845);
  const text = run(home, ["status"]);
  assert.equal(text.status, 1, text.stdout + text.stderr);
  assert.match(text.stdout, /not running/);

  const json = run(home, ["status", "--json"]);
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).running, false);
});

test("doctor warns about a launcher it did not write, and fails on a config it cannot read", async () => {
  const { home } = await setup(18846);
  const wrapper = join(home, ".local", "bin", "adcode");
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, "#!/bin/sh\necho someone else's launcher\n");

  const notOurs = run(home, ["doctor"]);
  assert.equal(notOurs.status, 0, notOurs.stdout + notOurs.stderr);
  assert.match(notOurs.stdout, /warn launcher\s+.*exists but is not ours/);

  // A config that cannot be read is a finding to report, not an exception to
  // end the table with: the checks after it still run.
  writeFileSync(join(home, ".config", "blackout", "config.json"), "{ not json");
  const unreadable = run(home, ["doctor"]);
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stdout, /FAIL config\s+cannot read/);
  assert.match(unreadable.stdout, /(ok|warn|FAIL) systemd/);

  const asJson = run(home, ["doctor", "--json"]);
  const parsed = JSON.parse(asJson.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.checks.find((check) => check.name === "config").state, "fail");
});

test("moving the port says the running proxy has to restart", async () => {
  const port = 18847;
  const { home } = await setup(port);
  const started = run(home, ["serve", "--detach"]);
  assert.equal(started.status, 0, started.stderr);
  try {
    assert.equal(await waitFor(health(port)), true, "the proxy answers");

    const moved = run(home, ["config", "--port", String(port + 1)]);
    assert.equal(moved.status, 0, moved.stdout + moved.stderr);
    assert.match(moved.stdout, new RegExp(`listen +127\\.0\\.0\\.1:${port + 1}`));
    assert.match(moved.stdout, /a proxy is still listening on/);
    assert.match(moved.stdout, /restart it to move to/);
    // The running proxy is untouched: it is still the one answering.
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/_blackout/health`)).ok, true);
  } finally {
    stopProxy(home);
  }
});

test("a broken custom pack stops a detached start before it spawns anything", async () => {
  const { home } = await setup(18848);
  const rulesDir = join(home, ".config", "blackout", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "custom.json"), "{ broken");

  const set = run(home, ["config", "--rules", "custom"]);
  assert.equal(set.status, 0, set.stdout + set.stderr);
  assert.match(set.stdout, /rules {6}custom/);

  const served = run(home, ["serve", "--detach"]);
  assert.equal(served.status, 1, served.stdout + served.stderr);
  // The message names the file, not "the proxy did not come up".
  assert.match(served.stderr, /custom/);
  assert.equal(existsSync(pidFile(home)), false, "nothing was left running");
});
