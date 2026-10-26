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
