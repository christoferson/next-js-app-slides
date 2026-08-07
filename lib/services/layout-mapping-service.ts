/**
 * `LayoutMappingService` — outline → layouts (SPEC §7.2).
 *
 * ## Why this is a service at all, when `mapOutline` is a pure function
 *
 * It is thin on purpose. The chain in `lib/mapping/rules.ts` is pure and stays pure — that is what
 * makes it table-testable. What this layer adds is the one thing the pure function must not know:
 * **which layouts actually exist for this deck's brand**, and what to tell the user when a decision
 * is not the obvious one.
 *
 * Three responsibilities, each of which would otherwise be duplicated by every caller:
 *
 *  1. **Mapping preview** — the outline editor shows, per slide, which layout it will get and *why*
 *     (the `reason` string). That preview must be produced by the same chain generation will run, or
 *     the badge lies. One function, two callers.
 *  2. **Override validation.** A `layoutOverride` from the outline editor is untrusted input; an
 *     unknown id must be a readable 400 at the edit, not a silently-ignored field discovered at
 *     generation time. `UserOverrideRule` deliberately *ignores* a stale override (a layout removed
 *     between save and generate must not fail a deck) — so validating at the edge is the only place a
 *     typo gets reported at all.
 *  3. **Layout options per slide** — the picker's ordered list, intent-matched first.
 */

import type { Outline, OutlineSlide, VisualHint } from "@/lib/domain/deck";
import { UnknownLayout } from "@/lib/errors/errors";
import { LAYOUTS, findLayout, layoutsForIntent } from "@/lib/layouts/registry";
import { type MappedSlide, layoutForHint, mapOutline } from "@/lib/mapping/rules";

/** One row of the outline editor's mapping preview. */
export interface MappingPreviewRow {
  index: number;
  question: string;
  visualHint: VisualHint;
  layoutId: string;
  layoutDisplayName: string;
  /** Which rule decided, and its human explanation — the per-slide badge (SPEC §7.2). */
  rule: MappedSlide["decision"]["rule"];
  reason: string;
  /** True when the user pinned this layout, so the UI can offer "reset to automatic". */
  overridden: boolean;
  sectionHeading?: string;
  /**
   * This slide's picker options, intent-ranked (`layoutOptionsFor`).
   *
   * Carried on the row rather than left to the client because the ranking IS the recommendation, and a
   * client that sorted the registry itself would be §4's parallel table: its "recommended" option would
   * drift from the chain's `reason` the moment a layout claimed a new intent. Per-row rather than
   * per-view for the same reason — the order depends on this slide's `visualHint`.
   */
  options: LayoutOption[];
}

/** A layout the picker may offer, ordered by `layoutOptionsFor`. */
export interface LayoutOption {
  id: string;
  displayName: string;
  description: string;
  /** True for the layout the intent would pick on its own — the highlighted default. */
  recommended: boolean;
}

export class LayoutMappingService {
  /**
   * Map a whole outline. No dependencies at all — deliberately: this is the seam where a "why did my
   * slide become a divider?" question is answered, and an answer that depended on storage state would
   * be unreproducible.
   */
  map(outline: Outline): MappedSlide[] {
    return mapOutline(outline);
  }

  /**
   * The editor's preview. Section headings are attached here because `MappedSlide.position` carries a
   * section *index* but not its text, and the row is what the user reads.
   */
  preview(outline: Outline): MappingPreviewRow[] {
    const headings = outline.sections
      .filter((s) => s.slides.length > 0)
      .map((s) => s.heading);

    return this.map(outline).map((mapped) => {
      // `requireLayout` would be wrong here: the chain only ever returns registry ids, so an unknown
      // one is our bug — but a preview is a read, and failing a whole editor load over one row is a
      // worse outcome than a row that names the id it could not resolve.
      const layout = findLayout(mapped.decision.layoutId);
      const heading = headings[mapped.position.sectionIndex];
      return {
        index: mapped.position.index,
        question: mapped.slide.question,
        visualHint: mapped.slide.visualHint,
        layoutId: mapped.decision.layoutId,
        layoutDisplayName: layout?.displayName ?? mapped.decision.layoutId,
        rule: mapped.decision.rule,
        reason: mapped.decision.reason,
        overridden: mapped.decision.rule === "user-override",
        options: this.layoutOptionsFor(mapped.slide),
        ...(heading !== undefined && heading.trim() !== "" ? { sectionHeading: heading } : {}),
      };
    });
  }

  /**
   * Validate a `layoutOverride` before it is persisted.
   *
   * The mapping chain tolerates a stale override by design, which means a *typo* would also be
   * tolerated — the user pins `bulletts`, sees no error, and gets `bullets` anyway with no explanation.
   * Checking at the write is what turns that into a readable message.
   */
  assertValidOverride(layoutId: string): void {
    if (!findLayout(layoutId)) throw UnknownLayout(layoutId, LAYOUTS.map((l) => l.id));
  }

  /**
   * The per-slide layout picker's options (SPEC §7.4's layout switcher).
   *
   * Ordered intent-match first, then the rest by registry order. `recommended` uses `layoutForHint`
   * rather than running the whole chain, because the picker answers "what does this hint mean" — not
   * "what will this slide be". Running `mapSlide` here would make the highlighted option disagree with
   * the badge on a first or last slide, where position beats intent. That distinction is deliberate and
   * documented in `rules.ts`; this is the consumer it was made for.
   */
  layoutOptionsFor(slide: Pick<OutlineSlide, "visualHint">): LayoutOption[] {
    const recommendedId = layoutForHint(slide.visualHint);
    const matching = layoutsForIntent(slide.visualHint).map((l) => l.id);
    const rank = (id: string): number => {
      if (id === recommendedId) return 0;
      return matching.includes(id) ? 1 : 2;
    };

    return [...LAYOUTS]
      .map((l) => ({
        id: l.id,
        displayName: l.displayName,
        description: l.description,
        recommended: l.id === recommendedId,
      }))
      // Stable within a rank: `LAYOUTS` order is a precedence declaration (see `rules.ts`), so
      // preserving it means the picker and the chain agree about which of two claimants comes first.
      .sort((a, b) => rank(a.id) - rank(b.id));
  }
}
