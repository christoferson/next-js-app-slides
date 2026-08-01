/**
 * `DeckService` — deck CRUD, briefing, and the workspace slide edits (SPEC §7.4).
 *
 * ## What is business logic here, and what is not
 *
 * Storage is the repository's. What this layer owns is everything that has to be *true across* the
 * per-slide records the repository stores individually:
 *
 *   - `order` is dense and contiguous. Nothing else guarantees that — `putSlide` writes whatever order
 *     it is handed, so duplicate or gapped values are only impossible if one layer assigns them.
 *   - A layout change carries slots across best-effort rather than blanking the slide (§7.4).
 *   - A slide edit re-validates against the *layout's* budgets, so a hand-typed 400-character title is
 *     truncated and flagged exactly like a model-generated one. §1.1/C1 is why: `fit:'shrink'` never
 *     shrinks, so an over-budget string silently overflows the box in PowerPoint. Truncation is the
 *     only guard, and it cannot be the generation path's alone.
 *
 * ## Brand swap
 *
 * `setBrand` writes one field and touches no slide. That is the entire feature (SPEC §13: "re-render
 * check; content unchanged") and it only works because slides store `layoutId` + `slots` and *nothing*
 * appearance-derived — no resolved colours, no computed zones. If a slide ever cached a token, this
 * method would have to rewrite every slide and the guarantee would quietly become a migration.
 */

import type { DeckRepository } from "@/lib/ports";
import type { Briefing, DeckMeta, DeckSummary, Outline, Slide } from "@/lib/domain/deck";
import type { SlotValues } from "@/lib/domain/slots";
import type { QualityFlag } from "@/lib/stream/events";
import {
  DeckNotFound, InvalidSlideContent, InvalidSlideOrder, SlideNotFound, UnknownLayout,
} from "@/lib/errors/errors";
import { LAYOUTS, findLayout, requireLayout } from "@/lib/layouts/registry";
import { type SlideLayout } from "@/lib/layouts/types";
import { checkSlotBudgets, describeSlotIssues, normalizeSlots } from "@/lib/layouts/validate";
import { isListSlot } from "@/lib/domain/slots";

export interface DeckServiceDeps {
  decks: DeckRepository;
  now: () => number;
  newId: () => string;
}

/** A workspace slide edit (SPEC §7.4). Every field optional — the UI patches one thing at a time. */
export interface SlidePatch {
  slots?: SlotValues;
  layoutId?: string;
  speakerNotes?: string;
}

export class DeckService {
  constructor(private readonly deps: DeckServiceDeps) {}

  /* ─────────────────────────────── deck ─────────────────────────────── */

  async create(userId: string, input: { title: string; brandId: string; briefing?: Briefing }): Promise<DeckMeta> {
    const at = this.stamp();
    return this.deps.decks.create(userId, {
      id: this.deps.newId(),
      userId,
      title: input.title,
      brandId: input.brandId,
      ...(input.briefing !== undefined ? { briefing: input.briefing } : {}),
      createdAt: at,
      updatedAt: at,
    });
  }

  /** Absence → `DeckNotFound` here, for the reason given in `BrandService.get`. */
  async getMeta(userId: string, deckId: string): Promise<DeckMeta> {
    const meta = await this.deps.decks.getMeta(userId, deckId);
    if (!meta) throw DeckNotFound(deckId);
    return meta;
  }

  list(userId: string): Promise<DeckSummary[]> {
    return this.deps.decks.list(userId);
  }

  /** Meta + slides in one call — what the workspace loads. */
  async getFull(userId: string, deckId: string): Promise<{ meta: DeckMeta; slides: Slide[] }> {
    const meta = await this.getMeta(userId, deckId);
    return { meta, slides: await this.deps.decks.listSlides(userId, deckId) };
  }

  /**
   * Patch the deck's own fields. Deliberately narrow: `title`, `brandId`, `briefing`, `outline` are the
   * only patchable things, and each has a named method rather than a generic passthrough — a
   * `Partial<DeckMeta>` parameter here is how `userId` eventually becomes writable by a request body.
   */
  setTitle(userId: string, deckId: string, title: string): Promise<DeckMeta> {
    return this.patch(userId, deckId, { title });
  }

  setBriefing(userId: string, deckId: string, briefing: Briefing): Promise<DeckMeta> {
    return this.patch(userId, deckId, { briefing });
  }

  saveOutline(userId: string, deckId: string, outline: Outline): Promise<DeckMeta> {
    return this.patch(userId, deckId, { outline });
  }

  /** SPEC §13's brand swap: one field, zero slide writes. See the header. */
  setBrand(userId: string, deckId: string, brandId: string): Promise<DeckMeta> {
    return this.patch(userId, deckId, { brandId });
  }

  delete(userId: string, deckId: string): Promise<void> {
    // Cascade to slides is the repository's contract (§6), asserted by the shared contract suite.
    return this.deps.decks.delete(userId, deckId);
  }

  /* ─────────────────────────────── slides ─────────────────────────────── */

  listSlides(userId: string, deckId: string): Promise<Slide[]> {
    return this.deps.decks.listSlides(userId, deckId);
  }

  async getSlide(userId: string, deckId: string, slideId: string): Promise<Slide> {
    const slide = await this.deps.decks.getSlide(userId, deckId, slideId);
    if (!slide) throw SlideNotFound(slideId);
    return slide;
  }

  /**
   * Append a slide. `order` is assigned from the current count, never accepted from the caller — see
   * the header on why density is this layer's job.
   */
  async addSlide(
    userId: string, deckId: string, input: { layoutId: string; slots: SlotValues; speakerNotes?: string },
  ): Promise<Slide> {
    await this.getMeta(userId, deckId);
    const layout = this.requireKnownLayout(input.layoutId);
    this.assertWithinBudgets(layout, input.slots, Object.keys(input.slots));
    const existing = await this.deps.decks.listSlides(userId, deckId);
    const normalized = normalizeSlots(layout, input.slots);
    const at = this.stamp();

    return this.deps.decks.putSlide(userId, deckId, {
      id: this.deps.newId(),
      order: existing.length,
      layoutId: layout.id,
      slots: normalized.slots,
      ...(input.speakerNotes !== undefined ? { speakerNotes: input.speakerNotes } : {}),
      flags: flagsFor(normalized),
      createdAt: at,
      updatedAt: at,
    });
  }

  /**
   * Edit a slide (SPEC §7.4). Slots are re-validated and re-flagged on every write.
   *
   * The `flags` recomputation matters in both directions: a user who *fixes* an over-long title must
   * lose the amber `trimmed` badge, and a stale badge on corrected content is worse than no badge —
   * it teaches the user to ignore them.
   *
   * A layout change is handled through `carryOverSlots` so the two paths cannot disagree about what
   * "same slots, new layout" means.
   */
  async updateSlide(userId: string, deckId: string, slideId: string, patch: SlidePatch): Promise<Slide> {
    const slide = await this.getSlide(userId, deckId, slideId);

    const layout = patch.layoutId !== undefined
      ? this.requireKnownLayout(patch.layoutId)
      : requireLayout(slide.layoutId);

    // Slots are carried over first when the layout changed, so an edit that ALSO switches layout
    // applies the incoming values on top of the carry-over rather than being discarded by it.
    const base = patch.layoutId !== undefined && patch.layoutId !== slide.layoutId
      ? carryOverSlots(requireLayout(slide.layoutId), layout, slide.slots)
      : slide.slots;
    const merged = patch.slots !== undefined ? { ...base, ...patch.slots } : base;

    // Only the keys in THIS patch are the user's typing — see `assertWithinBudgets`.
    if (patch.slots !== undefined) {
      this.assertWithinBudgets(layout, merged, Object.keys(patch.slots));
    }

    const normalized = normalizeSlots(layout, merged);

    return this.deps.decks.putSlide(userId, deckId, {
      ...slide,
      layoutId: layout.id,
      slots: normalized.slots,
      ...(patch.speakerNotes !== undefined ? { speakerNotes: patch.speakerNotes } : {}),
      flags: flagsFor(normalized, slide.flags),
      updatedAt: this.stamp(),
    });
  }

  /**
   * Duplicate a slide, inserted directly after the original.
   *
   * Inserting adjacent rather than appending is the whole point of the feature — a user duplicating
   * slide 3 to make a variant does not want it at position 12. That requires renumbering, which is why
   * this goes through `reorder` rather than a bare `putSlide`.
   */
  async duplicateSlide(userId: string, deckId: string, slideId: string): Promise<Slide> {
    const slides = await this.deps.decks.listSlides(userId, deckId);
    const source = slides.find((s) => s.id === slideId);
    if (!source) throw SlideNotFound(slideId);

    const at = this.stamp();
    const copy: Slide = {
      ...structuredClone(source),
      id: this.deps.newId(),
      order: source.order + 1,
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.decks.putSlide(userId, deckId, copy);

    const ordered = [...slides.map((s) => s.id)];
    ordered.splice(slides.findIndex((s) => s.id === slideId) + 1, 0, copy.id);
    await this.deps.decks.reorderSlides(userId, deckId, ordered);

    return this.getSlide(userId, deckId, copy.id);
  }

  /**
   * Delete a slide and CLOSE THE GAP. Without the renumber, orders become `0,1,3` and every subsequent
   * insert-at-position computes from a wrong base — the kind of drift that only shows up as a slide
   * landing in the wrong place three edits later.
   */
  async deleteSlide(userId: string, deckId: string, slideId: string): Promise<void> {
    const slides = await this.deps.decks.listSlides(userId, deckId);
    if (!slides.some((s) => s.id === slideId)) throw SlideNotFound(slideId);

    await this.deps.decks.deleteSlide(userId, deckId, slideId);
    const remaining = slides.filter((s) => s.id !== slideId).map((s) => s.id);
    if (remaining.length > 0) {
      await this.deps.decks.reorderSlides(userId, deckId, remaining);
    }
  }

  /**
   * Reorder. The repository validates that `orderedIds` is a full permutation and applies it
   * all-or-nothing (§6.5); this method exists to give the route a deck-scoped 404 first, since the
   * repository would otherwise report a missing deck as an ordering problem.
   */
  async reorderSlides(userId: string, deckId: string, orderedIds: string[]): Promise<Slide[]> {
    await this.getMeta(userId, deckId);
    if (orderedIds.length === 0) throw InvalidSlideOrder("must list at least one slide");
    await this.deps.decks.reorderSlides(userId, deckId, orderedIds);
    return this.deps.decks.listSlides(userId, deckId);
  }

  /* ─────────────────────────────── internals ─────────────────────────────── */

  private stamp(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private patch(
    userId: string, deckId: string, fields: Partial<Omit<DeckMeta, "id" | "userId" | "createdAt">>,
  ): Promise<DeckMeta> {
    return this.deps.decks.updateMeta(userId, deckId, { ...fields, updatedAt: this.stamp() });
  }

  /**
   * A layout id from a request body is untrusted, so an unknown one is a 400 — not `requireLayout`'s
   * throw, which is an internal invariant failure (a *persisted* slide naming a removed layout) and
   * correctly surfaces as a 500.
   */
  private requireKnownLayout(layoutId: string): SlideLayout {
    const layout = findLayout(layoutId);
    if (!layout) throw UnknownLayout(layoutId, LAYOUTS.map((l) => l.id));
    return layout;
  }

  /**
   * Reject over-budget values in the slots the USER actually typed.
   *
   * The asymmetry with the generation path is deliberate, and it is why `validate.ts` carries an
   * `enforceBudgets` flag at all: a model's over-long output is truncated and flagged (spending the
   * repair call on cosmetics would be waste), a person's is rejected with the field named — silently
   * rewriting someone's typing is worse than telling them it does not fit.
   *
   * Scoped to `typedKeys` rather than the whole merged slot set, and that scoping is the point. A
   * layout switch can carry a 55-char title into a slot that allows 40; that overflow is *mechanical*,
   * not typed, so it is truncated and flagged like any other machine-produced overflow. Enforcing
   * across everything would block a legitimate layout change on content the user never touched.
   */
  private assertWithinBudgets(
    layout: SlideLayout, slots: SlotValues, typedKeys: readonly string[],
  ): void {
    const typed = new Set(typedKeys);
    const scoped = Object.fromEntries(
      Object.entries(slots).filter(([key]) => typed.has(key)),
    ) as SlotValues;

    const checked = checkSlotBudgets(layout, scoped);
    if (!checked.ok) throw InvalidSlideContent(describeSlotIssues(checked.issues));
  }
}

/* ─────────────────────────── pure helpers ─────────────────────────── */

/**
 * Flags for a normalized slide. `trimmed` is derived from the adjustments rather than passed in, so it
 * cannot be set for a slide whose content is within budget.
 *
 * `previous` is filtered rather than dropped: flags this function does not own (a fallback marker, a
 * letterbox warning) belong to the generation or brand path and must survive a user's text edit — while
 * `trimmed`, which this function DOES own, is recomputed from scratch.
 */
function flagsFor(
  normalized: { adjustments: readonly unknown[] }, previous: readonly QualityFlag[] = [],
): QualityFlag[] {
  const kept = previous.filter((f) => f !== "trimmed");
  return normalized.adjustments.length > 0 ? [...kept, "trimmed"] : [...kept];
}

/**
 * Best-effort slot carry-over on a layout change (SPEC §7.4: "`title→title`, `bullets→bullets`, first
 * bullet→`body`").
 *
 * Matching is by slot KEY and TYPE, which is why the seed layouts deliberately reuse `title`, `items`,
 * and `body` across definitions — the carry-over is a registry convention, not a hardcoded map of
 * layout pairs. A pair-wise map would need an entry for every new layout combination, which is exactly
 * the O(n²) parallel table §4 forbids.
 *
 * Content that has nowhere to go is DROPPED rather than concatenated into whatever slot remains.
 * Concatenating produces text no one wrote, and the user still has undo; silent invention they do not.
 */
export function carryOverSlots(
  from: { slots: readonly { key: string; type: "text" | "list" }[] },
  to: { slots: readonly { key: string; type: "text" | "list" }[] },
  slots: SlotValues,
): SlotValues {
  const carried: Record<string, string | string[]> = {};
  const byKey = new Map(from.slots.map((s) => [s.key, s]));

  for (const target of to.slots) {
    const value = slots[target.key];
    if (value === undefined) continue;
    const sourceType = byKey.get(target.key)?.type;

    if (sourceType === target.type) {
      carried[target.key] = value;
    } else if (target.type === "text" && isListSlot(value)) {
      // list → text: SPEC's "first bullet → body". The rest is dropped; see the note above.
      if (value[0] !== undefined) carried[target.key] = value[0];
    } else if (target.type === "list" && !isListSlot(value)) {
      carried[target.key] = [value];
    }
  }

  // A same-key/same-type slot on the TARGET that the source layout never had still carries over if the
  // stored slots happen to contain it — a slide that changed layout twice keeps its content both times.
  return carried;
}
