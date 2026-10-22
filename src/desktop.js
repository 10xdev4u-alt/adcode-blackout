/**
 * The part that makes this survive an update.
 *
 * ADCode is not patched, forked, or repacked. Its main process reads
 * `ADCODE_AD_SERVER` when it starts, so the only durable hook is *how it is
 * started*. That is why this module owns a launcher instead of a rule about a
 * binary: an AppImage that updates to a new filename, a new version, or a new
 * internal endpoint still reads the same environment variable, and the proxy
 * still answers the same path.
 *
 * Resolution happens on every launch, not at install time. A recorded path is a
 * hint, not the answer: if the file is gone, the newest AppImage in the usual
 * places wins. That single decision is the difference between a wrapper that
 * breaks on the next release and one that does not.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const WRAPPER_MARK = "# adcode-blackout launcher";
export const UNIT_NAME = "adcode-blackout.service";

const APPIMAGE_NAME = /^adcode.*\.appimage$/i;
const MIN_APPIMAGE_BYTES = 1024 * 1024;

export function appImageRecordPath(home = homedir()) {
  return join(home, ".config", "blackout", "appimage");
}

export function wrapperPath(home = homedir()) {
  return join(home, ".local", "bin", "adcode");
}

export function applicationsDir(home = homedir()) {
  return join(home, ".local", "share", "applications");
}

export function unitPath(home = homedir()) {
  return join(home, ".config", "systemd", "user", UNIT_NAME);
}

function looksLikeAppImage(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size >= MIN_APPIMAGE_BYTES;
  } catch {
    return false;
  }
}

/** Newest first. Missing directories are normal, not errors. */
export function findAppImages({ home = homedir(), extraDirs = [] } = {}) {
  const dirs = [
    join(home, "Applications"),
    join(home, "AppImages"),
    join(home, "Downloads"),
    join(home, ".local", "bin"),
    ...extraDirs,
  ];
  const found = [];
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!APPIMAGE_NAME.test(name)) continue;
      const path = join(dir, name);
      if (!looksLikeAppImage(path)) continue;
      try {
        found.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Explicit path, then the last recorded path, then the newest discovered one.
 *
 * `reason` says which rule won, because "which AppImage am I running?" is the
 * first question in every bug report about a launcher.
 */
export function resolveAppImage({ explicit = null, home = homedir(), env = process.env, extraDirs = [] } = {}) {
  // An explicit path is authoritative. Falling back to a discovered AppImage
  // after a typo would launch a different build than the one that was asked for
  // - for an `install` that records it, or a `compat` that judges it, silently
  // choosing another file is worse than refusing.
  if (explicit !== null && !looksLikeAppImage(explicit)) {
    return { path: null, reason: "explicit-rejected", found: false, rejected: explicit };
  }

  const candidates = [];
  if (explicit !== null) candidates.push({ path: explicit, reason: "explicit" });

  const fromEnv = env["ADCODE_APPIMAGE"];
  if (fromEnv) candidates.push({ path: fromEnv, reason: "env" });

  const record = appImageRecordPath(home);
  if (existsSync(record)) {
    try {
      const recorded = readFileSync(record, "utf8").trim();
      if (recorded !== "") candidates.push({ path: recorded, reason: "recorded" });
    } catch {
      /* unreadable record is simply not a candidate */
    }
  }

  for (const candidate of candidates) {
    if (looksLikeAppImage(candidate.path)) {
      return { path: candidate.path, reason: candidate.reason, found: true };
    }
  }

  const discovered = findAppImages({ home, extraDirs });
  if (discovered.length > 0) {
    return { path: discovered[0].path, reason: "newest", found: true, alternatives: discovered.map((one) => one.path) };
  }
  return { path: null, reason: "none", found: false };
}

export function recordAppImage(path, home = homedir()) {
  const file = appImageRecordPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${path}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

export function forgetAppImage(home = homedir()) {
  const file = appImageRecordPath(home);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export function renderWrapper({ node = process.execPath, cli, home = homedir() }) {
  return `#!/bin/sh
${WRAPPER_MARK}
# Generated by \`blackout install\`; \`blackout uninstall\` removes it.
#
# The AppImage is resolved by the CLI on every run, so an update that installs
# a new filename is picked up without reinstalling this wrapper.
NODE=${shellQuote(node)}
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null)"
fi
if [ -z "$NODE" ]; then
  echo "adcode-blackout: node is not on PATH; run \`blackout install\` again" >&2
  exit 127
fi
exec "$NODE" ${shellQuote(cli)} launch -- "$@"
`;
}

export function isOurWrapper(path) {
  try {
    return readFileSync(path, "utf8").includes(WRAPPER_MARK);
  } catch {
    return false;
  }
}

export function installWrapper({ home = homedir(), node = process.execPath, cli }) {
  const path = wrapperPath(home);
  if (existsSync(path) && !isOurWrapper(path)) {
    throw new Error(`${path} already exists and was not written by blackout; leaving it alone`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderWrapper({ node, cli, home }), "utf8");
  chmodSync(path, 0o755);
  return path;
}

export function removeWrapper(home = homedir()) {
  const path = wrapperPath(home);
  if (!existsSync(path)) return false;
  if (!isOurWrapper(path)) {
    throw new Error(`${path} was not written by blackout; refusing to remove it`);
  }
  unlinkSync(path);
  return true;
}

/* ── Desktop entries ─────────────────────────────────────────────────────── */

function desktopFiles(home) {
  const dirs = [applicationsDir(home)];
  const files = [];
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".desktop")) files.push(join(dir, name));
    }
  }
  return files;
}

function execLine(text) {
  const match = /^Exec=(.*)$/m.exec(text);
  return match === null ? null : match[1];
}

/**
 * Does this Exec line launch *an* ADCode AppImage, not necessarily the current
 * one?
 *
 * Matching only the resolved path means an entry is left pointing at the old
 * filename after an update, and the new install does not touch it - the exact
 * case the launcher exists for. Any ADCode*.AppImage token counts, because the
 * wrapper re-resolves the newest one at run time.
 */
function launchesAdcode(exec, appImage) {
  const cleaned = exec.replace(/["']/g, "");
  if (cleaned.includes(appImage)) return true;
  return cleaned.split(/\s+/).some((token) => APPIMAGE_NAME.test(basename(token)));
}

/**
 * Point the desktop entry at the wrapper, keeping a one-time backup.
 *
 * Matching is deliberately narrow: only entries that already launch this
 * AppImage (by absolute path or by its ADCode basename) are touched. Patching
 * every entry with "adcode" in it would eventually rewrite somebody else's
 * launcher.
 */
export function patchDesktopEntries({ home = homedir(), appImage, wrapper = wrapperPath(home) }) {
  const patched = [];
  for (const file of desktopFiles(home)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const exec = execLine(text);
    if (exec === null) continue;
    if (!launchesAdcode(exec, appImage)) continue;
    if (exec.includes(wrapper)) continue;

    const backup = `${file}.blackout-backup`;
    if (!existsSync(backup)) copyFileSync(file, backup);
    const rewritten = text.replace(/^Exec=.*$/m, `Exec="${wrapper}" %U`);
    writeFileSync(file, rewritten, "utf8");
    patched.push({ file, backup });
  }
  return patched;
}

export function restoreDesktopEntries(home = homedir()) {
  const restored = [];
  for (const file of desktopFiles(home)) {
    const backup = `${file}.blackout-backup`;
    if (!existsSync(backup)) continue;
    renameSync(backup, file);
    restored.push(file);
  }
  return restored;
}

/* ── The systemd user unit ───────────────────────────────────────────────── */

export function renderUnit({ node = process.execPath, cli, port = 8790 }) {
  return `[Unit]
Description=adcode-blackout local ad blocker
Documentation=https://github.com/10xdev4u-alt/adcode-blackout
After=network.target

[Service]
Type=simple
ExecStart="${node}" "${cli}" serve --foreground --port ${port}
Restart=on-failure
RestartSec=2
# The proxy needs to read the install, write its own state and listen on
# loopback. Nothing else. StateDirectory is the same path as the default
# stateHome(), so no environment variable is required.
StateDirectory=blackout
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=default.target
`;
}

export function installUnit({ home = homedir(), node, cli, port }) {
  const path = unitPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderUnit({ node, cli, port }), "utf8");
  return path;
}

export function removeUnit(home = homedir()) {
  const path = unitPath(home);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function unitEnabled(home = homedir()) {
  return existsSync(join(home, ".config", "systemd", "user", "default.target.wants", UNIT_NAME));
}
