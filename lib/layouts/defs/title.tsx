/**
 * `title` — the opening slide. One file, one registry line (CLAUDE.md §10).
 *
 * ## Where the budgets come from
 *
 * Not from taste. `tests/layout-budgets` computes each zone's capacity from its own geometry and the
 * type scale, and requires the declared budget to fit inside 85% of it. The title zone is 84%×30% at
 * `display` (40pt) ⇒ 30 chars/line × 2 lines = 60, so `maxChars: 50`. An earlier draft of this file
 * claimed 84 chars of capacity for a shorter zone and set `maxChars: 70`; both numbers were wrong, and
 * the test is what said so.
 *
 * That check is load-bearing rather than tidy: §1.1/C1 proved nothing shrinks text to fit, so a budget
 * larger than its box means the exported slide spills or clips — silently, in the artifact the audience
 * sees.
 */

import type { ReactNode } from "react";
import type { PptxTarget, RenderArgs, SlideLayout } from "@/lib/layouts/types";
import {
  AccentRuleAbove, accentRuleAbovePptx, paintPptx, paintPreview, type SlotPaint,
} from "@/lib/layouts/paint";
import { SlideFrame } from "@/lib/layouts/preview";

const PAINT: readonly SlotPaint[] = [
  { slotKey: "title", face: "heading", role: "display", color: "onBackground" },
  { slotKey: "subtitle", face: "body", role: "heading", color: "onBackground" },
  { slotKey: "presenter", face: "body", role: "caption", color: "secondary" },
];

/** Rule width only; x/y are derived from the live `title` zone (`ruleAboveZone`). */
const RULE_W = 12;

export const titleLayout: SlideLayout = {
  id: "title",
  displayName: "Title",
  description: "Opening slide: deck title, a one-line subtitle, and optional presenter details.",
  intents: ["opening"],

  slots: [
    {
      key: "title", type: "text", required: true, typeRole: "display", maxChars: 50,
      description: "The deck's title. A short noun phrase, not a sentence. No trailing period.",
    },
    {
      key: "subtitle", type: "text", required: false, typeRole: "heading", maxChars: 80,
      description: "One line stating what the audience will take away from this deck.",
    },
    {
      key: "presenter", type: "text", required: false, typeRole: "caption", maxChars: 50,
      description: "Presenter name and/or date, only if the briefing supplies them. Omit otherwise.",
    },
  ],

  defaultZones: [
    { slotKey: "title", x: 8, y: 32, w: 84, h: 30, align: "left", valign: "bottom" },
    { slotKey: "subtitle", x: 8, y: 64, w: 80, h: 18, align: "left", valign: "top" },
    { slotKey: "presenter", x: 8, y: 84, w: 50, h: 8, align: "left", valign: "bottom" },
  ],

  FallbackRenderer: (args: RenderArgs): ReactNode => (
    <SlideFrame tokens={args.tokens}>
      <AccentRuleAbove args={args} slotKey="title" w={RULE_W} />
      {paintPreview(args, PAINT)}
    </SlideFrame>
  ),

  toPptx(target: PptxTarget, args: RenderArgs): void {
    // The brand background already carries the design language — don't paint over it.
    accentRuleAbovePptx(target, args, "title", RULE_W);
    paintPptx(target, args, PAINT);
  },
};
