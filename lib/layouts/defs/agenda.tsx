/**
 * `agenda` — a numbered walk-through of what the deck covers.
 *
 * Numbered rather than bulleted because an agenda is ordered by nature, and `bulletRuns` supports
 * `{type:'number'}`. §1.1/C5 applies with full force here: this was the layout whose items collapsed
 * into one paragraph in the render gate, losing their numbering silently.
 */

import type { ReactNode } from "react";
import type { PptxTarget, RenderArgs, SlideLayout } from "@/lib/layouts/types";
import {
  AccentRuleAbove, accentRuleAbovePptx, paintPptx, paintPreview, type SlotPaint,
} from "@/lib/layouts/paint";
import { SlideFrame } from "@/lib/layouts/preview";

const PAINT: readonly SlotPaint[] = [
  { slotKey: "title", face: "heading", role: "title", color: "onBackground" },
  { slotKey: "items", face: "body", role: "body", color: "onBackground", marker: "number" },
];

/** Rule width only; x/y are derived from the live `title` zone by `ruleAboveZone`. */
const RULE_W = 10;

export const agendaLayout: SlideLayout = {
  id: "agenda",
  displayName: "Agenda",
  description: "A numbered list of the deck's sections or the questions it answers.",
  intents: ["agenda"],

  slots: [
    {
      key: "title", type: "text", required: true, typeRole: "title", maxChars: 50,
      description: "Heading for the agenda, e.g. \"What we'll cover\".",
    },
    {
      key: "items", type: "list", required: true, typeRole: "body",
      maxChars: 300, maxItems: 6, itemMaxChars: 55,
      description:
        "3–6 entries, one per section of the deck, in order. Each a short noun phrase, "
        + "not a sentence.",
    },
  ],

  // Geometry is set by capacity, not by eye — see `tests/layout-budgets`. The header band is 84%×24%
  // at `title` (32pt) = two lines; the list is 84%×52% at `body` (18pt), giving each of 6 items one line.
  defaultZones: [
    { slotKey: "title", x: 8, y: 10, w: 84, h: 24, align: "left", valign: "top" },
    { slotKey: "items", x: 8, y: 36, w: 84, h: 52, align: "left", valign: "top" },
  ],

  FallbackRenderer: (args: RenderArgs): ReactNode => (
    <SlideFrame tokens={args.tokens}>
      <AccentRuleAbove args={args} slotKey="title" w={RULE_W} />
      {paintPreview(args, PAINT)}
    </SlideFrame>
  ),

  toPptx(target: PptxTarget, args: RenderArgs): void {
    accentRuleAbovePptx(target, args, "title", RULE_W);
    paintPptx(target, args, PAINT);
  },
};
