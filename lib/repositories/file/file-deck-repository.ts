/**
 * CLAUDE.md §2 step 5 — file-backed `DeckRepository`, one file per slide (SPEC §4.3).
 *
 * Two things here are load-bearing and not cosmetic:
 *  - **`meta.json` is locked for read-modify-write.** `updateMeta` patches fields, and generation
 *    writes the outline while a user may be editing the briefing. Atomic writes alone prevent
 *    corruption, not lost updates — the lock is what makes the concurrency test in the contract
 *    suite pass.
 *  - **`reorderSlides` validates the whole permutation before writing anything.** A partial
 *    reorder would leave duplicate `order` values on disk, and `listSlides` could then return a
 *    non-deterministic order. It is not fully atomic across files (no filesystem primitive gives
 *    us that), but validating first makes a partial apply reachable only via mid-operation crash,
 *    and the tie-break on id keeps even that state deterministic.
 */

import type { DeckRepository } from "@/lib/ports/repositories";
import type { DeckMeta, DeckSummary, Slide } from "@/lib/domain/deck";
import { DeckNotFound, InvalidSlideOrder } from "@/lib/errors/errors";
import { DataPaths } from "@/lib/repositories/file/paths";
import {
  KeyedMutex, listDir, readJsonFile, removeDir, removeFile, writeJsonFile,
} from "@/lib/repositories/file/fs-util";

export class FileDeckRepository implements DeckRepository {
  private readonly paths: DataPaths;
  private readonly locks = new KeyedMutex();

  constructor(dataDir: string) {
    this.paths = new DataPaths(dataDir);
  }

  private async requireMeta(userId: string, deckId: string): Promise<DeckMeta> {
    const meta = await readJsonFile<DeckMeta>(this.paths.deckMetaFile(userId, deckId));
    if (!meta) throw DeckNotFound(deckId);
    return meta;
  }

  async create(userId: string, deck: DeckMeta): Promise<DeckMeta> {
    const meta: DeckMeta = { ...deck, userId };
    const file = this.paths.deckMetaFile(userId, meta.id);
    await this.locks.withLock(file, () => writeJsonFile(file, meta));
    return meta;
  }

  async getMeta(userId: string, deckId: string): Promise<DeckMeta | null> {
    return readJsonFile<DeckMeta>(this.paths.deckMetaFile(userId, deckId));
  }

  async list(userId: string): Promise<DeckSummary[]> {
    const ids = await listDir(this.paths.decksDir(userId));
    const summaries = await Promise.all(ids.map(async (deckId): Promise<DeckSummary | null> => {
      const meta = await readJsonFile<DeckMeta>(this.paths.deckMetaFile(userId, deckId));
      if (!meta) return null;
      const slideFiles = (await listDir(this.paths.slidesDir(userId, deckId)))
        .filter((n) => n.endsWith(".json"));
      return {
        id: meta.id,
        title: meta.title,
        brandId: meta.brandId,
        slideCount: slideFiles.length,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      };
    }));
    return summaries
      .filter((s): s is DeckSummary => s !== null)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async updateMeta(
    userId: string,
    deckId: string,
    patch: Partial<Omit<DeckMeta, "id" | "userId" | "createdAt">>,
  ): Promise<DeckMeta> {
    const file = this.paths.deckMetaFile(userId, deckId);
    return this.locks.withLock(file, async () => {
      const existing = await readJsonFile<DeckMeta>(file);
      if (!existing) throw DeckNotFound(deckId);
      // Drop `undefined` values so a partial payload can't erase state it never meant to touch.
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ) as Partial<DeckMeta>;
      const next: DeckMeta = { ...existing, ...defined, id: existing.id, userId, createdAt: existing.createdAt };
      await writeJsonFile(file, next);
      return next;
    });
  }

  async delete(userId: string, deckId: string): Promise<void> {
    // Removing the deck directory cascades to slides — the same semantics as the memory impl.
    await removeDir(this.paths.deckDir(userId, deckId));
  }

  async listSlides(userId: string, deckId: string): Promise<Slide[]> {
    await this.requireMeta(userId, deckId);
    const names = (await listDir(this.paths.slidesDir(userId, deckId))).filter((n) => n.endsWith(".json"));
    const slides = await Promise.all(
      names.map((n) => readJsonFile<Slide>(this.paths.slideFile(userId, deckId, n.slice(0, -5)))),
    );
    return slides
      .filter((s): s is Slide => s !== null)
      // Tie-break on id so equal `order` values still yield a stable, deterministic sequence.
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  }

  async getSlide(userId: string, deckId: string, slideId: string): Promise<Slide | null> {
    await this.requireMeta(userId, deckId);
    return readJsonFile<Slide>(this.paths.slideFile(userId, deckId, slideId));
  }

  async putSlide(userId: string, deckId: string, slide: Slide): Promise<Slide> {
    await this.requireMeta(userId, deckId);
    const file = this.paths.slideFile(userId, deckId, slide.id);
    // Per-SLIDE lock: concurrent writes to different slides proceed in parallel (that's the whole
    // point of one file per slide), while two writes to the same slide serialize.
    await this.locks.withLock(file, () => writeJsonFile(file, slide));
    return slide;
  }

  async deleteSlide(userId: string, deckId: string, slideId: string): Promise<void> {
    await this.requireMeta(userId, deckId);
    const file = this.paths.slideFile(userId, deckId, slideId);
    await this.locks.withLock(file, () => removeFile(file));
  }

  async reorderSlides(userId: string, deckId: string, orderedIds: string[]): Promise<void> {
    await this.requireMeta(userId, deckId);
    // Lock the DECK, not each slide: a reorder must not interleave with another reorder. Note the
    // deliberate limit — a concurrent `putSlide` takes a per-slide lock, so it can still land
    // mid-reorder. That is acceptable because `putSlide` carries its own `order` from a client
    // that just read the deck, and the id tie-break above keeps the result deterministic either way.
    await this.locks.withLock(this.paths.deckDir(userId, deckId), async () => {
      const existing = await this.listSlides(userId, deckId);
      const byId = new Map(existing.map((s) => [s.id, s]));

      const missing = orderedIds.filter((id) => !byId.has(id));
      if (missing.length > 0) throw InvalidSlideOrder("unknown slide id", { missing });
      if (new Set(orderedIds).size !== orderedIds.length) throw InvalidSlideOrder("duplicate slide id");
      if (orderedIds.length !== byId.size) {
        throw InvalidSlideOrder("must list every slide in the deck", {
          given: orderedIds.length, expected: byId.size,
        });
      }

      // Validated above, so every write below is expected to succeed.
      await Promise.all(orderedIds.map((id, index) => {
        const file = this.paths.slideFile(userId, deckId, id);
        return writeJsonFile(file, { ...byId.get(id)!, order: index });
      }));
    });
  }
}
