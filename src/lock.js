/**
 * One state directory, one writer.
 *
 * `serve --port A` and `serve --port B` against the same state directory both
 * opened `journal.jsonl` and appended their own chains. Each line was valid and
 * each process believed its own head, so the file read as a broken chain from
 * the first interleaved entry - the one thing the journal exists to detect, now
 * caused by the tool itself. Reproduced: two proxies, ten decisions each,
 * `verify` said `BROKEN at entry 1`.
 *
 * A pid file cannot answer this: it is rewritten by whoever starts last, and a
 * dead pid can be recycled. This is a separate, explicit claim that is only
 * released by its owner, with the same rule the rest of the tool uses for
 * ownership - the claim counts only while the process holding it is still the
 * proxy. A crash leaves a stale file, and the next start takes it over.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { lockPath } from "./policy.js";
import { isBlackoutPid } from "./netinfo.js";

/** `{ pid, port, at }`, or null for a missing, unreadable or garbled file. */
function readClaim(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 1) return null;
    return {
      pid: parsed.pid,
      port: Number.isSafeInteger(parsed.port) ? parsed.port : null,
      at: Number.isSafeInteger(parsed.at) ? parsed.at : null,
    };
  } catch {
    return null;
  }
}

/**
 * The live claim, if there is one.
 *
 * A file naming a pid that is alive but no longer a proxy - a recycled number,
 * or a process that has exited since - is stale, not a claim.
 */
export function inspectLock({ path = lockPath(), isProxy = isBlackoutPid } = {}) {
  const holder = readClaim(path);
  return holder !== null && isProxy(holder.pid) ? holder : null;
}

/**
 * Take the claim. `ok: false` names who has it.
 *
 * Two attempts, not a loop: the first is the ordinary case, the second covers a
 * stale file removed between our read and our write. After that the answer is
 * a refusal, because spinning here would just hide the conflict.
 */
export function acquireLock({ port = null, path = lockPath(), pid = process.pid, isProxy = isBlackoutPid } = {}) {
  // One timestamp for the file and the answer: a caller that compares the claim
  // it was given against the claim on disk must not see two readings of the
  // clock, and neither should a reader of the file.
  const at = Date.now();
  const body = `${JSON.stringify({ pid, port, at })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      return { ok: true, holder: { pid, port, at } };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const holder = readClaim(path);
      if (holder !== null && isProxy(holder.pid)) return { ok: false, holder };
      try {
        unlinkSync(path);
      } catch {
        // Another starter removed it first; the retry settles who wins.
      }
    }
  }
  return { ok: false, holder: readClaim(path) };
}

/**
 * Drop the claim, but only our own.
 *
 * A stop that arrives after another process took over a stale file must not
 * delete that process's claim.
 */
export function releaseLock({ path = lockPath(), pid = process.pid } = {}) {
  const holder = readClaim(path);
  if (holder === null || holder.pid !== pid) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
