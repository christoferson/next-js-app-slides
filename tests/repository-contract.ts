/**
 * CLAUDE.md §6.1 — THE shared repository contract suite.
 *
 * One suite, run against EVERY backend (§6.2). This file must contain no knowledge of how any
 * impl stores data: no paths, no `fs`, no Map internals. If a test needs such knowledge, the
 * behaviour it checks is impl-specific and belongs in that impl's own test file (e.g. atomic
 * writes, path traversal — §6.5).
 *
 * The suite is exported as functions taking a FACTORY, because each test needs a pristine
 * backend and a file impl needs a fresh temp directory per test.
 */

import { describe, expect, it } from "vitest";
import type { AssetStore, BrandRepository, DeckRepository } from "@/lib/ports";
import { AppError } from "@/lib/errors/errors";
import { makeAssetMeta, makeBrand, makeDeck, makeSlide } from "@/tests/fixtures";

const USER_A = "user-a";
const USER_B = "user-b";

/** Async so a file-backed factory can create its temp dir. */
export type Factory<T> = () => Promise<T>;

/* ───────────────────────────────── BrandRepository ───────────────────────────────── */

export function brandRepositoryContract(name: string, factory: Factory<BrandRepository>): void {
  describe(`BrandRepository contract — ${name}`, () => {
    it("creates and reads back a brand", async () => {
      const repo = await factory();
      const brand = makeBrand({ userId: USER_A });
      const created = await repo.create(USER_A, brand);
      expect(created.id).toBe(brand.id);
      await expect(repo.get(USER_A, brand.id)).resolves.toEqual(created);
    });

    it("returns null for an unknown brand rather than throwing", async () => {
      const repo = await factory();
      await expect(repo.get(USER_A, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).resolves.toBeNull();
    });

    it("scopes reads by user: A cannot read B's brand", async () => {
      const repo = await factory();
      const brand = makeBrand({ userId: USER_B });
      await repo.create(USER_B, brand);
      await expect(repo.get(USER_A, brand.id)).resolves.toBeNull();
      await expect(repo.list(USER_A)).resolves.toEqual([]);
    });

    it("forces the caller's userId onto the stored record", async () => {
      const repo = await factory();
      // A client-supplied userId must never place data in another user's partition.
      const brand = makeBrand({ userId: USER_B });
      const created = await repo.create(USER_A, brand);
      expect(created.userId).toBe(USER_A);
      await expect(repo.get(USER_B, brand.id)).resolves.toBeNull();
    });

    it("lists summaries, not full configs", async () => {
      const repo = await factory();
      const brand = makeBrand({ userId: USER_A, name: "Listed" });
      await repo.create(USER_A, brand);
      const [summary] = await repo.list(USER_A);
      expect(summary?.name).toBe("Listed");
      expect(summary?.templatedLayoutIds).toEqual(["title"]);
      expect(summary).not.toHaveProperty("templates");
      expect(summary).not.toHaveProperty("tone");
    });

    it("updates in place, preserving id/userId/createdAt", async () => {
      const repo = await factory();
      const brand = await repo.create(USER_A, makeBrand({ userId: USER_A }));
      const updated = await repo.update(USER_A, brand.id, {
        ...brand, name: "Renamed", createdAt: "1999-01-01T00:00:00.000Z", userId: USER_B,
      });
      expect(updated.name).toBe("Renamed");
      expect(updated.id).toBe(brand.id);
      expect(updated.userId).toBe(USER_A);
      expect(updated.createdAt).toBe(brand.createdAt);
    });

    it("refuses to update a brand that does not exist (no silent create)", async () => {
      const repo = await factory();
      const ghost = makeBrand({ userId: USER_A });
      await expect(repo.update(USER_A, ghost.id, ghost)).rejects.toThrow(AppError);
      await expect(repo.get(USER_A, ghost.id)).resolves.toBeNull();
    });

    it("refuses to update across users", async () => {
      const repo = await factory();
      const brand = await repo.create(USER_B, makeBrand({ userId: USER_B }));
      await expect(repo.update(USER_A, brand.id, brand)).rejects.toThrow(AppError);
      // B's data is untouched.
      await expect(repo.get(USER_B, brand.id)).resolves.toEqual(brand);
    });

    it("deletes, and deleting twice is a no-op", async () => {
      const repo = await factory();
      const brand = await repo.create(USER_A, makeBrand({ userId: USER_A }));
      await repo.delete(USER_A, brand.id);
      await expect(repo.get(USER_A, brand.id)).resolves.toBeNull();
      await expect(repo.delete(USER_A, brand.id)).resolves.toBeUndefined();
    });

    it("does not let a returned object mutate stored state", async () => {
      const repo = await factory();
      const brand = await repo.create(USER_A, makeBrand({ userId: USER_A }));
      const got = (await repo.get(USER_A, brand.id))!;
      got.name = "MUTATED";
      got.colors.primary = "#000000";
      const again = (await repo.get(USER_A, brand.id))!;
      expect(again.name).toBe(brand.name);
      expect(again.colors.primary).toBe(brand.colors.primary);
    });
  });
}

/* ───────────────────────────────── DeckRepository ────────────────────────────────── */

export function deckRepositoryContract(name: string, factory: Factory<DeckRepository>): void {
  describe(`DeckRepository contract — ${name}`, () => {
    it("creates and reads deck meta", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      await expect(repo.getMeta(USER_A, deck.id)).resolves.toEqual(deck);
    });

    it("returns null for an unknown deck", async () => {
      const repo = await factory();
      await expect(repo.getMeta(USER_A, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).resolves.toBeNull();
    });

    it("scopes by user", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_B, makeDeck({ userId: USER_B }));
      await expect(repo.getMeta(USER_A, deck.id)).resolves.toBeNull();
      await expect(repo.list(USER_A)).resolves.toEqual([]);
    });

    it("patches meta field-wise without clobbering untouched fields", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      await repo.updateMeta(USER_A, deck.id, {
        briefing: { topic: "T", audience: "A", objective: "O", targetSlideCount: 8 },
      });
      const outline = { sections: [{ heading: "S", slides: [] }] };
      const after = await repo.updateMeta(USER_A, deck.id, { outline });
      // The outline write must NOT have dropped the briefing (§4.3's reason for patch semantics).
      expect(after.briefing?.topic).toBe("T");
      expect(after.outline).toEqual(outline);
      expect(after.title).toBe(deck.title);
    });

    it("ignores undefined patch values instead of erasing fields", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A, title: "Keep" }));
      const after = await repo.updateMeta(USER_A, deck.id, { title: undefined, brandId: "brand-2" });
      expect(after.title).toBe("Keep");
      expect(after.brandId).toBe("brand-2");
    });

    it("reports a deck summary with a slide count", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      await repo.putSlide(USER_A, deck.id, makeSlide({ order: 0 }));
      await repo.putSlide(USER_A, deck.id, makeSlide({ order: 1 }));
      const [summary] = await repo.list(USER_A);
      expect(summary?.slideCount).toBe(2);
      expect(summary).not.toHaveProperty("outline");
    });

    it("addresses slides individually and lists them in order", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      const b = await repo.putSlide(USER_A, deck.id, makeSlide({ order: 1, layoutId: "bullets" }));
      const a = await repo.putSlide(USER_A, deck.id, makeSlide({ order: 0, layoutId: "title" }));
      await expect(repo.listSlides(USER_A, deck.id)).resolves.toEqual([a, b]);
      await expect(repo.getSlide(USER_A, deck.id, b.id)).resolves.toEqual(b);
    });

    it("upserts a slide by id", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      const slide = await repo.putSlide(USER_A, deck.id, makeSlide());
      await repo.putSlide(USER_A, deck.id, { ...slide, slots: { title: "Edited" }, flags: ["trimmed"] });
      const slides = await repo.listSlides(USER_A, deck.id);
      expect(slides).toHaveLength(1);
      expect(slides[0]?.slots).toEqual({ title: "Edited" });
      expect(slides[0]?.flags).toEqual(["trimmed"]);
    });

    it("returns null for an unknown slide in a known deck", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      await expect(repo.getSlide(USER_A, deck.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).resolves.toBeNull();
    });

    it("deletes a single slide, leaving the rest", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      const a = await repo.putSlide(USER_A, deck.id, makeSlide({ order: 0 }));
      const b = await repo.putSlide(USER_A, deck.id, makeSlide({ order: 1 }));
      await repo.deleteSlide(USER_A, deck.id, a.id);
      await expect(repo.listSlides(USER_A, deck.id)).resolves.toEqual([b]);
    });

    it("rejects slide operations on a deck that does not exist", async () => {
      const repo = await factory();
      const ghost = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
      await expect(repo.listSlides(USER_A, ghost)).rejects.toThrow(AppError);
      await expect(repo.putSlide(USER_A, ghost, makeSlide())).rejects.toThrow(AppError);
      await expect(repo.getSlide(USER_A, ghost, "x")).rejects.toThrow(AppError);
    });

    it("cannot reach another user's slides", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_B, makeDeck({ userId: USER_B }));
      const slide = await repo.putSlide(USER_B, deck.id, makeSlide());
      await expect(repo.listSlides(USER_A, deck.id)).rejects.toThrow(AppError);
      await expect(repo.getSlide(USER_A, deck.id, slide.id)).rejects.toThrow(AppError);
    });

    it("reorders slides to match the given permutation", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      const a = await repo.putSlide(USER_A, deck.id, makeSlide({ order: 0 }));
      const b = await repo.putSlide(USER_A, deck.id, makeSlide({ order: 1 }));
      const c = await repo.putSlide(USER_A, deck.id, makeSlide({ order: 2 }));
      await repo.reorderSlides(USER_A, deck.id, [c.id, a.id, b.id]);
      const slides = await repo.listSlides(USER_A, deck.id);
      expect(slides.map((s) => s.id)).toEqual([c.id, a.id, b.id]);
      expect(slides.map((s) => s.order)).toEqual([0, 1, 2]);
    });

    it("rejects an invalid reorder atomically — order values stay intact", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      const a = await repo.putSlide(USER_A, deck.id, makeSlide({ order: 0 }));
      const b = await repo.putSlide(USER_A, deck.id, makeSlide({ order: 1 }));
      const before = await repo.listSlides(USER_A, deck.id);

      // unknown id / duplicate / partial list — each must change nothing.
      await expect(repo.reorderSlides(USER_A, deck.id, [a.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV"]))
        .rejects.toThrow(AppError);
      await expect(repo.reorderSlides(USER_A, deck.id, [a.id, a.id])).rejects.toThrow(AppError);
      await expect(repo.reorderSlides(USER_A, deck.id, [b.id])).rejects.toThrow(AppError);

      await expect(repo.listSlides(USER_A, deck.id)).resolves.toEqual(before);
    });

    it("cascades: deleting a deck removes its slides", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      await repo.putSlide(USER_A, deck.id, makeSlide());
      await repo.delete(USER_A, deck.id);
      await expect(repo.getMeta(USER_A, deck.id)).resolves.toBeNull();
      // The deck is gone, so slide access must fail rather than return orphans.
      await expect(repo.listSlides(USER_A, deck.id)).rejects.toThrow(AppError);
    });

    it("does not let returned slides mutate stored state", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      const slide = await repo.putSlide(USER_A, deck.id, makeSlide({ slots: { title: "Orig" } }));
      const got = (await repo.getSlide(USER_A, deck.id, slide.id))!;
      (got.slots as Record<string, string>).title = "MUTATED";
      got.flags.push("fallback");
      const again = (await repo.getSlide(USER_A, deck.id, slide.id))!;
      expect(again.slots.title).toBe("Orig");
      expect(again.flags).toEqual([]);
    });

    it("keeps concurrent putSlide calls from clobbering each other", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      const slides = Array.from({ length: 8 }, (_, i) => makeSlide({ order: i }));
      // §6.5: the file impl must survive this via atomic write + lock; memory passes trivially.
      await Promise.all(slides.map((s) => repo.putSlide(USER_A, deck.id, s)));
      const stored = await repo.listSlides(USER_A, deck.id);
      expect(stored.map((s) => s.id).sort()).toEqual(slides.map((s) => s.id).sort());
    });

    it("keeps concurrent updateMeta calls from losing writes", async () => {
      const repo = await factory();
      const deck = await repo.create(USER_A, makeDeck({ userId: USER_A }));
      await Promise.all([
        repo.updateMeta(USER_A, deck.id, { title: "T1" }),
        repo.updateMeta(USER_A, deck.id, { brandId: "brand-9" }),
        repo.updateMeta(USER_A, deck.id, {
          briefing: { topic: "T", audience: "A", objective: "O", targetSlideCount: 5 },
        }),
      ]);
      const after = (await repo.getMeta(USER_A, deck.id))!;
      // Every field written must be present — a read-modify-write race would drop one.
      expect(after.brandId).toBe("brand-9");
      expect(after.title).toBe("T1");
      expect(after.briefing?.topic).toBe("T");
    });
  });
}

/* ─────────────────────────────────── AssetStore ──────────────────────────────────── */

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
};

export function assetStoreContract(name: string, factory: Factory<AssetStore>): void {
  describe(`AssetStore contract — ${name}`, () => {
    const BYTES = new Uint8Array([1, 2, 3, 4]);

    it("stores bytes and streams them back unchanged", async () => {
      const store = await factory();
      const { assetId } = await store.put(USER_A, "background", BYTES, makeAssetMeta());
      const asset = await store.getStream(USER_A, assetId);
      expect(asset.contentType).toBe("image/png");
      expect(asset.byteSize).toBe(4);
      await expect(readAll(asset.body)).resolves.toEqual(BYTES);
    });

    it("generates the asset id itself", async () => {
      const store = await factory();
      const a = await store.put(USER_A, "background", BYTES, makeAssetMeta());
      const b = await store.put(USER_A, "background", BYTES, makeAssetMeta());
      expect(a.assetId).not.toBe(b.assetId);
      expect(a.assetId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it("returns metadata without bytes, and null when absent", async () => {
      const store = await factory();
      const { assetId } = await store.put(USER_A, "logo", BYTES, makeAssetMeta({ kind: "logo" }));
      const meta = await store.getMeta(USER_A, assetId);
      expect(meta?.kind).toBe("logo");
      expect(meta?.width).toBe(1920);
      expect(meta).not.toHaveProperty("bytes");
      await expect(store.getMeta(USER_A, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).resolves.toBeNull();
    });

    it("trusts the kind argument over the payload's", async () => {
      const store = await factory();
      const { assetId } = await store.put(USER_A, "logo", BYTES, makeAssetMeta({ kind: "background" }));
      await expect(store.getMeta(USER_A, assetId)).resolves.toMatchObject({ kind: "logo" });
    });

    it("resolves a URL, never a filesystem path (§6.4)", async () => {
      const store = await factory();
      const { assetId } = await store.put(USER_A, "background", BYTES, makeAssetMeta());
      const url = await store.resolveUrl(USER_A, assetId);
      expect(url.startsWith("/")).toBe(true);
      expect(url).not.toMatch(/[A-Za-z]:\\|\.\.|\/tmp\/|\\\\/);
      expect(url).toContain(assetId);
    });

    it("resolves bytes only when asked", async () => {
      const store = await factory();
      const { assetId } = await store.put(USER_A, "background", BYTES, makeAssetMeta());
      await expect(store.resolve(USER_A, assetId)).resolves.not.toHaveProperty("bytes");
      const withBytes = await store.resolve(USER_A, assetId, { withBytes: true });
      expect(withBytes.bytes).toEqual(BYTES);
      expect(withBytes.width).toBe(1920);
    });

    it("scopes by user", async () => {
      const store = await factory();
      const { assetId } = await store.put(USER_B, "background", BYTES, makeAssetMeta());
      await expect(store.getMeta(USER_A, assetId)).resolves.toBeNull();
      await expect(store.getStream(USER_A, assetId)).rejects.toThrow(AppError);
      await expect(store.resolve(USER_A, assetId)).rejects.toThrow(AppError);
    });

    it("throws AssetNotFound for a missing asset, and delete is idempotent", async () => {
      const store = await factory();
      const { assetId } = await store.put(USER_A, "background", BYTES, makeAssetMeta());
      await store.delete(USER_A, assetId);
      await expect(store.getStream(USER_A, assetId)).rejects.toThrow(AppError);
      await expect(store.delete(USER_A, assetId)).resolves.toBeUndefined();
    });

    it("copies input bytes so later caller mutation cannot corrupt storage", async () => {
      const store = await factory();
      const mutable = new Uint8Array([9, 9, 9, 9]);
      const { assetId } = await store.put(USER_A, "background", mutable, makeAssetMeta());
      mutable[0] = 0;
      const asset = await store.getStream(USER_A, assetId);
      await expect(readAll(asset.body)).resolves.toEqual(new Uint8Array([9, 9, 9, 9]));
    });
  });
}
