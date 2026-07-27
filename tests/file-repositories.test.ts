/**
 * §6.2 — the SAME contract suite as `memory-repositories.test.ts`, against the file backend.
 * Both green is the claim; the suite is imported, never copied.
 *
 * Plus §6.5's file-specific tests: things only this impl can get wrong (atomic writes, path
 * traversal, on-disk layout). Those deliberately do NOT live in the shared suite.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assetStoreContract, brandRepositoryContract, deckRepositoryContract } from "@/tests/repository-contract";
import { FileBrandRepository } from "@/lib/repositories/file/file-brand-repository";
import { FileDeckRepository } from "@/lib/repositories/file/file-deck-repository";
import { LocalDiskAssetStore } from "@/lib/adapters/local-disk-asset-store";
import { KeyedMutex, UnsafePathSegmentError, safeJoin, writeFileAtomic } from "@/lib/repositories/file/fs-util";
import { makeBrand, makeDeck, makeSlide } from "@/tests/fixtures";

const roots: string[] = [];

/** A fresh DATA_DIR per test, so no test can observe another's state. */
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-studio-test-"));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

brandRepositoryContract("file", async () => new FileBrandRepository(await freshDir()));
deckRepositoryContract("file", async () => new FileDeckRepository(await freshDir()));
assetStoreContract("file", async () => new LocalDiskAssetStore(await freshDir()));

/* ───────────────── §6.5 — file-impl specifics (not part of the shared contract) ───────────────── */

describe("file backend specifics", () => {
  it("rejects crafted ids at the path builder, before any IO", async () => {
    const root = await freshDir();
    const brands = new FileBrandRepository(root);
    const decks = new FileDeckRepository(root);
    const crafted = ["../../etc/passwd", "..", ".", "a/b", "a\\b", "C:\\Windows", "x\0y", ""];

    for (const id of crafted) {
      await expect(brands.get("user-a", id)).rejects.toThrow(UnsafePathSegmentError);
      await expect(decks.getMeta("user-a", id)).rejects.toThrow(UnsafePathSegmentError);
      // A crafted USER id must be rejected too — it is the partition key.
      await expect(brands.list(id)).rejects.toThrow(UnsafePathSegmentError);
    }
  });

  it("does not leak the crafted id in the error message", async () => {
    // The value is attacker-controlled; it belongs in logs, not in a thrown message.
    expect(() => safeJoin("/data", "../../secret")).toThrow(/unsafe storage id/i);
    try {
      safeJoin("/data", "../../secret");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret");
    }
  });

  it("stores one file per slide under the deck (mirrors the DynamoDB item-per-slide model)", async () => {
    const root = await freshDir();
    const repo = new FileDeckRepository(root);
    const deck = await repo.create("user-a", makeDeck({ userId: "user-a" }));
    const slide = await repo.putSlide("user-a", deck.id, makeSlide());

    const slideFile = path.join(root, "users", "user-a", "decks", deck.id, "slides", `${slide.id}.json`);
    await expect(readFile(slideFile, "utf8")).resolves.toContain(slide.id);
  });

  it("writes atomically: a reader never sees a partial file", async () => {
    const root = await freshDir();
    const target = path.join(root, "atomic.json");
    // 2 MB — large enough that a naive write would be observable mid-flight.
    const big = JSON.stringify({ pad: "x".repeat(2_000_000) });
    await writeFile(target, JSON.stringify({ pad: "old" }));

    const write = writeFileAtomic(target, big);
    // Read concurrently: the rename means we get either the old file or the new one, never a
    // truncated one — so JSON.parse must always succeed.
    const reads = await Promise.all(Array.from({ length: 20 }, () => readFile(target, "utf8")));
    await write;
    for (const content of reads) expect(() => JSON.parse(content)).not.toThrow();
    expect(JSON.parse(await readFile(target, "utf8")).pad).toHaveLength(2_000_000);
  });

  it("leaves no temp files behind", async () => {
    const root = await freshDir();
    const repo = new FileBrandRepository(root);
    const brand = makeBrand({ userId: "user-a" });
    await repo.create("user-a", brand);
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(path.join(root, "users", "user-a", "brands"));
    expect(names.filter((n) => n.startsWith(".tmp-"))).toEqual([]);
    expect(names).toEqual([`${brand.id}.json`]);
  });

  it("serializes same-key work and parallelizes different keys (KeyedMutex)", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const slow = async (label: string, ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(label);
    };
    await Promise.all([
      mutex.withLock("k", () => slow("a", 20)),
      mutex.withLock("k", () => slow("b", 1)),
      mutex.withLock("other", () => slow("c", 1)),
    ]);
    // "a" holds the lock for 20ms, so "b" must land after it despite being far quicker.
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    // A different key is not blocked by the slow one.
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("a"));
  });

  it("keeps the lock usable after a critical section throws", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.withLock("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(mutex.withLock("k", async () => "ok")).resolves.toBe("ok");
  });
});
