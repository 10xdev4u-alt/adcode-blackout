/**
 * One entry point, because a tool that needs four is a tool people stop using.
 *
 * Commands are deliberately small: `serve` owns the process, `launch` owns the
 * desktop, `install` owns the integration, and everything else reads state that
 * already exists. No command reaches into ADCode's files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createProxy } from "./proxy.js";
import { createJournal, readJournal, verifyChain } from "./journal.js";
import { loadPolicy, parsePolicy, ensureHome, journalPath, logPath, stateHome } from "./policy.js";
import { loadRulePack } from "./rules.js";
import { buildReport, formatReport } from "./report.js";
import { VERSION } from "./version.js";
import { probe, proxyUrl, ensureProxy, launchApp, writePid, removePid } from "./launch.js";
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

  blackout launch [--app PATH] [-- ARGS...]
      Start the proxy if needed, then start ADCode with ADCODE_AD_SERVER set.

  blackout serve [--port N] [--foreground|--detach]
      Run the proxy. Foreground by default.

  blackout status | report [--json] | verify
  blackout pause | resume
  blackout doctor
  blackout uninstall [--keep-wrapper]

The AppImage is resolved on every run: explicit path, then the recorded one,
then the newest ADCode*.AppImage in ~/Applications, ~/AppImages, ~/Downloads or
~/.local/bin. An update that renames the file is picked up without reinstalling.
`;

function fail(message, code = 1) {
  console.error(`blackout: ${message}`);
  return code;
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
  return existsSync(path) ? readJournal(path) : [];
}

async function commandServe(values) {
  const base = readPolicy();
  const policy = parsePolicy({ ...base, ...(values.port === undefined ? {} : { port: Number(values.port) }) });
  ensureHome();

  const journal = createJournal(journalPath());
  const rules = loadRulePack(policy.rules);
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
  process.on("SIGHUP", stop);

  console.log(`blackout ${VERSION} at ${proxyUrl(policy)} -> ${policy.upstream}`);
  console.log(`rules ${policy.rules}, journal ${journalPath()}`);
  if (policy.dashboard) console.log(`dashboard ${proxyUrl(policy)}/_blackout/dashboard`);
  return new Promise(() => undefined);
}

async function commandLaunch(values, rest) {
  const policy = readPolicy();
  const resolved = resolveAppImage({ explicit: values.app ?? null });
  if (!resolved.found) {
    return fail(
      "no ADCode AppImage found. Pass --app /path/to/ADCode.AppImage, or set ADCODE_APPIMAGE.",
      2,
    );
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
  if (!resolved.found) {
    return fail("no ADCode AppImage found. Pass --app /path/to/ADCode.AppImage.", 2);
  }

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

async function commandUninstall(values) {
  const removedUnit = removeUnit();
  if (removedUnit) {
    systemctl(["disable", "--now", "adcode-blackout.service"]);
    systemctl(["daemon-reload"]);
  }
  const restored = restoreDesktopEntries();
  const removedWrapper = values["keep-wrapper"] ? false : removeWrapper();
  forgetAppImage();
  console.log(`unit       ${removedUnit ? "removed" : "not installed"}`);
  console.log(`desktop    ${restored.length === 0 ? "nothing to restore" : `restored ${restored.length}`}`);
  console.log(`launcher   ${removedWrapper ? "removed" : values["keep-wrapper"] ? "kept" : "not installed"}`);
  console.log("data       journal and config kept; delete ~/.local/state/blackout to remove them");
  return 0;
}

async function commandStatus() {
  const policy = readPolicy();
  const url = proxyUrl(policy);
  const health = await probe(url);
  if (health === null) {
    console.log(`blackout ${VERSION}`);
    console.log(`state      not running (${url})`);
    return 1;
  }
  const report = await request(`${url}/_blackout/report`);
  console.log(`blackout ${health.version} at ${url}`);
  console.log(`state      ${health.enabled ? "blocking" : "paused"}`);
  console.log(`upstream   ${health.upstream}`);
  console.log(`uptime     ${Math.round(health.uptimeMs / 1000)}s`);
  if (report.ok) {
    console.log(`stopped    ${report.body.totals.servesBlocked} serves, ${report.body.totals.receiptsBlocked} receipts`);
    console.log(`chain      ${report.body.integrity.ok ? "ok" : `BROKEN at ${report.body.integrity.brokenAt}`}`);
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

async function commandDoctor() {
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
  let wrapperOk = false;
  if (existsSync(wrapper)) {
    wrapperOk = readFileSync(wrapper, "utf8").includes("# adcode-blackout launcher");
    add(wrapperOk ? "ok" : "warn", "launcher", wrapperOk ? wrapper : `${wrapper} exists but is not ours`);
  } else {
    add("warn", "launcher", "not installed; run `blackout install`");
  }

  if (policy !== undefined) {
    const health = await probe(proxyUrl(policy));
    add(health === null ? "warn" : "ok", "proxy", health === null ? `not running at ${proxyUrl(policy)}` : `running, ${health.enabled ? "blocking" : "paused"}`);
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

  for (const check of checks) {
    const mark = check.state === "ok" ? "ok  " : check.state === "warn" ? "warn" : "FAIL";
    console.log(`${mark} ${check.name.padEnd(9)} ${check.detail}`);
  }
  return checks.some((check) => check.state === "fail") ? 1 : 0;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
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
        const { values } = parseArgs({ args, options: { app: { type: "string" } } });
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
        const { values } = parseArgs({ args, options: { "keep-wrapper": { type: "boolean" } } });
        return await commandUninstall(values);
      }
      case "status":
        return await commandStatus();
      case "report": {
        const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
        return await commandReport(values);
      }
      case "verify":
        return commandVerify();
      case "pause":
      case "resume":
        return await commandControl(command);
      case "doctor":
        return await commandDoctor();
      default:
        return fail(`unknown command ${command}\n\n${USAGE}`, 2);
    }
  } catch (error) {
    if (error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return fail(error.message, 2);
    return fail(String(error?.message ?? error));
  }
}
