/**
 * `bullets` — the workhorse, and the **fallback layout** (SPEC §6).
 *
 * That second role constrains its design. `FallbackHandler` (§7.3) routes here whenever generation
 * fails for any reason: bad JSON, a failed repair, a model error. It must therefore be able to render
 * something useful from nothing more than the outline's `message` + `evidence`, which is precisely
 * `title` + `items`. Any additional *required* slot here would break that guarantee and produce the
 * blank slide §13 forbids — hence `takeaway` is optional.
 *
 * Budgets are computed, not chosen: `tests/layout-budgets` derives each zone's capacity from its own
 * geometry and the type scale and requires the declared budget to fit inside 85% of it. The list zone is
 * 84%×48% at `body` (18pt) ⇒ 67 chars/line × 7 lines, i.e. one line per item at 6 items, so
 * `itemMaxChars: 55`. An earlier draft claimed 100 chars would fit; it would not have.
 */

import type { ReactNode } from "react";
import type { PptxTarget, RenderArgs, SlideLayout } from "@/lib/layouts/types";
import {
  AccentRuleAbove, accentRuleAbovePptx, paintPptx, paintPreview, type SlotPaint,
} from "@/lib/layouts/paint";
import { SlideFrame } from "@/lib/layouts/preview";

const PAINT: readonly SlotPaint[] = [
  { slotKey: "title", face: "heading", role: "title", color: "onBackground" },
  { slotKey: "items", face: "body", role: "body", color: "onBackground", marker: "bullet" },
  { slotKey: "takeaway", face: "body", role: "caption", color: "accent", italic: true },
];

/** Rule width only; x/y are derived from the live `title` zone (`ruleAboveZone`). */
const RULE_W = 10;

export const bulletsLayout: SlideLayout = {
  id: "bullets",
  displayName: "Bullets",
  description: "A headline claim with supporting points. The default when nothing more specific fits.",
  intents: ["list", "detail"],

  slots: [
    {
      key: "title", type: "text", required: true, typeRole: "title", maxChars: 55,
      description: "The slide's single message, as a short assertion the bullets then support.",
    },
    {
      key: "items", type: "list", required: true, typeRole: "body",
      maxChars: 330, maxItems: 6, itemMaxChars: 55,
      description:
        "2–6 supporting points. Each one fact or argument, phrased as a clause rather than a "
        + "sentence. Do not repeat the title.",
    },
    {
      key: "takeaway", type: "text", required: false, typeRole: "caption", maxChars: 75,
      description: "One closing line naming the implication. Omit if the points speak for themselves.",
    },
  ],

  defaultZones: [
    { slotKey: "title", x: 8, y: 10, w: 84, h: 24, align: "left", valign: "top" },
    { slotKey: "items", x: 8, y: 36, w: 84, h: 48, align: "left", valign: "top" },
    { slotKey: "takeaway", x: 8, y: 86, w: 76, h: 8, align: "left", valign: "bottom" },
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
