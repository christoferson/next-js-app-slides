/**
 * How much text a zone can actually hold — the arithmetic that makes `SlotSpec.maxChars` checkable
 * instead of asserted.
 *
 * §1.1/C1 established that truncation is the ONLY guard against overflow: `fit:'shrink'` emits a
 * scale-less `<a:normAutofit/>` that no renderer honours, so an over-long string either spills across
 * neighbouring zones or is silently clipped. A budget that is too generous therefore does not degrade
 * gracefully — it produces a broken slide. But a budget is only meaningful relative to a box size and
 * a point size, and those live in `defaultZones` and the type scale. This module joins the three so
 * `tests/layout-budgets` can verify every seed layout's declared budgets against its own geometry.
 *
 * ## The model, and its limits
 *
 * `AVG_ADVANCE_EM = 0.5` — the mean glyph advance as a fraction of the point size, measured from the
 * §1.1 probes (`scripts/verify-pptx-probe2.ts` probe C) and reproducing its published figures exactly:
 * a 60%-wide title at 28pt → ~30 chars/line; a 52%×34% bullets zone at 16pt → ~46 chars × 7 lines.
 *
 * This is an ESTIMATE, and knowingly so. It is a mean advance over Latin text in the ratified faces;
 * it will overestimate capacity for all-caps, for a wide face like Verdana, and badly for CJK (which
 * is ~1em per glyph, i.e. half the capacity). Two consequences we accept deliberately:
 *   - budgets are set with headroom against this estimate rather than at its limit, and
 *   - the estimate is used for *test-time* verification, never at render time. Nothing branches on it
 *     while generating a deck, so a mis-estimate cannot produce nondeterministic output.
 *
 * ⚠️ VERIFY — the per-face advance has NOT been measured for each ratified font; 0.5em is one figure
 * for all of them. Closing that needs the deferred desktop PowerPoint open-test (⚠️ VERIFY #1), where
 * real font metrics apply. Until then, headroom is the mitigation.
 */

import { POINTS_PER_INCH, SLIDE_16x9, type SlideSize, type ZonePercent, zoneToInches } from "@/lib/layouts/zone-math";

/** Mean glyph advance as a fraction of the point size. See the header for provenance and limits. */
export const AVG_ADVANCE_EM = 0.5;

/** Matches `bodyStyle`'s `lineSpacingMultiple`. */
export const DEFAULT_LINE_SPACING = 1.2;

export interface Capacity {
  charsPerLine: number;
  lines: number;
  /** Total characters the box can hold at this point size. */
  chars: number;
}

export function estimateCapacity(
  zone: ZonePercent,
  fontSize: number,
  options: { lineSpacing?: number; slide?: SlideSize } = {},
): Capacity {
  const { lineSpacing = DEFAULT_LINE_SPACING, slide = SLIDE_16x9 } = options;
  const box = zoneToInches(zone, slide);

  const widthPt = box.w * POINTS_PER_INCH;
  const heightPt = box.h * POINTS_PER_INCH;

  const charsPerLine = Math.max(1, Math.floor(widthPt / (AVG_ADVANCE_EM * fontSize)));
  const lines = Math.max(1, Math.floor(heightPt / (lineSpacing * fontSize)));

  return { charsPerLine, lines, chars: charsPerLine * lines };
}

/**
 * Capacity for a bulleted list: each item starts a new paragraph, so an item shorter than a line
 * still consumes one, and a bullet glyph plus its indent eat into the usable width.
 */
export function estimateListCapacity(
  zone: ZonePercent,
  fontSize: number,
  itemCount: number,
  options: { lineSpacing?: number; slide?: SlideSize } = {},
): { itemChars: number; linesPerItem: number } {
  const base = estimateCapacity(zone, fontSize, options);
  // ~2 characters of bullet glyph + indent, from the §1.1 bullet probes.
  const usablePerLine = Math.max(1, base.charsPerLine - 2);
  const linesPerItem = Math.max(1, Math.floor(base.lines / Math.max(1, itemCount)));
  return { itemChars: usablePerLine * linesPerItem, linesPerItem };
}
