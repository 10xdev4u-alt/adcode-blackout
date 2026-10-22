/**
 * Append-only, hash-chained event log.
 *
 * Every decision the blocker makes is one line: what it saw, what it did, and
 * the hash of the line before it. That makes the report verifiable after the
 * fact: editing a line, deleting one, or reordering two changes every hash
 * after it, and `verify` names the first index that no longer adds up.
 *
 * The chain is a tamper *detector*, not a tamper *preventer*. Someone with
 * write access can rewrite the whole file; they cannot rewrite it and keep the
 * head hash the report already published.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const GENESIS = "0".repeat(64);

function digest(entry) {
  return createHash("sha256")
    .update(JSON.stringify([entry.seq, entry.at, entry.kind, entry.data, entry.prev]))
    .digest("hex");
}

/**
 * Open a journal, resuming the chain when the file already exists.
 *
 * A crash can leave a truncated last line. That is tolerated by dropping the
 * partial tail, because a half-written line is not evidence of anything. A
 * genuinely broken chain is not repaired: it is reported, so the record keeps
 * its meaning.
 */
export function createJournal(filePath = null) {
  const entries = [];
  let integrity = { ok: true, brokenAt: null };
  let prev = GENESIS;
  let seq = 0;

  if (filePath !== null && existsSync(filePath)) {
    const loaded = readJournal(filePath);
    entries.push(...loaded);
    if (loaded.length > 0) {
      const last = loaded[loaded.length - 1];
      prev = last.hash;
      seq = last.seq + 1;
      integrity = verifyChain(loaded);
    }
  }

  function append(kind, data = {}) {
    const entry = { seq: seq++, at: Date.now(), kind, data, prev };
    entry.hash = digest(entry);
    prev = entry.hash;
    if (filePath !== null) {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
    }
    entries.push(entry);
    return entry;
  }

  return {
    append,
    get entries() { return entries; },
    get integrity() { return integrity; },
    get path() { return filePath; },
    head: () => prev,
  };
}

/** Recompute every link. Returns the first index that fails, rather than throwing. */
export function verifyChain(entries) {
  let prev = GENESIS;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.seq !== index || entry.prev !== prev || digest(entry) !== entry.hash) {
      return { ok: false, brokenAt: index };
    }
    prev = entry.hash;
  }
  return { ok: true, brokenAt: null };
}

/** Tolerant of a truncated final line; strict about every line before it. */
export function readJournal(filePath) {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      if (index === lines.length - 1 || lines.slice(index + 1).every((rest) => rest.trim() === "")) {
        break;
      }
      throw new Error(`journal is corrupt at line ${index + 1}`);
    }
  }
  return entries;
}

export function summarize(entries) {
  const counts = Object.create(null);
  for (const entry of entries) {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  }
  return { ...counts };
}
