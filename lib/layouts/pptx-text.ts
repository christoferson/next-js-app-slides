/**
 * The ONE place bullet runs and zone-positioned text boxes are built (§1.1/C5 + C1).
 *
 * ## Why this file is mandatory, not a convenience
 *
 * **C5** — pptxgenjs groups text runs into paragraphs with an `if (align) … else if (bullet) …`
 * chain (`dist/pptxgen.cjs.js` ~L6186). A shape-level `align` makes the first branch true for every
 * run, so the bullet branch **never executes** and all items collapse into ONE paragraph: items 2..n
 * lose their bullet, their numbering, and their indent level, with no warning. `SlotZone` carries
 * `align`, so *every* bullets slot rendered through the zone model hits this. The fix is
 * `breakLine: true` on every item, which takes an unconditional code path.
 *
 * That is why layouts must never build runs themselves. A new layout writing its own `addText([...])`
 * would silently reintroduce the collapse, and the OOXML assertions would not catch it — 48 of them
 * did not. Only the raster render gate did. `assertParagraphCount` is the export-time backstop.
 *
 * **C1** — `fit:'shrink'` emits a scale-less `<a:normAutofit/>` that no renderer honours (verified in
 * LibreOffice, and by the user clicking into the box in PowerPoint on the web). Its mere presence
 * flips overflow from "spill" to "clip" in LibreOffice — silent content loss. So `fit` is pinned to
 * `'none'` here and truncation is `validate.ts`'s job.
 */

import type { SlotZone } from "@/lib/brand/types";
import type { DesignTokens } from "@/lib/brand/types";
import type { PptxTarget, PptxTextOptions, PptxTextRun } from "@/lib/layouts/types";
import { SLIDE_16x9, type SlideSize, zoneToInches } from "@/lib/layouts/zone-math";

export interface TextStyle {
  fontFace: string;
  fontSize: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
  lineSpacingMultiple?: number;
}

/** Zone → pptxgenjs geometry + alignment. The only place that mapping is written. */
export function zoneOptions(
  zone: SlotZone, style: TextStyle, slide: SlideSize = SLIDE_16x9,
): PptxTextOptions {
  const box = zoneToInches(zone, slide);
  return {
    ...box,
    align: zone.align,
    valign: zone.valign,
    fontFace: style.fontFace,
    fontSize: style.fontSize,
    color: style.color,
    ...(style.bold === undefined ? {} : { bold: style.bold }),
    ...(style.italic === undefined ? {} : { italic: style.italic }),
    ...(style.lineSpacingMultiple === undefined
      ? {} : { lineSpacingMultiple: style.lineSpacingMultiple }),
    // Pinned — never 'shrink'. See C1 in the header.
    fit: "none",
  };
}

/** A single-paragraph text box in a zone. */
export function addZoneText(
  target: PptxTarget, zone: SlotZone, text: string, style: TextStyle,
  slide: SlideSize = SLIDE_16x9,
): void {
  if (text.trim() === "") return;
  target.addText([{ text }], zoneOptions(zone, style, slide));
}

export interface BulletOptions {
  /** `"number"` renders 1./2./3. instead of a glyph. */
  type?: "bullet" | "number";
  /** 0-based nesting. Uniform across items in v1; the seed layouts are all flat. */
  indentLevel?: number;
}

/**
 * Build bullet runs. **`breakLine` is stamped on every item** — that is the entire reason this
 * function exists (C5). Nothing else may construct bullet runs.
 */
export function bulletRuns(
  items: readonly string[], options: BulletOptions = {},
): PptxTextRun[] {
  const bullet = options.type === "number" ? { type: "number" as const } : true;
  return items
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((text) => ({
      text,
      options: {
        bullet,
        // MANDATORY. Without it a shape-level `align` collapses every item into one paragraph.
        breakLine: true,
        ...(options.indentLevel === undefined ? {} : { indentLevel: options.indentLevel }),
      },
    }));
}

/** A bulleted list in a zone. Returns the number of paragraphs written, for the C5 assertion. */
export function addZoneBullets(
  target: PptxTarget, zone: SlotZone, items: readonly string[], style: TextStyle,
  options: BulletOptions = {}, slide: SlideSize = SLIDE_16x9,
): number {
  const runs = bulletRuns(items, options);
  if (runs.length === 0) return 0;
  target.addText(runs, zoneOptions(zone, style, slide));
  return runs.length;
}

/**
 * Export-time backstop for C5: *n* items must have produced *n* paragraphs.
 *
 * Called by the exporter against its own serialized output. A structural assertion is warranted here
 * specifically because the failure is invisible — the deck opens, the slide looks populated, and only
 * a human reading the rendered page notices the items ran together.
 */
export function assertParagraphCount(
  context: string, expected: number, actual: number,
): void {
  if (expected !== actual) {
    throw new Error(
      `Bullet paragraph count mismatch in ${context}: expected ${expected}, got ${actual}. `
      + "This is the §1.1/C5 collapse — bullet runs must be built via bulletRuns() so every item "
      + "carries breakLine:true.",
    );
  }
}

/* ── token → style helpers, so every layout derives type the same way ── */

export const headingStyle = (
  tokens: DesignTokens, size: number, color: string,
): TextStyle => ({
  fontFace: tokens.fonts.headingPptx,
  fontSize: size,
  color,
  bold: true,
});

export const bodyStyle = (
  tokens: DesignTokens, size: number, color: string,
): TextStyle => ({
  fontFace: tokens.fonts.bodyPptx,
  fontSize: size,
  color,
  lineSpacingMultiple: 1.2,
});
