/**
 * One entry point, because a tool that needs four is a tool people stop using.
 *
 * Commands are deliberately small: `serve` owns the process, `launch` owns the
 * desktop, `install` owns the integration, and everything else reads state that
 * already exists. No command reaches into ADCode's files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { createProxy } from "./proxy.js";
import { createJournal, readJournalChain, verifyChain } from "./journal.js";
import { loadPolicy, parsePolicy, savePolicy, ensureHome, journalPath, logPath, pidPath, policyPath, stateHome, configHome } from "./policy.js";
import { bundledRulePath, loadRulePack } from "./rules.js";
import { buildReport, formatReport } from "./report.js";
import { VERSION } from "./version.js";
import { probe, proxyUrl, ensureProxy, launchApp, writePid, removePid } from "./launch.js";
import { formatCompat, runCompat } from "./compat.js";
import { describePid, isBlackoutPid, listenerPid } from "./netinfo.js";
import {
  installWrapper,
  removeWrapper,
  resolveAppImage,
  recordAppImage,
  patchDesktopEntries,
  restoreDesktopEntries,
  installUnit,
  removeUnit,
  forgetAppImage,
  appImageRecordPath,
  unitPath,
  unitEnabled,
  wrapperPath,
} from "./desktop.js";

const CLI = new URL("../bin/blackout.js", import.meta.url).pathname;

const USAGE = `blackout ${VERSION} - point ADCode at a proxy that answers no ads

  blackout install [--app PATH] [--desktop] [--autostart]
      Find the AppImage, record it, install the \`adcode\` launcher.
      --desktop    also repoint matching .desktop entries at the launcher
      --autostart  also install and enable a systemd user unit

  blackout launch [--app PATH] [--dry-run] [-- ARGS...]
      Start the proxy if needed, then start ADCode with ADCODE_AD_SERVER set.
      --dry-run    print the resolved AppImage, URL and argv; start nothing

  blackout compat [--app PATH] [--seconds N] [--json] [--keep] [-- ARGS...]
      Launch a build against a private proxy and judge whether it still calls
      /v1/serve, and whether anything ad-like slips past the pack. ARGS go to
      the app, e.g. -- --no-sandbox in a container. Exit 0 pass, 1
      inconclusive, 2 fail.

  blackout serve [--port N] [--foreground|--detach]
      Run the proxy. Foreground by default.

  blackout config [--show] [--port N] [--upstream URL] [--dashboard on|off] [--rules NAME]
  blackout rules [--json]
  blackout status [--json] | report [--json] | verify
  blackout doctor [--json]
  blackout events [--json] [--once]
  blackout --version | version
  blackout pause | resume
  blackout doctor
  blackout uninstall [--keep-wrapper] [--purge]

The AppImage is resolved on every run: explicit path, then the recorded one,
then the newest ADCode*.AppImage in ~/Applications, ~/AppImages, ~/Downloads or
~/.local/bin. An update that renames the file is picked up without reinstalling.
`;

function fail(message, code = 1) {
  console.error(`blackout: ${message}`);
  return code;
}

/**
 * The same failure for every command that needs an AppImage.
 *
 * A path the user named gets named back when it is unusable; the generic
 * message is only for "nothing was found anywhere".
 */
function noAppImage(resolved) {
  if (resolved.rejected) {
    return fail(`${resolved.rejected} is not a usable AppImage: missing, not a file, or smaller than 1 MiB.`, 2);
  }
  return fail("no ADCode AppImage found. Pass --app /path/to/ADCode.AppImage, or set ADCODE_APPIMAGE.", 2);
}

function readPolicy() {
  try {
    return loadPolicy();
  } catch (error) {
    throw new Error(`cannot read the policy file: ${String(error?.message ?? error)}`);
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(3_000) });
  const text = await response.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, ok: response.ok, body };
}

function journalOrEmpty() {
  const path = journalPath();
  return existsSync(path) ? readJournalChain(path) : [];
}

async function commandServe(values) {
  const base = readPolicy();
  const policy = parsePolicy({ ...base, ...(values.port === undefined ? {} : { port: Number(values.port) }) });
  ensureHome();

  const journal = createJournal(journalPath());
  let rules;
  try {
    rules = loadRulePack(policy.rules);
  } catch (error) {
    // The user override is broken. For `core` there is a known-good pack to
    // fall back to, and blocking is the whole point - so a typo must not turn
    // the blocker off at startup. A custom pack has no such fallback and is a
    // configuration error worth stopping for.
    if (policy.rules !== "core") throw error;
    rules = loadRulePack("core", bundledRulePath("core"));
    journal.append("rules-rejected", {
      name: "core",
      reason: String(error.message ?? error),
      fallback: bundledRulePath("core"),
    });
    console.error(`blackout: ${String(error.message ?? error)}`);
    console.error("blackout: using the bundled core pack; fix the override and send SIGHUP");
  }
  const proxy = createProxy({ policy, journal, rules });

  if (values.detach) {
    const child = await import("node:child_process").then(({ spawn }) =>
      spawn(process.execPath, [CLI, "serve", "--foreground", "--port", String(policy.port)], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      }),
    );
    child.unref();
    let health = null;
    for (let attempt = 0; attempt < 40 && health === null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      health = await probe(proxyUrl(policy));
    }
    if (health === null) return fail(`proxy did not come up; see ${logPath()} and try --foreground`);
    console.log(`blackout ${VERSION} running at ${proxyUrl(policy)} (pid ${child.pid})`);
    return 0;
  }

  try {
    await proxy.listen(policy.port, policy.host);
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      const health = await probe(proxyUrl(policy));
      if (health !== null) {
        console.log(`blackout already running at ${proxyUrl(policy)}`);
        return 0;
      }
      return fail(`${policy.host}:${policy.port} is in use by another process`);
    }
    throw error;
  }

  writePid(process.pid);
  const stop = async () => {
    removePid();
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // SIGHUP is a reload, not a stop: an operator adding a rule should not have
  // to drop the proxy (and every in-flight AI response) to apply it.
  process.on("SIGHUP", () => {
    try {
      const next = loadRulePack(policy.rules);
      proxy.setRules(next);
      journal.append("rules-reloaded", { name: next.name, version: next.version, rules: next.rules.length, source: next.source });
      console.log(`rules reloaded: ${next.name} v${next.version}, ${next.rules.length} rules from ${next.source}`);
    } catch (error) {
      // Keep serving the old pack. A typo must not turn the blocker off.
      journal.append("rules-rejected", { name: policy.rules, reason: String(error.message ?? error) });
      console.error(`rules not reloaded: ${String(error.message ?? error)}`);
    }
  });

  console.log(`blackout ${VERSION} at ${proxyUrl(policy)} -> ${policy.upstream}`);
  console.log(`rules ${policy.rules}, journal ${journalPath()}`);
  if (policy.dashboard) console.log(`dashboard ${proxyUrl(policy)}/_blackout/dashboard`);
  return new Promise(() => undefined);
}

async function commandLaunch(values, rest) {
  const policy = readPolicy();
  const resolved = resolveAppImage({ explicit: values.app ?? null });
  if (!resolved.found) return noAppImage(resolved);

  if (values["dry-run"]) {
    const url = proxyUrl(policy);
    const health = await probe(url);
    console.log(`appimage   ${resolved.path}`);
    console.log(`resolved   ${resolved.reason}`);
    console.log(`proxy      ${url} (${health === null ? "not running; would start it" : "running"})`);
    console.log(`env        ADCODE_AD_SERVER=${url}`);
    console.log(`argv       ${[resolved.path, ...rest].join(" ")}`);
    return 0;
  }

  recordAppImage(resolved.path);

  const ready = await ensureProxy({ policy, cli: CLI });
  if (ready.health === null) {
    console.error("blackout: proxy is not answering; launching ADCode unprotected");
    console.error(`blackout: see ${logPath()} and run \`blackout doctor\``);
  } else {
    console.error(`blackout: ${resolved.path} -> ${ready.url}`);
  }

  const result = await launchApp({ appImage: resolved.path, args: rest, url: ready.url });
  if (result.error) return fail(`cannot start ${resolved.path}: ${result.error.message}`);
  return result.code ?? 0;
}

function systemctl(args) {
  try {
    execFileSync("systemctl", ["--user", ...args], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function commandInstall(values) {
  const policy = readPolicy();
  const resolved = resolveAppImage({ explicit: values.app ?? null });
  if (!resolved.found) return noAppImage(resolved);

  recordAppImage(resolved.path);
  const wrapper = installWrapper({ cli: CLI });
  console.log(`appimage   ${resolved.path} (${resolved.reason})`);
  console.log(`recorded   ${resolved.path}`);
  console.log(`launcher   ${wrapper}`);

  if (values.desktop) {
    const patched = patchDesktopEntries({ appImage: resolved.path });
    if (patched.length === 0) console.log("desktop    no matching entry; nothing to repoint");
    for (const one of patched) console.log(`desktop    ${one.file} (backup ${one.backup})`);
  }

  if (values.autostart) {
    const unit = installUnit({ cli: CLI, port: policy.port });
    const reloaded = systemctl(["daemon-reload"]);
    const enabled = systemctl(["enable", "--now", "adcode-blackout.service"]);
    console.log(`unit       ${unit}`);
    if (!reloaded || !enabled) {
      console.log("systemd    could not enable the unit here; the launcher still starts the proxy on demand");
    }
  }

  const pathDirs = (process.env["PATH"] ?? "").split(":");
  if (!pathDirs.includes(wrapperPath().replace(/\/adcode$/, ""))) {
    console.log("");
    console.log("~/.local/bin is not on PATH. Add it, then run `adcode` instead of the AppImage.");
  }
  console.log("");
  console.log("Run `blackout doctor` to check the integration.");
  return 0;
}

/**
 * Delete the files blackout created, and only those.
 *
 * Refuses a symlink outright: `~/.local/state/blackout/journal.jsonl` pointing at
 * something else is not a file this tool wrote, and following it would turn an
 * uninstall into an arbitrary delete. Directories are removed only when empty.
 */
function purgeData() {
  const files = [journalPath(), policyPath(), appImageRecordPath(), pidPath(), logPath()];
  for (const file of files) {
    if (!existsSync(file)) continue;
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`refusing to delete the symlink ${file}; remove it yourself`);
    }
  }
  let removed = 0;
  for (const file of files) {
    if (!existsSync(file)) continue;
    unlinkSync(file);
    removed++;
  }
  for (const dir of new Set([configHome(), stateHome()])) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty, which means it holds something we did not create.
    }
  }
  return removed;
}

async function stopOwnedProxy() {
  const policy = readPolicy();
  const url = proxyUrl(policy);
  if ((await probe(url)) === null) return "not running";

  let pid = null;
  try {
    pid = Number(readFileSync(pidPath(), "utf8").trim());
  } catch {
    pid = null;
  }
  if (!Number.isSafeInteger(pid) || pid <= 1 || !isBlackoutPid(pid)) {
    return `running at ${url}, but not started by blackout; stop it yourself`;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return `running at ${url}; pid ${pid} was already gone`;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await probe(url, { timeoutMs: 200 })) === null) return `stopped pid ${pid}`;
  }
  return `pid ${pid} did not stop; check ${describePid(pid)}`;
}

async function commandUninstall(values) {
  const proxy = await stopOwnedProxy();
  if (values.purge) purgeData();
  const removedUnit = removeUnit();
  if (removedUnit) {
    systemctl(["disable", "--now", "adcode-blackout.service"]);
    systemctl(["daemon-reload"]);
  }
  const restored = restoreDesktopEntries();
  const removedWrapper = values["keep-wrapper"] ? false : removeWrapper();
  forgetAppImage();
  console.log(`proxy      ${proxy}`);
  console.log(`unit       ${removedUnit ? "removed" : "not installed"}`);
  console.log(`desktop    ${restored.length === 0 ? "nothing to restore" : `restored ${restored.length}`}`);
  console.log(`launcher   ${removedWrapper ? "removed" : values["keep-wrapper"] ? "kept" : "not installed"}`);
  console.log(`data       ${values.purge ? "journal, config and state removed" : "journal and config kept; --purge removes them"}`);
  return 0;
}

function configLine(policy) {
  return [
    `file       ${policyPath()}`,
    `upstream   ${policy.upstream}`,
    `listen     ${policy.host}:${policy.port}`,
    `dashboard  ${policy.dashboard ? "on" : "off"}`,
    `rules      ${policy.rules}`,
  ].join("\n");
}

/**
 * Read or write the policy through the same validator startup uses.
 *
 * Writing a port does not move a running proxy; the command says so instead of
 * pretending the change is live. A half-written config is impossible because
 * \`parsePolicy\` runs before the file is touched.
 */
async function commandConfig(values) {
  const current = readPolicy();
  const changes = {};
  if (values.port !== undefined) changes.port = Number(values.port);
  if (values.upstream !== undefined) changes.upstream = values.upstream;
  if (values.rules !== undefined) changes.rules = values.rules;
  if (values.dashboard !== undefined) {
    if (!["on", "off", "true", "false"].includes(values.dashboard)) {
      return fail("--dashboard takes on or off", 2);
    }
    changes.dashboard = values.dashboard === "on" || values.dashboard === "true";
  }

  if (Object.keys(changes).length === 0) {
    console.log(configLine(current));
    return 0;
  }

  const next = savePolicy({ ...current, ...changes });
  console.log(configLine(next));
  if (next.port !== current.port) {
    const running = await probe(proxyUrl(current));
    if (running !== null) {
      console.log("");
      console.log(`a proxy is still listening on ${proxyUrl(current)}; restart it to move to ${proxyUrl(next)}`);
    }
  }
  return 0;
}

async function commandRules(values) {
  const policy = readPolicy();
  const pack = loadRulePack(policy.rules);
  if (values.json) {
    // The loaded pack is normalised: a pattern is a RegExp, which JSON would
    // render as {}. Emit the source instead of a lossy object.
    console.log(JSON.stringify({
      ...pack,
      rules: pack.rules.map((rule) => ({ ...rule, pattern: rule.pattern === null ? null : String(rule.pattern) })),
    }, null, 2));
    return 0;
  }
  console.log(`pack       ${pack.name} v${pack.version}`);
  console.log(`source     ${pack.source}`);
  console.log(`rules      ${pack.rules.length}`);
  for (const rule of pack.rules) {
    const match = rule.path ?? String(rule.pattern);
    console.log(`  ${rule.id.padEnd(16)} ${rule.method.padEnd(5)} ${rule.action.padEnd(14)} ${match}`);
  }
  return 0;
}

function eventLine(entry) {
  const time = new Date(entry.at).toISOString().slice(11, 19);
  const data = entry.data ?? {};
  const detail = data.path ?? data.reason ?? "";
  const rule = data.rule === undefined ? "" : ` rule=${data.rule}`;
  const count = data.count === undefined ? "" : ` count=${data.count}`;
  return `${time} ${String(entry.kind).padEnd(16)} ${detail}${rule}${count}`.trimEnd();
}

/**
 * Follow the decision stream.
 *
 * This talks to the proxy, not to the journal file, so it sees entries even
 * while another process holds the file and it shares the dashboard's transport.
 * `--once` exists because a human is not the only caller: a script that wants
 * "the next decision" should not need a timeout and a kill.
 */
async function commandEvents(values) {
  const policy = readPolicy();
  const url = `${proxyUrl(policy)}/_blackout/events`;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "text/event-stream" } });
    if (!response.ok || response.body === null) return fail(`proxy is not running at ${proxyUrl(policy)}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data === "") continue;
          let entry;
          try {
            entry = JSON.parse(data);
          } catch {
            continue;
          }
          console.log(values.json ? JSON.stringify(entry) : eventLine(entry));
          if (values.once) {
            controller.abort();
            return 0;
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function commandStatus(values) {
  const policy = readPolicy();
  const url = proxyUrl(policy);
  const health = await probe(url);
  if (health === null) {
    if (values.json) {
      console.log(JSON.stringify({ name: "adcode-blackout", version: VERSION, url, running: false }, null, 2));
    } else {
      console.log(`blackout ${VERSION}`);
      console.log(`state      not running (${url})`);
    }
    return 1;
  }
  const report = await request(`${url}/_blackout/report`);
  if (values.json) {
    const totals = report.ok ? report.body.totals : null;
    const integrity = report.ok ? report.body.integrity : null;
    console.log(JSON.stringify({
      name: "adcode-blackout",
      version: health.version,
      url,
      running: true,
      enabled: health.enabled,
      upstream: health.upstream,
      uptimeMs: health.uptimeMs,
      totals,
      integrity,
      journalWriteError: health.journalWriteError ?? null,
    }, null, 2));
    return 0;
  }
  console.log(`blackout ${health.version} at ${url}`);
  console.log(`state      ${health.enabled ? "blocking" : "paused"}`);
  console.log(`upstream   ${health.upstream}`);
  console.log(`uptime     ${Math.round(health.uptimeMs / 1000)}s`);
  if (report.ok) {
    console.log(`stopped    ${report.body.totals.servesBlocked} serves, ${report.body.totals.receiptsBlocked} receipts`);
    console.log(`chain      ${report.body.integrity.ok ? "ok" : `BROKEN at ${report.body.integrity.brokenAt}`}`);
  }
  // Blocking is the product, so this is a warning on a working proxy rather than
  // a failure: ads are still stopped, but the record is in memory only.
  if (health.journalWriteError != null) {
    console.log(`journal    NOT WRITABLE: ${health.journalWriteError.message}`);
  }
  return 0;
}

async function commandReport(values) {
  const policy = readPolicy();
  const live = await request(`${proxyUrl(policy)}/_blackout/report`);
  const report = live.ok ? live.body : buildReport(journalOrEmpty(), { policy, version: VERSION, enabled: policy.enabled });
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.integrity.ok ? 0 : 1;
  }
  console.log(formatReport(report));
  if (!live.ok) console.log("\n(proxy not running; this report is from the journal on disk)");
  return report.integrity.ok ? 0 : 1;
}

function commandVerify() {
  const entries = journalOrEmpty();
  const result = verifyChain(entries);
  if (entries.length === 0) {
    console.log(`journal ${journalPath()} is empty`);
    return 0;
  }
  if (result.ok) {
    console.log(`ok: ${entries.length} entries, head ${entries[entries.length - 1].hash}`);
    return 0;
  }
  console.error(`BROKEN at entry ${result.brokenAt} of ${entries.length}`);
  return 1;
}

async function commandCompat(values, rest = []) {
  const policy = readPolicy();
  const resolved = resolveAppImage({ explicit: values.app ?? null });
  if (!resolved.found) return noAppImage(resolved);
  const seconds = values.seconds === undefined ? 60 : Number(values.seconds);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3_600) {
    return fail("--seconds must be an integer between 1 and 3600", 2);
  }

  let rules;
  try {
    rules = loadRulePack(policy.rules);
  } catch (error) {
    return fail(`cannot load the ${policy.rules} rule pack: ${String(error.message ?? error)}`);
  }

  // The window is the point: a build that never asks for an ad proves nothing in
  // five seconds, so say what is happening and that it ends on its own.
  console.error(`blackout: starting ${resolved.path} against a private proxy for ${seconds}s`);
  console.error("blackout: open a file and keep the editor focused until the window closes");

  const result = await runCompat({ appImage: resolved.path, args: rest, seconds, policy, rules, keep: values.keep === true });

  if (values.json) console.log(JSON.stringify({ ...result, appImage: resolved.path }, null, 2));
  else console.log(formatCompat({ ...result, appImage: resolved.path }));

  return result.verdict === "pass" ? 0 : result.verdict === "inconclusive" ? 1 : 2;
}

async function commandControl(action) {
  const policy = readPolicy();
  const result = await request(`${proxyUrl(policy)}/_blackout/${action}`, {
    method: "POST",
    headers: { "x-blackout-control": "cli" },
  }).catch(() => null);
  if (result === null || !result.ok) return fail(`proxy is not running at ${proxyUrl(policy)}`);
  console.log(`state      ${result.body.enabled ? "blocking" : "paused"}`);
  return 0;
}

async function commandDoctor(values = {}) {
  const checks = [];
  const add = (state, name, detail) => checks.push({ state, name, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? "ok" : "fail", "node", `${process.versions.node} (needs >= 20)`);

  let policy;
  try {
    policy = readPolicy();
    add("ok", "config", `upstream ${policy.upstream}`);
  } catch (error) {
    add("fail", "config", String(error.message ?? error));
  }

  const resolved = resolveAppImage();
  add(
    resolved.found ? "ok" : "fail",
    "appimage",
    resolved.found ? `${resolved.path} (${resolved.reason})` : "none found; pass --app to install",
  );

  const wrapper = wrapperPath();
  if (!existsSync(wrapper)) {
    add("warn", "launcher", "not installed; run `blackout install`");
  } else if (!readFileSync(wrapper, "utf8").includes("# adcode-blackout launcher")) {
    add("warn", "launcher", `${wrapper} exists but is not ours`);
  } else {
    // A moved checkout leaves a wrapper that still runs an older copy. That is
    // not broken enough to fail doctor - it still blocks - but it is not this
    // code, and only the user can decide to reinstall.
    const target = /'([^']*)' launch -- "\$@"/.exec(readFileSync(wrapper, "utf8"))?.[1] ?? null;
    if (target !== null && target !== CLI) {
      add("warn", "launcher", `${wrapper} points at ${target}; run \`blackout install\` again`);
    } else {
      add("ok", "launcher", wrapper);
    }
  }

  if (policy !== undefined) {
    const health = await probe(proxyUrl(policy));
    if (health !== null) {
      add("ok", "proxy", `running, ${health.enabled ? "blocking" : "paused"}`);
      if (health.journalWriteError != null) {
        add("warn", "journal-write", `${health.journalWriteError.message}; decisions are in memory only`);
      }
    } else {
      const owner = listenerPid(policy.port);
      if (owner === null) {
        add("warn", "proxy", `not running at ${proxyUrl(policy)}`);
      } else {
        add("fail", "proxy", `${proxyUrl(policy)} is held by ${describePid(owner)}`);
      }
    }
  }

  if (policy !== undefined) {
    try {
      const pack = loadRulePack(policy.rules);
      add("ok", "rules", `${pack.name} v${pack.version}, ${pack.rules.length} rules from ${pack.source}`);
    } catch (error) {
      add("fail", "rules", String(error.message ?? error));
    }
  }

  add(existsSync(unitPath()) ? "ok" : "warn", "systemd", existsSync(unitPath()) ? `${unitPath()}${unitEnabled() ? ", enabled" : ", not enabled"}` : "no user unit; the launcher starts the proxy on demand");

  const entries = journalOrEmpty();
  const chain = verifyChain(entries);
  add(chain.ok ? "ok" : "fail", "journal", chain.ok ? `${entries.length} entries verified` : `BROKEN at ${chain.brokenAt}`);

  if (policy !== undefined) {
    try {
      const response = await fetch(`${policy.upstream}/v1/health`, { signal: AbortSignal.timeout(3_000) });
      add(response.ok ? "ok" : "warn", "upstream", `${policy.upstream}/v1/health -> ${response.status}`);
    } catch {
      add("warn", "upstream", `${policy.upstream} is unreachable; pass-through features need it`);
    }
  }

  const ok = !checks.some((check) => check.state === "fail");
  if (values.json) {
    console.log(JSON.stringify({ name: "adcode-blackout", version: VERSION, ok, checks }, null, 2));
    return ok ? 0 : 1;
  }
  for (const check of checks) {
    const mark = check.state === "ok" ? "ok  " : check.state === "warn" ? "warn" : "FAIL";
    console.log(`${mark} ${check.name.padEnd(9)} ${check.detail}`);
  }
  return ok ? 0 : 1;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--version" || command === "version") {
    console.log(VERSION);
    return 0;
  }

  const dash = rest.indexOf("--");
  const args = dash === -1 ? rest : rest.slice(0, dash);
  const passthrough = dash === -1 ? [] : rest.slice(dash + 1);

  try {
    switch (command) {
      case "serve": {
        const { values } = parseArgs({
          args,
          options: {
            port: { type: "string" },
            foreground: { type: "boolean" },
            detach: { type: "boolean" },
          },
        });
        return await commandServe(values);
      }
      case "launch": {
        const { values } = parseArgs({ args, options: { app: { type: "string" }, "dry-run": { type: "boolean" } } });
        return await commandLaunch(values, passthrough);
      }
      case "install": {
        const { values } = parseArgs({
          args,
          options: {
            app: { type: "string" },
            desktop: { type: "boolean" },
            autostart: { type: "boolean" },
          },
        });
        return await commandInstall(values);
      }
      case "uninstall": {
        const { values } = parseArgs({
          args,
          options: { "keep-wrapper": { type: "boolean" }, purge: { type: "boolean" } },
        });
        return await commandUninstall(values);
      }
      case "events": {
        const { values } = parseArgs({ args, options: { json: { type: "boolean" }, once: { type: "boolean" } } });
        return await commandEvents(values);
      }
      case "config": {
        const { values } = parseArgs({
          args,
          options: {
            show: { type: "boolean" },
            port: { type: "string" },
            upstream: { type: "string" },
            dashboard: { type: "string" },
            rules: { type: "string" },
          },
        });
        return await commandConfig(values);
      }
      case "rules": {
        const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
        return await commandRules(values);
      }
      case "status": {
        const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
        return await commandStatus(values);
      }
      case "report": {
        const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
        return await commandReport(values);
      }
      case "compat": {
        const { values } = parseArgs({
          args,
          options: {
            app: { type: "string" },
            seconds: { type: "string" },
            json: { type: "boolean" },
            keep: { type: "boolean" },
          },
        });
        return await commandCompat(values, passthrough);
      }
      case "verify":
        return commandVerify();
      case "pause":
      case "resume":
        return await commandControl(command);
      case "doctor": {
        const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
        return await commandDoctor(values);
      }
      default:
        return fail(`unknown command ${command}\n\n${USAGE}`, 2);
    }
  } catch (error) {
    if (error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return fail(error.message, 2);
    return fail(String(error?.message ?? error));
  }
}
