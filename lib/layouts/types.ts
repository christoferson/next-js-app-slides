/**
 * The layout registry contract (SPEC §6, CLAUDE.md §4).
 *
 * A layout definition is ONE object in ONE file, and every consumer reads it: prompt construction,
 * zod validation, the brand editor's zone seeding, mapping intents, the browser renderer, and PPTX
 * export. CLAUDE.md §10 makes that testable — adding a layout must be one new file plus one registry
 * line, with `git diff --stat` as the proof. Any parallel hardcoded table is the abstraction leaking.
 *
 * The `SlotSpec` is the load-bearing part. It is simultaneously:
 *   - the *prompt* contract (key + description + budget, sent verbatim — §7.3),
 *   - the *validation* contract (`compileSlotSchema` derives zod from it — `validate.ts`),
 *   - the *budget* contract (§1.1/C1: `fit:'shrink'` never shrinks, so `maxChars` is the only thing
 *     between an over-long model response and a broken slide),
 * which is why it is data rather than three hand-kept copies.
 */

import type { ReactNode } from "react";
import type { DesignTokens, SlotZone } from "@/lib/brand/types";
import type { SlotValues } from "@/lib/domain/slots";
import type { VisualHint } from "@/lib/domain/deck";
import type { ResolvedAsset } from "@/lib/domain/asset";

export type SlotType = "text" | "list";

/** A step on the compiled theme's `TypeScale`. See `SlotSpec.typeRole`. */
export type TypeRole = "display" | "title" | "heading" | "body" | "caption";

export interface SlotSpec {
  key: string;
  type: SlotType;
  required: boolean;
  /**
   * Which step of `DesignTokens.type` this slot renders at.
   *
   * **A deliberate addition to SPEC §6's `SlotSpec`.** Without it the point size lives inside each
   * layout's `toPptx` *and* its `FallbackRenderer`, so the two can drift — and, more importantly,
   * `maxChars` becomes unverifiable: a character budget only means something relative to a box size
   * and a font size. With it, `tests/layout-budgets` can check every declared budget against the
   * capacity its own `defaultZones` + type scale actually provide (`estimateCapacity`), which is what
   * turns §1.1/C1's "truncation is our only lever" from a hope into an arithmetic invariant.
   */
  typeRole: TypeRole;
  /**
   * Hard character budget. Over-budget text is truncated at a word boundary and flagged `trimmed`
   * (§9) — NOT shrunk to fit, because §1.1/C1 proved `fit:'shrink'` emits a scale-less
   * `<a:normAutofit/>` that no renderer honours. Budgets are calibrated from measured box widths
   * (avg advance ≈ 0.5em) recorded in VERIFICATION.md §1.1/C1.
   */
  maxChars: number;
  /** `list` only — maximum items kept; extras are dropped and flagged. */
  maxItems?: number;
  /** `list` only — per-item budget. */
  itemMaxChars?: number;
  /**
   * Sent to the model verbatim. Content guidance ONLY: no colour, font, size, or coordinate may
   * appear here or the §7 prompt-purity test fails the build.
   */
  description: string;
}

/** What a renderer or `toPptx` receives — appearance via tokens/zones only, never a brand. */
export interface RenderArgs {
  slots: SlotValues;
  tokens: DesignTokens;
  /** Already resolved: brand template zones if present, else the layout's `defaultZones`. */
  zones: SlotZone[];
  /** Present only in Templated mode. */
  background?: ResolvedAsset;
}

/**
 * A layout's token-styled React renderer (SPEC §6 `FallbackRenderer`).
 *
 * Typed structurally rather than as `React.ComponentType` so this module — imported by services and
 * by the export path — does not force a React *value* import into a server-only bundle.
 */
export type SlotRenderer = (props: RenderArgs) => ReactNode;

/**
 * The pptxgenjs surfaces a `toPptx` may touch.
 *
 * Deliberately a narrow interface instead of pptxgenjs's `Slide`: layout files then have no
 * dependency on the library, which keeps `lib/layouts` importable from the client (the brand editor
 * needs `slots`, `defaultZones` and `displayName`) and keeps §5's boundary lint satisfied without a
 * per-file exemption. The exporter passes an adapter over the real slide.
 */
export interface PptxTarget {
  /** ALWAYS routes bullets through the one shared helper that stamps `breakLine` (§1.1/C5). */
  addText(runs: PptxTextRun[], options: PptxTextOptions): void;
  addImage(options: PptxImageOptions): void;
  addShape(shape: "rect" | "line", options: PptxShapeOptions): void;
  addNotes(text: string): void;
}

export interface PptxTextRun {
  text: string;
  options?: {
    /**
     * `numberStartAt` is MANDATORY on a numbered run and is 1-based — pptxgenjs writes
     * `startAt` on every paragraph regardless, defaulting it to 1, and a `startAt` restarts the
     * OOXML sequence. Omitting it renders every item as "1." (probe: `verify-pptx-numbering.ts`).
     */
    bullet?: boolean | { type: "number"; numberStartAt: number };
    /** Set by the shared bullet helper, never by a layout — see §1.1/C5. */
    breakLine?: boolean;
    bold?: boolean;
    italic?: boolean;
    color?: string;
    fontSize?: number;
    fontFace?: string;
    indentLevel?: number;
  };
}

/** Inches, matching pptxgenjs's native unit — `zoneToInches` produces them. */
export interface PptxTextOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  fontFace?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  lineSpacingMultiple?: number;
  /**
   * Always `'none'`. §1.1/C1: `'shrink'` promises behaviour it does not deliver, and its presence
   * changes overflow from spill to clip in at least one renderer — silent content loss.
   */
  fit?: "none";
}

export interface PptxImageOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  data?: string;
  path?: string;
  sizing?: never; // §1.1/C2 — unusable; `placeBackground` computes explicit geometry instead.
}

export interface PptxShapeOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: { color: string };
  line?: { color: string; width: number };
}

/**
 * ONE registry entry. Everything a consumer needs about a layout lives here (CLAUDE.md §4).
 */
export interface SlideLayout {
  id: string;
  displayName: string;
  /** Shown in the layout switcher and the brand editor. Not sent to the model. */
  description: string;
  /**
   * Mapping vocabulary. `IntentMatchRule` matches an outline slide's `visualHint` against this
   * (SPEC §7.2), so adding a layout with new intents needs no rule changes.
   */
  intents: readonly VisualHint[];
  slots: readonly SlotSpec[];
  /**
   * Seeds the brand editor and is the fallback when a brand defines no template for this layout.
   * MUST cover every required slot — enforced at registry load (CLAUDE.md §4).
   */
  defaultZones: readonly SlotZone[];
  /** Token-styled render (no brand background). */
  FallbackRenderer: SlotRenderer;
  toPptx(target: PptxTarget, args: RenderArgs): void;
}

/* ── registry helpers used by every consumer, so nobody re-derives them ── */

export const slotByKey = (layout: SlideLayout, key: string): SlotSpec | undefined =>
  layout.slots.find((s) => s.key === key);

export const requiredSlots = (layout: SlideLayout): readonly SlotSpec[] =>
  layout.slots.filter((s) => s.required);

/** What `brand-schema.ts`'s injected `LayoutLookup` needs — see its header for why it's injected. */
export const layoutSlotKeys = (layout: SlideLayout): string[] => layout.slots.map((s) => s.key);
