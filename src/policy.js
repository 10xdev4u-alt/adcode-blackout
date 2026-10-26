/**
 * Local configuration, validated once and then trusted.
 *
 * The defaults are deliberately boring: loopback only, the production origin,
 * dashboard on. Everything that could expose the proxy to a network is refused
 * rather than clamped, because a typo in a host is how a local tool becomes a
 * public one.
 *
 * Only settings something reads belong here. A `team` block used to be parsed
 * and validated with no reader anywhere: nothing documented it, and a
 * misspelled `team.url` stopped every command with "cannot read config.json".
 * A setting that cannot do anything must not be able to break anything.
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
  rules: "core",
});

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function configHome() {
  return process.env["BLACKOUT_HOME"] ?? join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "blackout");
}

export function stateHome() {
  return process.env["BLACKOUT_STATE"] ?? join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "blackout");
}

/**
 * A host and port as one authority.
 *
 * The policy allows `::1`, and an IPv6 literal has to be bracketed wherever it
 * sits next to a port. Without the brackets `http://::1:8790` is not a URL:
 * `status` reported "not running" against a serving proxy, and the app was
 * launched with an `ADCODE_AD_SERVER` it could not use.
 */
export function hostPort(host, port) {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export const policyPath = () => join(configHome(), "config.json");
export const journalPath = () => join(stateHome(), "journal.jsonl");
export const pidPath = () => join(stateHome(), "blackout.pid");
export const lockPath = () => join(stateHome(), "blackout.lock");
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
