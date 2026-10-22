import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProxy, launchApp, probe, proxyUrl } from "../src/launch.js";
import { parsePolicy } from "../src/policy.js";
import { createProxy } from "../src/proxy.js";
import { createJournal } from "../src/journal.js";
import { loadRulePack } from "../src/rules.js";

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("probe is null when nothing is listening", async () => {
  assert.equal(await probe("http://127.0.0.1:1"), null);
});

test("launchApp sets ADCODE_AD_SERVER and passes arguments through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blackout-launch-"));
  dirs.push(dir);
  const out = join(dir, "out");
  const app = join(dir, "fake.AppImage");
  writeFileSync(app, `#!/bin/sh\nprintf '%s\\n' "$ADCODE_AD_SERVER" > '${out}'\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${out}'; done\n`);
  chmodSync(app, 0o755);

  const result = await launchApp({ appImage: app, args: ["--flag", "value"], url: "http://127.0.0.1:8790" });
  assert.equal(result.code, 0);
  const lines = readFileSync(out, "utf8").trim().split("\n");
  assert.deepEqual(lines, ["http://127.0.0.1:8790", "--flag", "value"]);
});

test("launchApp reports a missing executable instead of throwing", async () => {
  const result = await launchApp({ appImage: "/nonexistent/ADCode.AppImage", url: "http://127.0.0.1:1" });
  assert.equal(result.code, 127);
  assert.ok(result.error instanceof Error);
});

test("ensureProxy reuses a running proxy and does not start a second", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blackout-reuse-"));
  dirs.push(dir);
  const policy = parsePolicy({ port: 0 });
  const proxy = createProxy({ policy, journal: createJournal(join(dir, "j.jsonl")), rules: loadRulePack("core") });
  await proxy.listen(0, "127.0.0.1");
  const running = proxyUrl({ host: "127.0.0.1", port: proxy.server.address().port });
  const ready = await ensureProxy({ policy: { ...policy, port: proxy.server.address().port }, cli: "/nonexistent" });
  assert.equal(ready.started, false);
  assert.equal(ready.url, running);
  assert.equal(ready.health.ok, true);
  await proxy.close();
});

test("ensureProxy survives a spawn failure and reports not ready", async () => {
  // `spawn` emits 'error' when it cannot start (EMFILE, EAGAIN). Unhandled, that
  // throws in the launcher and the editor never starts - the one outcome the
  // launcher exists to prevent.
  const dir = await mkdtemp(join(tmpdir(), "blackout-spawn-"));
  dirs.push(dir);
  const previous = process.env["BLACKOUT_STATE"];
  process.env["BLACKOUT_STATE"] = dir;
  try {
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => undefined;
    const spawnImpl = () => {
      setImmediate(() => child.emit("error", Object.assign(new Error("EMFILE"), { code: "EMFILE" })));
      return child;
    };
    const ready = await ensureProxy({
      policy: parsePolicy({ port: 1 }),
      cli: "/nonexistent",
      spawnImpl,
      fetchImpl: async () => { throw new Error("refused"); },
      readyTimeoutMs: 100,
    });
    assert.equal(ready.health, null);
    assert.equal(ready.reason, "not-ready");
  } finally {
    if (previous === undefined) delete process.env["BLACKOUT_STATE"];
    else process.env["BLACKOUT_STATE"] = previous;
  }
});

test("ensureProxy does not start anything when autoStart is false", async () => {
  const policy = parsePolicy({ port: 1 });
  const ready = await ensureProxy({ policy, cli: "/nonexistent", autoStart: false });
  assert.equal(ready.started, false);
  assert.equal(ready.health, null);
  assert.equal(ready.reason, "not-running");
});
