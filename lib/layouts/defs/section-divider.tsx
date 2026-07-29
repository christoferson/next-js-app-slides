/**
 * `section_divider` — a full-bleed pause between sections.
 *
 * The one layout whose token-styled mode fills the slide with the brand's primary colour rather than
 * its background, which is why its slots paint on `onPrimary`: the painter can only ask for "legible
 * text on primary", and `compileTheme` already repaired that pair if the brand's own text colours
 * failed AA against it. Note `onPrimary` is resolved at the *large-text* threshold (3:1), which is
 * correct here — nothing on this slide is body copy.
 *
 * In Templated mode the brand's background image replaces the fill entirely, so the panel is
 * suppressed; the text pairing stays as declared because the brand chose that background to sit under
 * this layout's type.
 */

import type { ReactNode } from "react";
import type { PptxTarget, RenderArgs, SlideLayout } from "@/lib/layouts/types";
import { isTemplated, paintPptx, paintPreview, panelPptx, Panel, type SlotPaint } from "@/lib/layouts/paint";
import { SlideFrame } from "@/lib/layouts/preview";

const PAINT: readonly SlotPaint[] = [
  { slotKey: "eyebrow", face: "body", role: "caption", color: "onPrimary" },
  { slotKey: "title", face: "heading", role: "display", color: "onPrimary" },
];

export const sectionDividerLayout: SlideLayout = {
  id: "section_divider",
  displayName: "Section divider",
  description: "A full-bleed break announcing the next section of the deck.",
  intents: ["section"],

  slots: [
    {
      key: "eyebrow", type: "text", required: false, typeRole: "caption", maxChars: 40,
      description: "A short label above the section name, e.g. \"Part 2\". Omit if not useful.",
    },
    {
      key: "title", type: "text", required: true, typeRole: "display", maxChars: 45,
      description: "The section name. Two to five words. No trailing period.",
    },
  ],

  // The title band is 80%×30% at `display` (40pt) = two lines ⇒ 56 chars of capacity, hence 45.
  defaultZones: [
    { slotKey: "eyebrow", x: 10, y: 30, w: 60, h: 8, align: "left", valign: "bottom" },
    { slotKey: "title", x: 10, y: 40, w: 80, h: 30, align: "left", valign: "top" },
  ],

  FallbackRenderer: (args: RenderArgs): ReactNode => (
    <SlideFrame tokens={args.tokens}>
      <Panel color={args.tokens.colors.primary} x={0} y={0} w={100} h={100} />
      {paintPreview(args, PAINT)}
    </SlideFrame>
  ),

  toPptx(target: PptxTarget, args: RenderArgs): void {
    // Painted first so slot text lands on top of it. Suppressed when a brand background is present.
    if (!isTemplated(args)) panelPptx(target, args.tokens.colors.primary, 0, 0, 100, 100);
    paintPptx(target, args, PAINT);
  },
};
