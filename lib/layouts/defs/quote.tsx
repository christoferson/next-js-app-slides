/**
 * `quote` — a pull quote with attribution.
 *
 * The quote panel is painted in both render modes for the same reason as `two_column`: the quote's
 * colour is the AA-checked foreground for `surface`, so the surface must actually be there. See that
 * file's `toPptx` note.
 *
 * `attribution` is required, unlike most optional trimmings. An unattributed quote on a business slide
 * reads as invented, and the model — which cannot verify a source — is exactly the wrong thing to let
 * imply provenance by omission. Requiring the field forces the outline's own evidence to supply it.
 */

import type { ReactNode } from "react";
import type { PptxTarget, RenderArgs, SlideLayout } from "@/lib/layouts/types";
import {
  AccentRule, accentRulePptx, paintPptx, paintPreview, Panel, panelPptx, type SlotPaint,
} from "@/lib/layouts/paint";
import { SlideFrame } from "@/lib/layouts/preview";

const PAINT: readonly SlotPaint[] = [
  { slotKey: "quote", face: "heading", role: "title", color: "onSurface", italic: true },
  { slotKey: "attribution", face: "body", role: "body", color: "onSurface" },
  { slotKey: "context", face: "body", role: "caption", color: "onBackground" },
];

const PANEL = { x: 8, y: 18, w: 84, h: 58 } as const;

/** Vertical accent bar down the panel's left edge. Drawn identically by both renderers. */
const RULE = { x: 8, y: 18, w: 0.7, h: 58 } as const;

export const quoteLayout: SlideLayout = {
  id: "quote",
  displayName: "Quote",
  description: "A single pull quote with attribution — a customer voice, a finding, or a mandate.",
  intents: ["quote"],

  slots: [
    {
      // 76%×40% at `title` (32pt) ⇒ 34 chars/line × 3 lines = 102 chars of capacity. A pull quote longer
      // than ~85 chars is not a pull quote anyway, so the budget and the design agree here.
      key: "quote", type: "text", required: true, typeRole: "title", maxChars: 85,
      description:
        "The quoted words only, at most about fifteen words. Do not add surrounding quotation marks — "
        + "the layout supplies them. Use the source's own wording; never invent a quotation.",
    },
    {
      key: "attribution", type: "text", required: true, typeRole: "body", maxChars: 40,
      description:
        "Who said it, and their role or organisation — it must fit on one line. Use only what the "
        + "source material states; if it is unattributed, say so plainly rather than guessing.",
    },
    {
      key: "context", type: "text", required: false, typeRole: "caption", maxChars: 100,
      description: "One line on why this quote matters here. Omit if the quote is self-explanatory.",
    },
  ],

  defaultZones: [
    { slotKey: "quote", x: 12, y: 24, w: 76, h: 40, align: "left", valign: "middle" },
    { slotKey: "attribution", x: 12, y: 64, w: 60, h: 9, align: "left", valign: "top" },
    { slotKey: "context", x: 8, y: 82, w: 76, h: 9, align: "left", valign: "top" },
  ],

  FallbackRenderer: (args: RenderArgs): ReactNode => (
    <SlideFrame tokens={args.tokens}>
      <Panel color={args.tokens.colors.surface} {...PANEL} />
      {/* An accent bar, not a decorative quotation glyph. A glyph would need its own text box in
          `toPptx` at a font size no `TypeScale` step defines, which is precisely the kind of
          preview-only flourish that makes an export stop matching what the user approved (§8). The
          rule has a verified pptx twin, so both renderers draw the same thing. */}
      <AccentRule tokens={args.tokens} {...RULE} />
      {paintPreview(args, PAINT)}
    </SlideFrame>
  ),

  toPptx(target: PptxTarget, args: RenderArgs): void {
    // Painted in both modes — the quote's colour is the AA-checked pairing for `surface`.
    panelPptx(target, args.tokens.colors.surface, PANEL.x, PANEL.y, PANEL.w, PANEL.h);
    accentRulePptx(target, args.tokens, RULE.x, RULE.y, RULE.w, RULE.h);
    paintPptx(target, args, PAINT);
  },
};
