/**
 * CLAUDE.md §2 step 3 — the repository PORTS. Written before any implementation, deliberately:
 * these interfaces ARE the swap contract (SPEC §4.3), and an interface designed after an impl
 * inevitably leaks that impl's assumptions.
 *
 * Hygiene rules these signatures must keep satisfying (CLAUDE.md §6.4 — acceptance-tested):
 *  - Every access pattern is `(userId)` or `(userId, id[, id])` → maps directly to a DynamoDB
 *    PK/SK. There is no list-all, no cross-user query, no filter predicate.
 *  - No method takes or returns a filesystem path, a directory, or a file handle.
 *  - No sync IO: every method returns a Promise.
 *  - Ids are generated app-side (ULID) so no impl owns identity generation.
 *  - `get*` returns `null` for absent, and does NOT throw — mapping absence to
 *    `BrandNotFound`/`DeckNotFound` is a SERVICE decision, so both impls behave identically.
 */

import type { BrandDefinition, BrandSummary } from "@/lib/brand/types";
import type { DeckMeta, DeckSummary, Slide } from "@/lib/domain/deck";

export interface BrandRepository {
  create(userId: string, brand: BrandDefinition): Promise<BrandDefinition>;
  get(userId: string, brandId: string): Promise<BrandDefinition | null>;
  /** Summaries, not full configs — the gallery must not load every template. */
  list(userId: string): Promise<BrandSummary[]>;
  /** Full replace (the editor and JSON import both submit whole configs). */
  update(userId: string, brandId: string, brand: BrandDefinition): Promise<BrandDefinition>;
  delete(userId: string, brandId: string): Promise<void>;
}

/**
 * Slides are FIRST-CLASS and individually addressable (SPEC §4.3). This is the single most
 * important shape decision in the storage layer: a DynamoDB impl stores one item per slide
 * (PK=userId#deckId, SK=slide#order) rather than one oversized deck blob against the 400 KB
 * item limit — and the file impl mirrors it with one file per slide so both share semantics.
 */
export interface DeckRepository {
  create(userId: string, deck: DeckMeta): Promise<DeckMeta>;
  /** Title, brandId, briefing, outline — never the slides. */
  getMeta(userId: string, deckId: string): Promise<DeckMeta | null>;
  list(userId: string): Promise<DeckSummary[]>;
  /**
   * Partial patch, applied atomically. Patch semantics (not full replace) because concurrent
   * writers are real here: a briefing edit must not clobber an outline written by generation.
   * `id`/`userId`/`createdAt` are not patchable.
   */
  updateMeta(
    userId: string,
    deckId: string,
    patch: Partial<Omit<DeckMeta, "id" | "userId" | "createdAt">>,
  ): Promise<DeckMeta>;
  /** Cascades: slides go with the deck. */
  delete(userId: string, deckId: string): Promise<void>;

  /** Ordered by `Slide.order` ascending. */
  listSlides(userId: string, deckId: string): Promise<Slide[]>;
  getSlide(userId: string, deckId: string, slideId: string): Promise<Slide | null>;
  /** Upsert by `slide.id`. Concurrent calls for distinct slides must not clobber (§6.5). */
  putSlide(userId: string, deckId: string, slide: Slide): Promise<Slide>;
  deleteSlide(userId: string, deckId: string, slideId: string): Promise<void>;
  /**
   * Rewrites `order` to match `orderedIds`. Must be all-or-nothing: a partial reorder would
   * leave duplicate order values that `listSlides` cannot resolve deterministically.
   */
  reorderSlides(userId: string, deckId: string, orderedIds: string[]): Promise<void>;
}
