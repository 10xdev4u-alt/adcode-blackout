/**
 * Start the proxy if it is not already up, then start ADCode pointed at it.
 *
 * The proxy is best-effort but the editor is not: if the proxy cannot start,
 * ADCode still launches, with a warning and a journal entry. A blocker that
 * locks someone out of their IDE because a port is busy has made the problem
 * worse, and brief §9 says the worst permitted outcome of an ad-side failure is
 * seeing an ad.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logPath, pidPath } from "./policy.js";

const READY_TIMEOUT_MS = 4_000;
const READY_STEP_MS = 100;

export async function probe(baseUrl, { fetchImpl = fetch, timeoutMs = 500 } = {}) {
  try {
    const response = await fetchImpl(`${baseUrl}/_blackout/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export function proxyUrl(policy) {
  return `http://${policy.host}:${policy.port}`;
}

async function waitUntilReady(baseUrl, { fetchImpl, timeoutMs = READY_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probe(baseUrl, { fetchImpl });
    if (health !== null) return health;
    await new Promise((resolve) => setTimeout(resolve, READY_STEP_MS));
  }
  return null;
}

/**
 * Spawn a detached proxy and wait for its health endpoint.
 *
 * Detached so it outlives the launcher process: the launcher exits with the
 * editor, but the proxy may keep serving a second window.
 */
export async function ensureProxy({ policy, cli, node = process.execPath, spawnImpl = spawn, fetchImpl = fetch, autoStart = true }) {
  const url = proxyUrl(policy);
  const existing = await probe(url, { fetchImpl });
  if (existing !== null) return { url, started: false, health: existing };

  if (!autoStart) return { url, started: false, health: null, reason: "not-running" };

  mkdirSync(dirname(logPath()), { recursive: true });
  const log = openSync(logPath(), "a");
  const child = spawnImpl(node, [cli, "serve", "--foreground", "--port", String(policy.port)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  closeSync(log);
  child.unref?.();

  const health = await waitUntilReady(url, { fetchImpl });
  if (health === null) return { url, started: true, health: null, reason: "not-ready" };
  return { url, started: true, health };
}

/** Wait for the editor, forwarding the signals a terminal sends. */
export function launchApp({ appImage, args = [], env = process.env, url, spawnImpl = spawn }) {
  const child = spawnImpl(appImage, args, {
    stdio: "inherit",
    env: { ...env, ADCODE_AD_SERVER: url },
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const handlers = new Map([
    ["SIGINT", () => forward("SIGINT")],
    ["SIGTERM", () => forward("SIGTERM")],
    ["SIGHUP", () => forward("SIGHUP")],
  ]);
  for (const [signal, handler] of handlers) process.on(signal, handler);

  return new Promise((resolve) => {
    child.on("error", (error) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve({ code: 127, error });
    });
    child.on("exit", (code, signal) => {
      for (const [signalName, handler] of handlers) process.off(signalName, handler);
      resolve({ code: code ?? (signal === null ? 1 : 1), signal });
    });
  });
}

export function writePid(pid = process.pid) {
  const path = pidPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`, "utf8");
  return path;
}

export function removePid() {
  try {
    unlinkSync(pidPath());
  } catch {
    // Already gone, which is the desired state.
  }
}
