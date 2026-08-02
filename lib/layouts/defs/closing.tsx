/**
 * `closing` — the ask, and what happens next.
 *
 * `nextSteps` is a list rather than prose on purpose. A closing slide whose call to action is a
 * paragraph is a closing slide nobody acts on, and the itemized form also gives the model a shape that
 * resists padding: three short imperatives are harder to waffle in than three sentences.
 *
 * `contact` is optional and explicitly conditional in its description. The briefing is the only place a
 * name or address could legitimately come from, and a model asked for contact details with none supplied
 * will invent a plausible email — the exact failure the evidence-only rule exists to prevent.
 */

import type { ReactNode } from "react";
import type { PptxTarget, RenderArgs, SlideLayout } from "@/lib/layouts/types";
import {
  AccentRuleAbove, accentRuleAbovePptx, paintPptx, paintPreview, type SlotPaint,
} from "@/lib/layouts/paint";
import { SlideFrame } from "@/lib/layouts/preview";

const PAINT: readonly SlotPaint[] = [
  { slotKey: "title", face: "heading", role: "display", color: "onBackground" },
  { slotKey: "nextSteps", face: "body", role: "body", color: "onBackground", marker: "number" },
  { slotKey: "contact", face: "body", role: "caption", color: "secondary" },
];

/** Rule width only; x/y are derived from the live `title` zone (`ruleAboveZone`). */
const RULE_W = 12;

export const closingLayout: SlideLayout = {
  id: "closing",
  displayName: "Closing",
  description: "The ask and the next steps — the last slide, and the one the audience acts on.",
  intents: ["closing"],

  slots: [
    {
      key: "title", type: "text", required: true, typeRole: "display", maxChars: 45,
      description:
        "The ask, in the imperative — what you want the audience to decide or do. Not \"Thank you\", "
        + "and not a summary of the deck.",
    },
    {
      key: "nextSteps", type: "list", required: true, typeRole: "body",
      maxChars: 220, maxItems: 4, itemMaxChars: 55,
      description:
        "2–4 concrete next steps in order. Each starts with a verb and names who does it and by when, "
        + "using only owners and dates the briefing supplies. Never invent a name or a date.",
    },
    {
      key: "contact", type: "text", required: false, typeRole: "caption", maxChars: 60,
      description:
        "A follow-up contact, ONLY if the briefing states one. Omit this field entirely otherwise — "
        + "do not invent a name, email, or address.",
    },
  ],

  defaultZones: [
    { slotKey: "title", x: 8, y: 12, w: 84, h: 26, align: "left", valign: "bottom" },
    { slotKey: "nextSteps", x: 8, y: 42, w: 84, h: 40, align: "left", valign: "top" },
    { slotKey: "contact", x: 8, y: 86, w: 60, h: 8, align: "left", valign: "bottom" },
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
