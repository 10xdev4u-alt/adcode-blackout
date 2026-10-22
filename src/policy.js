/**
 * Local configuration, validated once and then trusted.
 *
 * The defaults are deliberately boring: loopback only, the production origin,
 * dashboard on. Everything that could expose the proxy to a network is refused
 * rather than clamped, because a typo in a host is how a local tool becomes a
 * public one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_POLICY = Object.freeze({
  upstream: "https://adcode.bluethenics.com",
  host: "127.0.0.1",
  port: 8790,
  enabled: true,
  dashboard: true,
  estimates: Object.freeze({ secondsPerAd: 8, microsPerView: 1500 }),
  team: Object.freeze({ url: null, token: null, intervalMs: 60_000 }),
  rules: "core",
});

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function configHome() {
  return process.env["BLACKOUT_HOME"] ?? join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "blackout");
}

export function stateHome() {
  return process.env["BLACKOUT_STATE"] ?? join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "blackout");
}

export const policyPath = () => join(configHome(), "config.json");
export const journalPath = () => join(stateHome(), "journal.jsonl");
export const pidPath = () => join(stateHome(), "blackout.pid");
export const logPath = () => join(stateHome(), "blackout.log");

export function ensureHome() {
  mkdirSync(configHome(), { recursive: true });
  mkdirSync(stateHome(), { recursive: true });
}

function positiveInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function httpUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${field} must be http or https`);
  }
  return url.toString().replace(/\/$/, "");
}

export function parsePolicy(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("policy must be an object");
  }

  const estimates = { ...DEFAULT_POLICY.estimates, ...(input.estimates ?? {}) };
  const team = { ...DEFAULT_POLICY.team, ...(input.team ?? {}) };

  const policy = {
    upstream: httpUrl(input.upstream ?? DEFAULT_POLICY.upstream, "upstream"),
    host: input.host ?? DEFAULT_POLICY.host,
    port: positiveInteger(input.port ?? DEFAULT_POLICY.port, "port", { max: 65_535 }),
    enabled: input.enabled ?? DEFAULT_POLICY.enabled,
    dashboard: input.dashboard ?? DEFAULT_POLICY.dashboard,
    estimates: {
      secondsPerAd: positiveInteger(estimates.secondsPerAd, "estimates.secondsPerAd", { max: 3_600 }),
      microsPerView: positiveInteger(estimates.microsPerView, "estimates.microsPerView", { max: 1_000_000_000 }),
    },
    team: {
      url: team.url === null ? null : httpUrl(team.url, "team.url"),
      token: team.token === null ? null : String(team.token),
      intervalMs: positiveInteger(team.intervalMs, "team.intervalMs", { min: 5_000, max: 86_400_000 }),
    },
    rules: String(input.rules ?? DEFAULT_POLICY.rules),
  };

  if (!LOOPBACK.has(policy.host)) {
    throw new TypeError("host must be a loopback address; the proxy is not a network service");
  }
  if (typeof policy.enabled !== "boolean") throw new TypeError("enabled must be boolean");
  if (typeof policy.dashboard !== "boolean") throw new TypeError("dashboard must be boolean");
  if (!/^[a-z0-9-]+$/i.test(policy.rules)) throw new TypeError("rules must be a rule pack name");
  return policy;
}

export function loadPolicy(path = policyPath()) {
  if (!existsSync(path)) return parsePolicy({});
  return parsePolicy(JSON.parse(readFileSync(path, "utf8")));
}

export function savePolicy(policy, path = policyPath()) {
  const validated = parsePolicy(policy);
  ensureHome();
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return validated;
}
