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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const GENESIS = "0".repeat(64);

/** Five MiB is roughly 25,000 decisions. Small enough to read at startup. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `journal.jsonl` -> `journal.0001.jsonl`, `journal.0002.jsonl`, ... */
function segmentNames(filePath) {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const stem = base.replace(/\.jsonl$/, "");
  const pattern = new RegExp(`^${escapeRegExp(stem)}\\.(\\d+)\\.jsonl$`);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter(({ match }) => match !== null)
    .map(({ name, match }) => ({ name, index: Number(match[1]) }))
    .sort((a, b) => a.index - b.index)
    .map(({ name }) => join(dir, name));
}

/**
 * Every entry on disk, oldest first: rotated segments, then the live file.
 *
 * Rotation keeps the chain intact because the first entry of a new file points
 * at the last hash of the previous one. Concatenating in this order is exactly
 * the chain `verifyChain` expects.
 */
export function readJournalChain(filePath) {
  const entries = [];
  for (const file of [...segmentNames(filePath), ...(existsSync(filePath) ? [filePath] : [])]) {
    entries.push(...readJournal(file));
  }
  return entries;
}

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
export function createJournal(filePath = null, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const entries = [];
  const listeners = new Set();
  let integrity = { ok: true, brokenAt: null };
  let prev = GENESIS;
  let seq = 0;
  let writeError = null;

  if (filePath !== null) {
    const loaded = readJournalChain(filePath);
    entries.push(...loaded);
    if (loaded.length > 0) {
      const last = loaded[loaded.length - 1];
      prev = last.hash;
      seq = last.seq + 1;
      integrity = verifyChain(loaded);
    }
  }

  /**
   * Record a write failure instead of throwing it.
   *
   * The journal is the audit trail; blocking is the product. A full disk or a
   * read-only state directory must cost the record, never the decision, so the
   * entry stays in memory and this failure is surfaced by `/health`, `status`
   * and `report`. The resulting gap on disk is real: after a restart `verify`
   * names it, which is the honest outcome. Pretending the chain is intact would
   * be worse than a gap that is reported.
   */
  function noteWriteError(error) {
    if (writeError === null) writeError = { at: Date.now(), message: String(error?.message ?? error) };
  }

  /**
   * Move the live file aside once it passes the threshold.
   *
   * Checked after an append, not before: an entry that would cross the line is
   * written to the file it belongs to, and the next append starts a fresh file.
   * Renaming is atomic on the same filesystem, so a crash leaves either the old
   * name or the segment, never half of each.
   */
  function rotateIfNeeded() {
    if (filePath === null) return;
    let size;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }
    if (size <= maxBytes) return;

    try {
      const segments = segmentNames(filePath);
      const next = segments.length === 0 ? 1 : Number(/\.(\d+)\.jsonl$/.exec(segments[segments.length - 1])[1]) + 1;
      const target = join(dirname(filePath), `${basename(filePath).replace(/\.jsonl$/, "")}.${String(next).padStart(4, "0")}.jsonl`);
      renameSync(filePath, target);
      writeFileSync(filePath, "", "utf8");
    } catch (error) {
      // A failed rotation is the same failure as a failed append: the live file
      // keeps growing, but the next decision still gets made and still counts.
      noteWriteError(error);
    }
  }

  function persist(line) {
    if (filePath === null) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, line);
    } catch (error) {
      noteWriteError(error);
    }
  }

  function append(kind, data = {}) {
    const entry = { seq: seq++, at: Date.now(), kind, data, prev };
    entry.hash = digest(entry);
    prev = entry.hash;
    entries.push(entry);
    persist(`${JSON.stringify(entry)}\n`);
    rotateIfNeeded();
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // A dead subscriber must not cost the decision it was watching.
      }
    }
    return entry;
  }

  /** Watch new entries. Returns the unsubscribe function. */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    append,
    subscribe,
    get entries() { return entries; },
    get integrity() { return integrity; },
    get path() { return filePath; },
    get segments() { return filePath === null ? [] : segmentNames(filePath); },
    /** Null until a write fails; then `{ at, message }` for the first failure. */
    get writeError() { return writeError; },
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
