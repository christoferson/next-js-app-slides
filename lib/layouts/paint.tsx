/**
 * The shared zone painter — one declaration, two renderers.
 *
 * ## Why this exists
 *
 * §8 requires the browser preview and the PPTX export to agree. `zone-math.ts` guarantees they agree
 * on *geometry*, but each layout still had to describe its slots twice — once in JSX, once in
 * `toPptx` — and those two descriptions are exactly where "the export doesn't match the preview" bugs
 * come from. Nothing forces a layout author to keep them in step; a copy-paste that leaves one at
 * `type.heading` and the other at `type.body` produces a difference no test would think to look for.
 *
 * So a layout declares each slot's *painting* once, as data (`SlotPaint`), and both renderers are
 * derived from that declaration. Divergence stops being possible rather than being discouraged.
 *
 * It also concentrates the two §1.1 constraints in one place: every list goes through
 * `addZoneBullets` (so `breakLine` is always stamped — C5), and every text box gets `fit:'none'`
 * (C1). A layout cannot opt out, because it never touches the pptx API.
 *
 * Layouts still own everything genuinely layout-specific — accent rules, panels, quote marks, stat
 * cards — through `ornaments`. This is a painter for slot content, not a layout engine.
 */

import type { ReactNode } from "react";
import type { DesignTokens, SlotZone } from "@/lib/brand/types";
import { isListSlot, isTextSlot } from "@/lib/domain/slots";
import type { PptxTarget, RenderArgs, TypeRole } from "@/lib/layouts/types";
import { zoneFor } from "@/lib/layouts/render-mode";
import {
  addZoneBullets, addZoneText, bodyStyle, headingStyle, type TextStyle,
} from "@/lib/layouts/pptx-text";
import {
  ZoneList, ZoneText, previewBody, previewHeading, type ZoneStyle,
} from "@/lib/layouts/preview";

/** How one slot is painted. Declared once per layout; consumed by both renderers. */
export interface SlotPaint {
  slotKey: string;
  /** `heading` uses the brand's heading face and bold; `body` uses the body face. */
  face: "heading" | "body";
  role: TypeRole;
  /**
   * Which compiled `ColorPair`'s foreground to use, or a literal token colour.
   *
   * Naming a *pair* rather than a colour is what keeps contrast repair unbypassable: the painter can
   * only ask for "the legible text colour on the surface this slot sits on", and `compileTheme`
   * already decided what that is (repairing and reporting it if needed). A layout cannot request a
   * raw brand colour for text.
   */
  color: "onBackground" | "onSurface" | "onPrimary" | "onAccent" | "accent" | "secondary";
  /** List slots only. */
  marker?: "bullet" | "number" | "none";
  italic?: boolean;
}

/** The appearance half of a `SlotPaint`, without the slot it applies to. */
export type PaintStyle = Pick<SlotPaint, "face" | "role" | "color" | "italic">;

export const colorOf = (tokens: DesignTokens, color: SlotPaint["color"]): string => {
  switch (color) {
    case "accent": return tokens.colors.accent;
    case "secondary": return tokens.colors.secondary;
    default: return tokens.pairs[color].fg;
  }
};

const sizeOf = (tokens: DesignTokens, role: TypeRole): number => tokens.type[role];

/**
 * `PaintStyle` → preview style, and its `pptxStyleFor` twin below.
 *
 * Exported because a layout with repeated structure (`stats`' three cards) can't express itself as a
 * flat slot list and must call the leaf renderers itself. Those layouts still derive *style* here, so
 * the only thing they own is which box each string goes in — the face, size, colour and italic
 * decisions stay in one place for both renderers (§8).
 */
export const previewStyleFor = (tokens: DesignTokens, p: PaintStyle): ZoneStyle => {
  const size = sizeOf(tokens, p.role);
  const color = colorOf(tokens, p.color);
  const style = p.face === "heading"
    ? previewHeading(tokens, size, color)
    : previewBody(tokens, size, color);
  return p.italic ? { ...style, italic: true } : style;
};

export const pptxStyleFor = (tokens: DesignTokens, p: PaintStyle): TextStyle => {
  const size = sizeOf(tokens, p.role);
  const color = colorOf(tokens, p.color);
  const style = p.face === "heading"
    ? headingStyle(tokens, size, color)
    : bodyStyle(tokens, size, color);
  return p.italic ? { ...style, italic: true } : style;
};

/* ─────────────────────────────── preview ─────────────────────────────── */

/** Paint every declared slot into the preview. Missing slots and missing zones render nothing. */
export function paintPreview(args: RenderArgs, paints: readonly SlotPaint[]): ReactNode {
  const { slots, tokens, zones } = args;

  return paints.map((paint) => {
    const zone = zoneFor(zones, paint.slotKey);
    if (!zone) return null;

    const styled = previewStyleFor(tokens, paint);

    const value = slots[paint.slotKey];
    if (isListSlot(value)) {
      return (
        <ZoneList
          key={paint.slotKey} zone={zone} style={styled} items={value}
          marker={paint.marker ?? "bullet"}
        />
      );
    }
    if (isTextSlot(value)) {
      return <ZoneText key={paint.slotKey} zone={zone} style={styled} text={value} />;
    }
    return null;
  });
}

/* ─────────────────────────────── pptx ─────────────────────────────── */

/**
 * Paint every declared slot into a pptx slide.
 *
 * Returns the paragraph counts written per list slot, so the exporter can run C5's
 * `assertParagraphCount` against its own serialized output.
 */
export function paintPptx(
  target: PptxTarget, args: RenderArgs, paints: readonly SlotPaint[],
): { listParagraphs: Record<string, number> } {
  const { slots, tokens, zones } = args;
  const listParagraphs: Record<string, number> = {};

  for (const paint of paints) {
    const zone = zoneFor(zones, paint.slotKey);
    if (!zone) continue;

    const style = pptxStyleFor(tokens, paint);

    const value = slots[paint.slotKey];
    if (isListSlot(value)) {
      const marker = paint.marker ?? "bullet";
      listParagraphs[paint.slotKey] = addZoneBullets(
        target, zone, value, style,
        marker === "none" ? {} : { type: marker === "number" ? "number" : "bullet" },
      );
      continue;
    }
    if (isTextSlot(value)) {
      addZoneText(target, zone, value, style);
    }
  }

  return { listParagraphs };
}

/** Convenience for the common case: a layout whose painting is fully declarative. */
export const textOf = (args: RenderArgs, key: string): string | undefined => {
  const value = args.slots[key];
  return isTextSlot(value) ? value : undefined;
};

export const listOf = (args: RenderArgs, key: string): readonly string[] | undefined => {
  const value = args.slots[key];
  return isListSlot(value) ? value : undefined;
};

/**
 * Whether this render is Templated (a brand background is present) rather than TokenStyled.
 *
 * Layouts use it to suppress their own ornaments — accent rules, panels — in Templated mode. The
 * brand's background image already carries that design language, and painting our rule on top of it
 * is exactly the "off-brand by accident" outcome the whole template system exists to prevent. Slot
 * *content* is painted identically in both modes; only ornament differs.
 */
export const isTemplated = (args: RenderArgs): boolean => args.background !== undefined;

/**
 * An accent bar in the brand's accent colour — the token-styled decks' one shared ornament.
 * Horizontal by default (`h: 1.2`); pass a tall `h` with a narrow `w` for a vertical rule.
 */
export function AccentRule(
  { tokens, x, y, w = 12, h = 1.2 }: {
    tokens: DesignTokens; x: number; y: number; w?: number; h?: number;
  },
): ReactNode {
  return (
    <div
      style={{
        position: "absolute", left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`,
        backgroundColor: `#${tokens.colors.accent}`,
      }}
    />
  );
}

/** The pptx twin of `AccentRule`. Same signature, same defaults, so the ornament cannot drift (§8). */
export function accentRulePptx(
  target: PptxTarget, tokens: DesignTokens, x: number, y: number, w = 12, h = 1.2,
): void {
  target.addShape("rect", {
    x: (x / 100) * 10, y: (y / 100) * 5.625, w: (w / 100) * 10, h: (h / 100) * 5.625,
    fill: { color: tokens.colors.accent },
  });
}

/**
 * Where a rule that sits ABOVE a slot's zone goes, derived from the live zone.
 *
 * ## Why this is computed rather than written down
 *
 * `title`, `agenda`, `bullets` and `closing` each declared a literal `RULE = { x, y }` whose `y` had
 * been picked to land just under a ONE-LINE title. Three of the four were inside their own title zone,
 * so as soon as the title wrapped to the second line the accent bar rendered as a strike-through
 * across it — visible in the step-13 fixture render (`out/render/fixture-token/page-02.png`), and
 * caused by the ornament holding a private, stale copy of a number that lives in the zone.
 *
 * Zones are user-editable, so that copy could never stay correct: moving a title in the brand editor's
 * zone table would silently re-break it. Anchoring to `zone.y` makes the two agree by construction,
 * which is the §8 argument applied to ornaments instead of slot content.
 *
 * Above rather than below, because a rule under a variable-height text block either floats (short
 * title) or is overrun (wrapped title) — the top edge is the only edge that does not move with the
 * content. Returns `undefined` when the zone is absent so a layout renders without its ornament
 * rather than throwing.
 */
export function ruleAboveZone(
  args: RenderArgs, slotKey: string, w = 12,
): { x: number; y: number; w: number } | undefined {
  const zone = zoneFor(args.zones, slotKey);
  if (!zone) return undefined;
  // One rule height plus the same again as breathing room. `Math.max` keeps the bar on the slide for a
  // zone flush to the top edge; it then abuts the text instead of being clipped, which is the better
  // of the two bad outcomes for a zone the user placed at y:0.
  return { x: zone.x, y: Math.max(0, zone.y - RULE_GAP), w };
}

/** Rule height (1.2%) + an equal gap. Named so the preview and the exporter cannot pick different ones. */
const RULE_GAP = 2.4;

/**
 * The paired renderers for "an accent rule above this slot's zone" — the shape `title`, `agenda`,
 * `bullets` and `closing` all wanted.
 *
 * Paired deliberately, in the same spirit as `paintPptx`/`paintPreview`: a layout that derived the
 * geometry itself would have to call `ruleAboveZone` twice, and the §8 failure mode is precisely two
 * call sites drifting apart. Here both consume one function, and the absent-zone and Templated cases
 * are decided once rather than in four layouts.
 */
export function AccentRuleAbove(
  { args, slotKey, w }: { args: RenderArgs; slotKey: string; w?: number },
): ReactNode {
  const rule = ruleAboveZone(args, slotKey, w);
  // The preview shows ornaments in TokenStyled mode only, matching `accentRuleAbovePptx` — a preview
  // that drew a rule the export omits is the §8 mismatch the user would report as an export bug.
  if (!rule || isTemplated(args)) return null;
  return <AccentRule tokens={args.tokens} {...rule} />;
}

export function accentRuleAbovePptx(
  target: PptxTarget, args: RenderArgs, slotKey: string, w?: number,
): void {
  const rule = ruleAboveZone(args, slotKey, w);
  if (!rule || isTemplated(args)) return;
  accentRulePptx(target, args.tokens, rule.x, rule.y, rule.w);
}

/** A filled panel behind a zone — `two_column`, `stats`, and `quote` use it. */
export function Panel(
  { color, x, y, w, h }: { color: string; x: number; y: number; w: number; h: number },
): ReactNode {
  return (
    <div
      style={{
        position: "absolute", left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`,
        backgroundColor: `#${color}`, borderRadius: "0.5cqh",
      }}
    />
  );
}

export function panelPptx(
  target: PptxTarget, color: string, x: number, y: number, w: number, h: number,
): void {
  target.addShape("rect", {
    x: (x / 100) * 10, y: (y / 100) * 5.625, w: (w / 100) * 10, h: (h / 100) * 5.625,
    fill: { color },
  });
}

export type { SlotZone };
