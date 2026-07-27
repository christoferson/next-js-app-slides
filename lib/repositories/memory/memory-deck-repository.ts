/**
 * CLAUDE.md §2 step 4 — in-memory `DeckRepository`.
 *
 * Slides are stored in their OWN map keyed by slide id, not as an array on the deck. That mirrors
 * the item-per-slide storage model the port was designed for (SPEC §4.3), and it means this impl
 * exercises the same access patterns a DynamoDB impl will: point reads by slide id, a query
 * scoped to one deck, and an explicit reorder write.
 */

import type { DeckRepository } from "@/lib/ports/repositories";
import type { DeckMeta, DeckSummary, Slide } from "@/lib/domain/deck";
import { DeckNotFound, InvalidSlideOrder } from "@/lib/errors/errors";

const clone = <T>(value: T): T => structuredClone(value);

interface DeckEntry {
  meta: DeckMeta;
  slides: Map<string, Slide>;
}

function toSummary(entry: DeckEntry): DeckSummary {
  return {
    id: entry.meta.id,
    title: entry.meta.title,
    brandId: entry.meta.brandId,
    slideCount: entry.slides.size,
    createdAt: entry.meta.createdAt,
    updatedAt: entry.meta.updatedAt,
  };
}

export class MemoryDeckRepository implements DeckRepository {
  private readonly byUser = new Map<string, Map<string, DeckEntry>>();

  private bucket(userId: string): Map<string, DeckEntry> {
    let b = this.byUser.get(userId);
    if (!b) {
      b = new Map();
      this.byUser.set(userId, b);
    }
    return b;
  }

  /** Every slide operation must fail loudly on a missing deck rather than create one implicitly. */
  private requireDeck(userId: string, deckId: string): DeckEntry {
    const entry = this.byUser.get(userId)?.get(deckId);
    if (!entry) throw DeckNotFound(deckId);
    return entry;
  }

  async create(userId: string, deck: DeckMeta): Promise<DeckMeta> {
    const meta: DeckMeta = { ...clone(deck), userId };
    this.bucket(userId).set(meta.id, { meta, slides: new Map() });
    return clone(meta);
  }

  async getMeta(userId: string, deckId: string): Promise<DeckMeta | null> {
    const entry = this.byUser.get(userId)?.get(deckId);
    return entry ? clone(entry.meta) : null;
  }

  async list(userId: string): Promise<DeckSummary[]> {
    const bucket = this.byUser.get(userId);
    if (!bucket) return [];
    return [...bucket.values()]
      .map(toSummary)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async updateMeta(
    userId: string,
    deckId: string,
    patch: Partial<Omit<DeckMeta, "id" | "userId" | "createdAt">>,
  ): Promise<DeckMeta> {
    const entry = this.requireDeck(userId, deckId);
    // Field-level merge, NOT replace: a briefing edit racing an outline write must not clobber
    // the other's field. `undefined` values in the patch are dropped so a partial payload can't
    // erase state it never intended to touch.
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as Partial<DeckMeta>;
    const next: DeckMeta = { ...entry.meta, ...clone(defined) };
    entry.meta = next;
    return clone(next);
  }

  async delete(userId: string, deckId: string): Promise<void> {
    // Cascade is implicit — slides live inside the entry (§6: "delete cascade").
    this.byUser.get(userId)?.delete(deckId);
  }

  async listSlides(userId: string, deckId: string): Promise<Slide[]> {
    const entry = this.requireDeck(userId, deckId);
    return [...entry.slides.values()]
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
      .map(clone);
  }

  async getSlide(userId: string, deckId: string, slideId: string): Promise<Slide | null> {
    const entry = this.requireDeck(userId, deckId);
    const slide = entry.slides.get(slideId);
    return slide ? clone(slide) : null;
  }

  async putSlide(userId: string, deckId: string, slide: Slide): Promise<Slide> {
    const entry = this.requireDeck(userId, deckId);
    const stored = clone(slide);
    entry.slides.set(stored.id, stored);
    return clone(stored);
  }

  async deleteSlide(userId: string, deckId: string, slideId: string): Promise<void> {
    const entry = this.requireDeck(userId, deckId);
    entry.slides.delete(slideId);
  }

  async reorderSlides(userId: string, deckId: string, orderedIds: string[]): Promise<void> {
    const entry = this.requireDeck(userId, deckId);
    // Validate the WHOLE request before mutating anything: a partial reorder would leave
    // duplicate `order` values, and `listSlides` could then return a non-deterministic order.
    const missing = orderedIds.filter((id) => !entry.slides.has(id));
    if (missing.length > 0) throw InvalidSlideOrder("unknown slide id", { missing });
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw InvalidSlideOrder("duplicate slide id");
    }
    // A reorder that omits slides would strand them at stale order values, so require a full
    // permutation rather than accepting a partial list.
    if (orderedIds.length !== entry.slides.size) {
      throw InvalidSlideOrder("must list every slide in the deck", {
        given: orderedIds.length, expected: entry.slides.size,
      });
    }
    orderedIds.forEach((id, index) => {
      const slide = entry.slides.get(id)!;
      entry.slides.set(id, { ...slide, order: index });
    });
  }
}
