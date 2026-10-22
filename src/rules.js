/**
 * Rules as data, not code.
 *
 * The ad surface will move: a new API version, a renamed path, a second
 * inventory call. If every change needed a release, the blocker would be
 * correct only on the version it shipped with. A rule pack is a small JSON
 * document that says which requests are ad requests and what to answer, so a
 * new endpoint is a pull request to a data file.
 *
 * Matching is ordered and first-wins, which makes a broad future rule safe to
 * put after the exact ones.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configHome } from "./policy.js";

export const ACTIONS = new Set(["empty-serve", "ack-receipts", "rewrite-config", "block", "pass"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "*"]);

function ruleUrl(name) {
  return new URL(`../rules/${name}.json`, import.meta.url);
}

/**
 * Where a user pack lives, if one does.
 *
 * The bundled pack is the default, not the ceiling: a new endpoint should be a
 * file the user can add and reload, not a reason to edit an installed package
 * or wait for a release. The override is validated by exactly the same loader,
 * so a typo is refused at load and the old pack can stay in place.
 */
export function userRulePath(name) {
  return join(configHome(), "rules", `${name}.json`);
}

export function validatePack(pack) {
  if (pack === null || typeof pack !== "object") throw new TypeError("rule pack must be an object");
  if (typeof pack.name !== "string" || !/^[a-z0-9-]+$/.test(pack.name)) throw new TypeError("rule pack name is invalid");
  if (!Array.isArray(pack.rules) || pack.rules.length === 0) throw new TypeError("rule pack needs at least one rule");

  const ids = new Set();
  const rules = pack.rules.map((rule, index) => {
    if (rule === null || typeof rule !== "object") throw new TypeError(`rule ${index} is not an object`);
    const { id, match, action } = rule;
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) throw new TypeError(`rule ${index} has an invalid id`);
    if (ids.has(id)) throw new TypeError(`duplicate rule id: ${id}`);
    ids.add(id);

    if (!ACTIONS.has(action)) throw new TypeError(`rule ${id} has an unknown action: ${action}`);
    if (match === null || typeof match !== "object") throw new TypeError(`rule ${id} needs a match`);
    if (!METHODS.has(match.method)) throw new TypeError(`rule ${id} has an invalid method`);
    const hasPath = typeof match.path === "string";
    const hasPattern = typeof match.pathPattern === "string";
    if (hasPath === hasPattern) throw new TypeError(`rule ${id} needs exactly one of path or pathPattern`);
    if (hasPath && !match.path.startsWith("/")) throw new TypeError(`rule ${id} path must start with /`);

    let pattern = null;
    if (hasPattern) {
      try {
        pattern = new RegExp(match.pathPattern);
      } catch (error) {
        throw new TypeError(`rule ${id} has an invalid pattern: ${String(error.message ?? error)}`);
      }
    }

    return Object.freeze({
      id,
      action,
      method: match.method,
      path: hasPath ? match.path : null,
      pattern,
      since: typeof rule.since === "string" ? rule.since : null,
      note: typeof rule.note === "string" ? rule.note : "",
    });
  });

  return Object.freeze({
    name: pack.name,
    version: Number.isSafeInteger(pack.version) ? pack.version : 1,
    updated: typeof pack.updated === "string" ? pack.updated : null,
    detect: Array.isArray(pack.detect) ? pack.detect.filter((item) => typeof item === "string") : [],
    rules: Object.freeze(rules),
  });
}

/** The pack that shipped with this install, regardless of any override. */
export function bundledRulePath(name = "core") {
  return fileURLToPath(ruleUrl(name));
}

export function loadRulePack(name = "core", file = null) {
  const override = userRulePath(name);
  const path = file ?? (existsSync(override) ? override : ruleUrl(name));
  let pack;
  try {
    pack = validatePack(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`${String(path)}: ${String(error.message ?? error)}`);
  }
  return Object.freeze({ ...pack, source: String(path) });
}

export function matches(rule, method, path) {
  if (rule.method !== "*" && rule.method !== method) return false;
  return rule.path !== null ? rule.path === path : rule.pattern.test(path);
}

export function matchRule(pack, method, path) {
  for (const rule of pack.rules) {
    if (matches(rule, method, path)) return rule;
  }
  return null;
}

/** The paths a pack claims, for coverage reports. Ordered, de-duplicated. */
export function coveredTargets(pack) {
  return pack.rules.map((rule) => (rule.path !== null ? rule.path : String(rule.pattern)));
}
