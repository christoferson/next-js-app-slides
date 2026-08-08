/**
 * `checklist` — a title plus up to six checkbox items.
 *
 * ## Why this layout exists
 *
 * It is CLAUDE.md §10's proof: a layout must be **one file here plus one line in the registry**, and
 * `git diff --stat` is the evidence. Everything downstream — `/api/registry/layouts`, the brand
 * editor's zone table, the mapping chain, prompt construction, slot validation, the workspace
 * switcher, the PPTX exporter — has to pick it up with no further edit. It is also a genuinely useful
 * layout (readiness criteria, acceptance conditions, a "what we need from you" close), so keeping it is
 * not a cost.
 *
 * ## The checkbox is ASCII, and that is a §1.1 decision rather than a stylistic one
 *
 * The obvious rendering is U+2610 `☐`. It is the wrong choice here. C4 established that pptxgenjs
 * validates nothing and writes `fontFace` verbatim, so a substituted font is **undetectable at export
 * time** — and font substitution on a desktop Office install is the one open ⚠️ VERIFY item on this
 * project. A missing `☐` glyph renders as tofu (`□`/`?`) in the artifact the audience sees, and nothing
 * in our pipeline could tell. `[ ]` is three characters every ratified face has, in both renderers.
 *
 * Drawing the boxes as `addShape("rect", { line })` geometry was the other candidate and is rejected
 * for a sharper reason: one square per item means computing per-item row offsets, i.e. subdividing the
 * `items` zone. `stats` does that, and it is why `tests/pptx-exporter.test.ts` carries a `stats`
 * special case in its §8 zone-fidelity loop — a second subdividing layout would need a second one, so
 * the §10 diff would include a test file and the proof would fail. Text-only items sit at exactly their
 * declared zone, which is what makes this layout free of downstream edits.
 *
 * ## Why `marker: "none"`
 *
 * The mark is part of each item's text, so a bullet glyph in front of it would read as a bullet
 * followed by a checkbox. `marker: "none"` is the existing `SlotPaint` value for that, and this is the
 * first layout to use it — which is how it surfaced that `paintPptx` was dropping the value and
 * exporting bullets anyway. That was a §8 divergence in shared code, fixed in `pptx-text.ts` and
 * `paint.tsx` with a probe (`scripts/verify-pptx-bullet-none.ts`) and regression tests, separately from
 * this file. This layout only *consumes* the fixed behaviour; it adds no primitive of its own.
 *
 * Budgets are derived, not chosen, exactly as `bullets.tsx` describes: the items zone is 84%×50% at
 * `body` (18pt) over 6 items ⇒ ~65 chars per item, so `itemMaxChars: 48` leaves room for the `[ ] `
 * prefix inside the 85% headroom `tests/layout-budgets` enforces.
 */

import type { ReactNode } from "react";
import type { PptxTarget, RenderArgs, SlideLayout } from "@/lib/layouts/types";
import {
  AccentRuleAbove, accentRuleAbovePptx, listOf, paintPptx, paintPreview, type SlotPaint,
} from "@/lib/layouts/paint";
import { SlideFrame } from "@/lib/layouts/preview";

/**
 * The unchecked-box prefix. Trailing space included so it never abuts the item text.
 *
 * A single constant consumed by both renderers, because it is content rather than styling: it goes
 * into the string itself, so preview and export cannot disagree about it as long as they read the same
 * `markItems` output. Two literals would be the §8 copy-paste failure in miniature.
 */
const MARK = "[ ] ";

const PAINT: readonly SlotPaint[] = [
  { slotKey: "title", face: "heading", role: "title", color: "onBackground" },
  // `none` — the mark lives in the text (see the header), so a bullet would double up.
  { slotKey: "items", face: "body", role: "body", color: "onBackground", marker: "none" },
  { slotKey: "note", face: "body", role: "caption", color: "accent", italic: true },
];

/** Rule width only; x/y come from the live `title` zone via `ruleAboveZone`. */
const RULE_W = 10;

/**
 * Prefix each item with the mark, in `RenderArgs` form both renderers can paint.
 *
 * Done here rather than asking the model for the prefix: a model told to write "[ ] " would sometimes
 * write "[]", sometimes "☐", sometimes nothing, and the budget would have to absorb a prefix that may
 * or may not arrive. Items that are already marked are left alone so a model that volunteers the
 * prefix does not produce `[ ] [ ] item`.
 */
function markItems(args: RenderArgs): RenderArgs {
  const items = listOf(args, "items");
  if (!items) return args;
  return {
    ...args,
    slots: {
      ...args.slots,
      items: items.map((item) => {
        const text = item.trim();
        // Tolerant of the shapes a model actually emits — "[]", "[ ]", "[x]" — rather than only ours.
        return /^\[[\sxX✓]?\]\s*/.test(text) ? text : `${MARK}${text}`;
      }),
    },
  };
}

export const checklistLayout: SlideLayout = {
  id: "checklist",
  displayName: "Checklist",
  description: "A headline claim with up to six checkbox items — readiness criteria, or conditions to meet.",

  /**
   * `list` only, deliberately.
   *
   * `bullets` also claims `list` and comes FIRST in the registry array, so it keeps every existing
   * intent-match decision — `intentMatchRule` takes the first layout claiming a hint, and the registry
   * order is the documented tie-break. This layout is therefore reachable by user override and by the
   * workspace switcher without silently re-routing decks that generate today, which is what makes the
   * §10 proof non-perturbing. Inventing a `checklist` hint was the alternative and would have failed
   * the proof outright: `assertHintCoverage()` would demand an entry in `lib/generation/hints.ts`, a
   * third file in the diff.
   */
  intents: ["list"],

  slots: [
    {
      /*
       * 48, not `bullets`' 55, and the difference is derived rather than a preference. `title` and
       * `items` are both 84% wide here, so `tests/layout-budgets`' hygiene rule applies with no width
       * exemption: at 32pt the title box holds FEWER characters than the 18pt items box, so a title
       * budget above the per-item budget would be a number chosen rather than computed. 48 is that
       * ceiling, and comfortably inside the ~62 the zone's own capacity allows.
       */
      key: "title", type: "text", required: true, typeRole: "title", maxChars: 48,
      description: "What the list of items establishes, as a short assertion rather than a label.",
    },
    {
      key: "items", type: "list", required: true, typeRole: "body",
      maxChars: 288, maxItems: 6, itemMaxChars: 48,
      description:
        "2–6 items, each a condition, criterion, or step stated as a short clause. Keep them parallel "
        + "in form. Do not number them, and do not add brackets, ticks, or box characters — write the "
        + "item text only.",
    },
    {
      key: "note", type: "text", required: false, typeRole: "caption", maxChars: 75,
      description: "One line on what completing the list means. Omit if the items speak for themselves.",
    },
  ],

  defaultZones: [
    { slotKey: "title", x: 8, y: 10, w: 84, h: 22, align: "left", valign: "top" },
    { slotKey: "items", x: 8, y: 36, w: 84, h: 50, align: "left", valign: "top" },
    { slotKey: "note", x: 8, y: 88, w: 76, h: 8, align: "left", valign: "bottom" },
  ],

  FallbackRenderer: (args: RenderArgs): ReactNode => (
    <SlideFrame tokens={args.tokens}>
      <AccentRuleAbove args={args} slotKey="title" w={RULE_W} />
      {paintPreview(markItems(args), PAINT)}
    </SlideFrame>
  ),

  toPptx(target: PptxTarget, args: RenderArgs): void {
    accentRuleAbovePptx(target, args, "title", RULE_W);
    // The SAME `markItems` the preview uses, for the same reason both consume `resolveZones` (§8).
    paintPptx(target, markItems(args), PAINT);
  },
};
