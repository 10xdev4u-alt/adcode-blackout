/**
 * Rewrite the server's serving config so the client stops asking.
 *
 * The client validates this response strictly: exactly `killSwitch`, `caps`
 * and `projections`, and all four preset keys inside `projections`. Returning
 * extra keys is not a harmless superset — `onlyKnownKeys` rejects the whole
 * object, the client falls back, and the blocker appears not to work. So the
 * rewrite constructs the exact shape rather than spreading whatever upstream
 * sent.
 */
export const PRESETS = ["off", "light", "standard", "max"];

export const SAFE_CONFIG = Object.freeze({
  killSwitch: true,
  caps: Object.freeze({ dailyCap: 0 }),
  projections: Object.freeze({ off: "0", light: "0", standard: "0", max: "0" }),
});

const DECIMAL = /^[0-9]{1,19}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCaps(value) {
  if (!isRecord(value)) return { dailyCap: 0 };
  /** Only the two keys the client knows; a third would fail validation. */
  const caps = { dailyCap: 0 };
  if (Number.isSafeInteger(value["minIntervalMs"]) && value["minIntervalMs"] >= 0) {
    caps.minIntervalMs = value["minIntervalMs"];
  }
  return caps;
}

function safeProjections(value) {
  if (!isRecord(value)) return { ...SAFE_CONFIG.projections };
  const projections = {};
  for (const preset of PRESETS) {
    const amount = value[preset];
    projections[preset] = typeof amount === "string" && DECIMAL.test(amount) ? amount : "0";
  }
  return projections;
}

/**
 * Parse an upstream config response and force it off.
 *
 * Throws only when the upstream body is not JSON at all; a well-formed but
 * surprising object is repaired into the safe shape, because the alternative
 * is leaving the user with ads after a server-side schema change.
 */
export function rewriteConfig(text) {
  let upstream;
  try {
    upstream = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`config response is not JSON: ${String(error.message ?? error)}`);
  }
  if (!isRecord(upstream)) throw new TypeError("config response is not an object");

  return {
    config: {
      killSwitch: true,
      caps: safeCaps(upstream["caps"]),
      projections: safeProjections(upstream["projections"]),
    },
    observed: {
      killSwitch: upstream["killSwitch"] === true,
      dailyCap: isRecord(upstream["caps"]) && Number.isSafeInteger(upstream["caps"]["dailyCap"])
        ? upstream["caps"]["dailyCap"]
        : null,
    },
  };
}

export function serializeConfig(config) {
  return JSON.stringify(config);
}
