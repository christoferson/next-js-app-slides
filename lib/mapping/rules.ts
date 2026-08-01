/**
 * Layout mapping — Chain of Responsibility, no LLM (SPEC §7.2, CLAUDE.md §2 step 9).
 *
 * Ordered rules, first match wins:
 *   `UserOverrideRule` → `PositionalRule` → `IntentMatchRule` → `FallbackRule`
 *
 * ## Why this is deterministic and not a model call
 *
 * Layout choice is a *structural* decision with a small closed answer set, and the outline already
 * carries the only input it needs (`visualHint`). Asking a model would make the same outline produce
 * different decks on different runs, cost a call per slide, and — the real objection — make the
 * mapping badge in the outline editor unexplainable: the user could see *which* layout was chosen but
 * never *why*, so an override would be a guess rather than a correction. Every decision here carries
 * the rule that made it and a one-line reason, which is what the badge renders.
 *
 * ## Why rules read from the registry rather than a table
 *
 * SPEC §6/§10: adding a layout is one file plus one registry line, and mapping must pick it up with
 * **no rule changes**. `IntentMatchRule` therefore asks `layoutsForIntent(hint)` rather than
 * consulting a `hint → layoutId` map. The only ids named literally in this file are the three
 * *positional* roles, which are structural facts about a deck (a deck opens, it closes, its sections
 * are announced) and not properties of any layout — and even those degrade gracefully: if a positional
 * layout is absent from the registry the rule declines instead of throwing, so the chain continues to
 * intent matching rather than a whole deck failing over a registry edit.
 */

import type { Outline, OutlineSlide, VisualHint } from "@/lib/domain/deck";
import { FALLBACK_LAYOUT_ID, findLayout, layoutsForIntent } from "@/lib/layouts/registry";

/** Which rule decided — surfaced as the outline editor's mapping badge (SPEC §9). */
export type MappingRuleId = "user-override" | "positional" | "intent-match" | "fallback";

export interface MappingDecision {
  layoutId: string;
  rule: MappingRuleId;
  /**
   * One line, user-facing, explaining the choice — "Last slide of the deck", "Matches the 'metrics'
   * intent". Written for the person deciding whether to override, so it never names a rule class or
   * a registry internal.
   */
  reason: string;
}

/**
 * Where a slide sits in the deck. Computed once by `mapOutline` and passed in, because a rule must
 * not have to re-derive it — `PositionalRule` asking "am I last?" from an index alone is the kind of
 * off-by-one that silently gives a 12-slide deck two closings.
 */
export interface SlidePosition {
  /** Index across the whole deck, ignoring section boundaries. */
  index: number;
  /** Total slides in the deck. */
  total: number;
  /** Index of the section this slide belongs to. */
  sectionIndex: number;
  /** Index within its section — 0 means it is the section's first slide. */
  indexInSection: number;
  /** True when this slide's section has a heading worth announcing. See `isSectionOpener`. */
  sectionHasHeading: boolean;
}

export interface MappingRule {
  id: MappingRuleId;
  /** `undefined` means "not my call" — the chain moves on. Only `FallbackRule` always decides. */
  apply(slide: OutlineSlide, position: SlidePosition): MappingDecision | undefined;
}

/* ─────────────────────────────── positional roles ─────────────────────────────── */

/**
 * The three structural roles. Ids, not layouts: a brand cannot rename them, and the registry is
 * consulted at decision time so a missing one declines rather than throws.
 */
const OPENING_LAYOUT_ID = "title";
const CLOSING_LAYOUT_ID = "closing";
const SECTION_LAYOUT_ID = "section_divider";

/**
 * A section opener earns a divider only if the deck actually has sections worth announcing.
 *
 * Three conditions, each there for a failure mode seen in outline output:
 *  - it must be the section's first slide;
 *  - the section must have a non-empty heading (a model that returns one unnamed section would
 *    otherwise get a divider reading nothing);
 *  - it must not be the deck's first section, because that divider would sit immediately after the
 *    title slide and say the same thing twice.
 */
const isSectionOpener = (position: SlidePosition): boolean =>
  position.indexInSection === 0 && position.sectionHasHeading && position.sectionIndex > 0;

/* ─────────────────────────────── the rules ─────────────────────────────── */

/**
 * The user asked for this layout. Nothing downstream may second-guess it.
 *
 * An override naming a layout that no longer exists is IGNORED rather than honoured or fatal — a
 * layout can be removed from the registry between the outline being saved and the deck being
 * generated, and neither crashing nor rendering an unknown id is acceptable. The chain then decides
 * as if no override were present, which is the same behaviour as never having set one.
 */
export const userOverrideRule: MappingRule = {
  id: "user-override",
  apply(slide) {
    if (slide.layoutOverride === undefined) return undefined;
    if (!findLayout(slide.layoutOverride)) return undefined;
    return {
      layoutId: slide.layoutOverride,
      rule: "user-override",
      reason: "You chose this layout",
    };
  },
};

/**
 * Structure beats content: the first slide opens, the last closes, a section's first slide announces
 * it. This outranks intent matching on purpose — a first slide whose `visualHint` is `list` is still
 * the title slide, and a model that hints otherwise is describing the *content* of the opening, not
 * its role in the deck.
 *
 * Opening wins over closing in a one-slide deck: a deck that only opens is coherent, one that only
 * closes is not.
 */
export const positionalRule: MappingRule = {
  id: "positional",
  apply(_slide, position) {
    if (position.index === 0) {
      return decideIfPresent(OPENING_LAYOUT_ID, "First slide of the deck");
    }
    if (position.index === position.total - 1) {
      return decideIfPresent(CLOSING_LAYOUT_ID, "Last slide of the deck");
    }
    if (isSectionOpener(position)) {
      return decideIfPresent(SECTION_LAYOUT_ID, "Opens a new section");
    }
    return undefined;
  },
};

const decideIfPresent = (layoutId: string, reason: string): MappingDecision | undefined =>
  findLayout(layoutId) ? { layoutId, rule: "positional", reason } : undefined;

/**
 * `visualHint ∈ layout.intents`, read live from the registry.
 *
 * When several layouts claim an intent the FIRST in registry order wins, which makes the registry
 * array's order a deliberate precedence declaration rather than incidental. Ties are possible today
 * (`bullets` claims both `list` and `detail`) and expected to grow, so the tie-break has to be stated
 * somewhere; stating it as "registry order" keeps it visible in the one file a layout author edits.
 */
export const intentMatchRule: MappingRule = {
  id: "intent-match",
  apply(slide) {
    const [match] = layoutsForIntent(slide.visualHint);
    if (!match) return undefined;
    return {
      layoutId: match.id,
      rule: "intent-match",
      reason: `Matches the "${slide.visualHint}" intent`,
    };
  },
};

/**
 * Always decides. `bullets` is the fallback because it is the one layout whose required slots
 * (`title` + `items`) can be filled from an outline entry alone — message and evidence — which is
 * also why §9's `FallbackHandler` targets it and why the registry asserts its shape at load.
 */
export const fallbackRule: MappingRule = {
  id: "fallback",
  apply() {
    return {
      layoutId: FALLBACK_LAYOUT_ID,
      rule: "fallback",
      reason: "No specific layout fits — showing the message as points",
    };
  },
};

/** The chain, in precedence order. Exported so a test can assert the order itself (SPEC §7.2). */
export const MAPPING_RULES: readonly MappingRule[] = [
  userOverrideRule,
  positionalRule,
  intentMatchRule,
  fallbackRule,
];

/* ─────────────────────────────── the chain ─────────────────────────────── */

/**
 * Run the chain. Total by construction — `fallbackRule` decides unconditionally, so every slide gets
 * a layout and there is no "unmapped" state for a caller to handle.
 */
export function mapSlide(
  slide: OutlineSlide,
  position: SlidePosition,
  rules: readonly MappingRule[] = MAPPING_RULES,
): MappingDecision {
  for (const rule of rules) {
    const decision = rule.apply(slide, position);
    if (decision) return decision;
  }
  // Unreachable with `MAPPING_RULES`, but a caller may pass a custom chain (the §10 proof does).
  return {
    layoutId: FALLBACK_LAYOUT_ID,
    rule: "fallback",
    reason: "No specific layout fits — showing the message as points",
  };
}

/** One decision per slide, in deck order — flattened across sections, as generation consumes them. */
export interface MappedSlide {
  slide: OutlineSlide;
  position: SlidePosition;
  decision: MappingDecision;
}

/**
 * Map a whole outline. Positions are computed here, once, so no rule has to reconstruct them and
 * "first"/"last" mean the same thing to every rule.
 *
 * Empty sections are skipped rather than counted: a section a model left empty must not shift what
 * "last slide of the deck" refers to, and it must not make the *next* section's opener think it has a
 * predecessor to distinguish itself from — hence `sectionIndex` counts sections that contributed
 * slides, not raw array positions.
 */
export function mapOutline(
  outline: Outline,
  rules: readonly MappingRule[] = MAPPING_RULES,
): MappedSlide[] {
  const flat: { slide: OutlineSlide; sectionIndex: number; indexInSection: number; sectionHasHeading: boolean }[] = [];

  let sectionIndex = 0;
  for (const section of outline.sections) {
    if (section.slides.length === 0) continue;
    const sectionHasHeading = section.heading.trim() !== "";
    section.slides.forEach((slide, indexInSection) => {
      flat.push({ slide, sectionIndex, indexInSection, sectionHasHeading });
    });
    sectionIndex += 1;
  }

  return flat.map((entry, index) => {
    const position: SlidePosition = {
      index,
      total: flat.length,
      sectionIndex: entry.sectionIndex,
      indexInSection: entry.indexInSection,
      sectionHasHeading: entry.sectionHasHeading,
    };
    return { slide: entry.slide, position, decision: mapSlide(entry.slide, position, rules) };
  });
}

/**
 * Which layout a `visualHint` maps to *ignoring position and overrides* — the outline editor's
 * per-slide layout picker uses this to order its options with the intent-matched one first.
 *
 * Deliberately not the same function as `mapSlide`: the picker is asking "what does this hint mean",
 * not "what will this slide be", and conflating them would make the picker's highlighted option
 * disagree with the badge on a first or last slide.
 */
export const layoutForHint = (hint: VisualHint): string | undefined => layoutsForIntent(hint)[0]?.id;
