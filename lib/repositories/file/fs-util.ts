/**
 * CLAUDE.md §2 step 5 / §6.5 — the file backend's infrastructure. Three concerns, all of which
 * the contract suite can observe but only this layer can implement:
 *
 *  1. **Path safety.** Ids arrive from HTTP. A crafted id (`../../etc/passwd`) must be rejected
 *     BY THE PATH BUILDER, not by a caller remembering to validate. Defence lives where the
 *     filesystem is actually touched.
 *  2. **Atomic writes.** Write to a temp file in the SAME directory, fsync, then rename. Rename
 *     within a filesystem is atomic, so a crashed or concurrent write can never leave a
 *     half-written JSON file that fails to parse on next read.
 *  3. **Per-key locks.** `updateMeta` is read-modify-write; without serialization two concurrent
 *     patches lose one of the two writes. Atomicity alone does not prevent that — it guarantees
 *     the file is never *corrupt*, not that no update is *lost*.
 *
 * Note: the lock is in-process only. That is correct for v1 (single Next server, SPEC §10) and
 * for file-on-EFS with one task; multi-task writers would need a different mechanism. Documented
 * rather than silently assumed.
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/* ─────────────────────────────── path safety ─────────────────────────────── */

/**
 * A segment is letters/digits/`-`/`_`, optionally followed by ONE short extension. An allowlist,
 * because a denylist of traversal tricks is a losing game — this single rule rejects `..`,
 * absolute paths, path separators, NUL, drive letters, and Windows reserved characters.
 *
 * The optional extension exists so `paths.ts` can build `{id}.json` / `{id}.bin` through the same
 * validator. It cannot reintroduce traversal: a leading dot is not matched, so `..`, `.`, and
 * `..json` are all rejected.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}(\.[A-Za-z0-9]{1,8})?$/;

export class UnsafePathSegmentError extends Error {
  constructor(readonly segment: string) {
    // Do NOT interpolate the raw segment into a user-facing string; it's attacker-controlled.
    super("Rejected an unsafe storage id");
    this.name = "UnsafePathSegmentError";
  }
}

/** Validate one path segment (userId, entity id, filename stem). Throws rather than sanitizing. */
export function safeSegment(segment: string): string {
  if (!SAFE_SEGMENT.test(segment)) throw new UnsafePathSegmentError(segment);
  return segment;
}

/**
 * Join validated segments beneath `root`, then assert containment. The regex should make escape
 * impossible; the second check is defence in depth against a future regex change.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, ...segments.map(safeSegment));
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new UnsafePathSegmentError(segments.join("/"));
  }
  return full;
}

/* ────────────────────────────── atomic file IO ───────────────────────────── */

let tempCounter = 0;

/**
 * Windows-only: a rename over a destination that any process currently holds open fails `EPERM`
 * (POSIX rename just wins). Node opens no handle with `FILE_SHARE_DELETE`, so a concurrent
 * `readFile` of the SAME file is enough to break the swap.
 *
 * That is not a test artifact — it is this app's normal shape. The `KeyedMutex` serializes
 * *writers*, and readers are deliberately unlocked (a GET must not wait on a PATCH), so every
 * read of a file being rewritten is a candidate. It surfaced only under the full suite, where
 * enough IO runs concurrently to make the window wide; three isolated runs of the same test
 * passed, which is exactly how a real race pretends to be flake.
 *
 * The reader's handle is short-lived, so a bounded retry is sufficient and correct — verified by
 * probe (`out/probe-eperm.mjs`): rename fails EPERM while a read handle is open and succeeds once
 * it closes. Atomicity is untouched: each attempt is still a single rename that either replaces
 * the file wholly or not at all. A reader never sees a partial file; a writer may just need a
 * second try.
 */
const RENAME_RETRY_DELAYS_MS = [1, 4, 10, 25, 50];

async function renameWithRetry(temp: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, filePath);
      return;
    } catch (err) {
      // Only the sharing-violation family is retried. ENOENT (a vanished temp file) or EACCES on a
      // read-only directory are real failures and must surface immediately rather than after 90ms.
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Atomic write: temp file in the target directory → rename over the destination.
 *
 * The temp file MUST share the destination's directory — a rename across filesystems is a
 * copy+delete and loses atomicity.
 */
export async function writeFileAtomic(filePath: string, data: Uint8Array | string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  // pid + counter, not a random name: unique per process without needing a crypto call, and the
  // counter guarantees uniqueness even within the same millisecond.
  const temp = path.join(dir, `.tmp-${process.pid}-${tempCounter++}-${path.basename(filePath)}`);
  try {
    // `flush: true` fsyncs before close, so the rename cannot expose an empty file after a crash.
    await writeFile(temp, data, { flush: true });
    await renameWithRetry(temp, filePath);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export const writeJsonFile = (filePath: string, value: unknown): Promise<void> =>
  // Pretty-printed deliberately: these files are user data a developer will read and diff.
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));

export async function removeFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export async function removeDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Entries of a directory, or `[]` if it does not exist. Skips the atomic-write temp files. */
export async function listDir(dirPath: string): Promise<string[]> {
  try {
    return (await readdir(dirPath)).filter((name) => !name.startsWith(".tmp-"));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

export const isNotFound = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";

/* ─────────────────────────────── per-key locks ───────────────────────────── */

/**
 * Serializes async work per key by chaining promises. Two `withLock(k, …)` calls for the same key
 * run in order; different keys run concurrently.
 *
 * The chain is built from a promise that never rejects, so one failed critical section cannot
 * poison the lock for later callers.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    // The stored tail is what the NEXT caller awaits: everything queued so far, then us.
    const tail = previous.then(() => done);
    this.tails.set(key, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Drop the entry only if nobody queued behind us — otherwise a later caller would stop
      // waiting on the chain and lose its ordering guarantee.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
