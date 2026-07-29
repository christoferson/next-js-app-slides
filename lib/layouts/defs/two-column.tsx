/**
 * `two_column` — a side-by-side comparison.
 *
 * The two columns are symmetric by design: equal widths, same type, same colour. An asymmetric
 * treatment would editorialize the comparison visually while the model was only asked to state both
 * sides, and that mismatch is the kind of "the deck argued something I didn't" surprise the
 * message/visual separation exists to avoid.
 *
 * Both columns sit on `onSurface` panels rather than the slide background, so the pairing is
 * contrast-checked against the surface colour the panels actually paint.
 */

import type { ReactNode } from "react";
import type { PptxTarget, RenderArgs, SlideLayout } from "@/lib/layouts/types";
import {
  paintPptx, paintPreview, Panel, panelPptx, type SlotPaint,
} from "@/lib/layouts/paint";
import { SlideFrame } from "@/lib/layouts/preview";

const PAINT: readonly SlotPaint[] = [
  { slotKey: "title", face: "heading", role: "title", color: "onBackground" },
  { slotKey: "leftHeading", face: "heading", role: "heading", color: "onSurface" },
  { slotKey: "leftItems", face: "body", role: "body", color: "onSurface", marker: "bullet" },
  { slotKey: "rightHeading", face: "heading", role: "heading", color: "onSurface" },
  { slotKey: "rightItems", face: "body", role: "body", color: "onSurface", marker: "bullet" },
];

/** Panel geometry, in percent. Sized to sit just outside the heading + items zones above. */
const PANELS = [
  { x: 6, y: 31, w: 42, h: 68 },
  { x: 52, y: 31, w: 42, h: 68 },
] as const;

export const twoColumnLayout: SlideLayout = {
  id: "two_column",
  displayName: "Two column",
  description: "Two labelled columns for a comparison, a before/after, or options side by side.",
  intents: ["comparison"],

  slots: [
    {
      key: "title", type: "text", required: true, typeRole: "title", maxChars: 55,
      description: "What the two sides are being compared for. State the question, not the answer.",
    },
    {
      // A column label at `heading` (24pt) in a 38%-wide box holds ~22 chars, so this budget is genuinely
      // tight — hence "two or three words" in the description rather than a vaguer instruction. Widening
      // the box is not available: two columns plus a gutter is the layout.
      key: "leftHeading", type: "text", required: true, typeRole: "heading", maxChars: 18,
      description: "Label for the first column. Two or three words — it must fit on one line.",
    },
    {
      key: "leftItems", type: "list", required: true, typeRole: "body",
      maxChars: 180, maxItems: 4, itemMaxChars: 45,
      description: "2–4 points about the first column. Keep them parallel in form to the right column.",
    },
    {
      key: "rightHeading", type: "text", required: true, typeRole: "heading", maxChars: 18,
      description: "Label for the second column. Two or three words — it must fit on one line.",
    },
    {
      key: "rightItems", type: "list", required: true, typeRole: "body",
      maxChars: 180, maxItems: 4, itemMaxChars: 45,
      description: "2–4 points about the second column, matching the first column point for point.",
    },
  ],

  defaultZones: [
    { slotKey: "title", x: 8, y: 8, w: 84, h: 24, align: "left", valign: "top" },
    { slotKey: "leftHeading", x: 8, y: 34, w: 38, h: 11, align: "left", valign: "top" },
    { slotKey: "leftItems", x: 8, y: 46, w: 38, h: 52, align: "left", valign: "top" },
    { slotKey: "rightHeading", x: 54, y: 34, w: 38, h: 11, align: "left", valign: "top" },
    { slotKey: "rightItems", x: 54, y: 46, w: 38, h: 52, align: "left", valign: "top" },
  ],

  FallbackRenderer: (args: RenderArgs): ReactNode => (
    <SlideFrame tokens={args.tokens}>
      {PANELS.map((p) => (
        <Panel key={`panel-${p.x}`} color={args.tokens.colors.surface} {...p} />
      ))}
      {paintPreview(args, PAINT)}
    </SlideFrame>
  ),

  toPptx(target: PptxTarget, args: RenderArgs): void {
    // Painted in BOTH modes, unlike the other layouts' ornaments. The columns' text colour is the
    // AA-checked foreground for `surface`, so removing the surface would leave that pairing measured
    // against a colour that is no longer there — over an arbitrary brand image, illegibility is the
    // likely result. Obscuring part of a background is a visible, correctable design choice;
    // unreadable text is not. `quote` and `stats` make the same call for the same reason.
    for (const p of PANELS) {
      panelPptx(target, args.tokens.colors.surface, p.x, p.y, p.w, p.h);
    }
    paintPptx(target, args, PAINT);
  },
};
