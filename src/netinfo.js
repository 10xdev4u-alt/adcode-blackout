/**
 * Who owns a loopback port, when the answer is knowable.
 *
 * `doctor` can say "not running" without this. That is true and useless when a
 * different process holds 8790: the advice ("start the proxy") is wrong, and
 * the user has no next step. On Linux the kernel already knows the inode, and
 * /proc already knows which process owns it, so this stays read-only and
 * dependency-free. Everywhere else it returns null rather than guessing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

function hexPort(port) {
  return port.toString(16).toUpperCase().padStart(4, "0");
}

function inodeFor(port) {
  const wanted = `:${hexPort(port)}`;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const local = fields[1] ?? "";
      const state = fields[3];
      if (state !== "0A" || !local.endsWith(wanted)) continue;
      const inode = fields[9];
      if (/^\d+$/.test(inode) && inode !== "0") return inode;
    }
  }
  return null;
}

function pidForInode(inode) {
  const target = `socket:[${inode}]`;
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${entry}/fd/${fd}`) === target) return Number(entry);
      } catch {
        /* fd closed while scanning */
      }
    }
  }
  return null;
}

function pidFromSs(port) {
  try {
    const text = execFileSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8", timeout: 2_000 });
    const match = /pid=(\d+)/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

export function listenerPid(port, { platform = process.platform } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  if (platform !== "linux") return null;
  const inode = inodeFor(port);
  const pid = inode === null ? null : pidForInode(inode);
  return pid ?? pidFromSs(port);
}

/**
 * Is this pid the proxy we started, rather than a recycled pid?
 *
 * The pid is read from a file that outlives the process that wrote it, so after
 * a reboot it can name anything. A command line that merely mentions "blackout"
 * is not proof: `tail -f ~/.local/state/blackout/blackout.log` and
 * `vim ~/.config/blackout/config.json` both contain it, and both died to a
 * SIGTERM that named them. The proxy is always `node <...>/blackout.js serve`,
 * so both the entrypoint and the subcommand are required.
 */
export function isBlackoutPid(pid) {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return argv.includes("serve") && argv.some((arg) => arg.endsWith("blackout.js"));
  } catch {
    return false;
  }
}

export function describePid(pid) {
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    return command === "" ? `pid ${pid}` : `pid ${pid}: ${command}`;
  } catch {
    return `pid ${pid}`;
  }
}
