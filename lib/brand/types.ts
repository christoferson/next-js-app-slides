/**
 * Brand domain types — SPEC §5, verbatim in shape.
 *
 * These are the *types*; the zod schema that validates them (incl. zone bounds and slotKey
 * cross-checks against the layout registry) is CLAUDE.md §2 step 7 (`lib/brand/brand-schema.ts`).
 * Types live here so ports can reference them without depending on validation.
 */

export type HorizontalAlign = "left" | "center" | "right";
export type VerticalAlign = "top" | "middle" | "bottom";

/**
 * A slot's placement, in PERCENT of the slide (0–100) — never inches, never EMU.
 *
 * Percent is the single source of truth precisely because two very different consumers read it:
 * the browser preview (→ CSS %) and `toPptx` (→ inches → EMU). §1.1 verified the percent→EMU
 * math is exact (0 EMU deviation), and §8 requires both consumers share one resolver + one
 * conversion util so the export matches the preview the user trusts.
 */
export interface SlotZone {
  slotKey: string;
  x: number;
  y: number;
  w: number;
  h: number;
  align: HorizontalAlign;
  valign: VerticalAlign;
}

/** A brand's customization of ONE layout. Absent background ⇒ token-styled render (SPEC §6). */
export interface LayoutTemplate {
  backgroundAssetId?: string;
  zones: SlotZone[];
}

export interface BrandColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  textOnLight: string;
  textOnDark: string;
}

/** FONTS registry ids (not raw family names) — the registry carries the pptx-safe `pptxName`. */
export interface BrandFonts {
  heading: string;
  body: string;
}

/** Asset ids, not URLs — resolution goes through `AssetStore`. */
export interface BrandLogo {
  light?: string;
  dark?: string;
}

/**
 * Tone is the ONLY brand field that may reach an LLM prompt (§7): it is content guidance, not
 * visual vocabulary. Colours, fonts, and zones must never appear in a prompt.
 */
export interface BrandTone {
  voice: string;
  traits: string[];
  bannedWords: string[];
}

export interface BrandDefinition {
  id: string;
  userId: string;
  name: string;
  colors: BrandColors;
  fonts: BrandFonts;
  logo?: BrandLogo;
  tone: BrandTone;
  /** Sparse: only layouts the user actually customized. Missing ⇒ layout `defaultZones`. */
  templates: Record<string, LayoutTemplate>;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
}

/* ────────────────────────────── Compiled theme ──────────────────────────────
 * `DesignTokens` is the OUTPUT of `compileTheme(brand)` (SPEC §5, built in CLAUDE.md §2 step 7)
 * and the ONLY appearance input a renderer or exporter receives. Two consequences:
 *  - Renderers never read a `BrandDefinition`, so they cannot accidentally depend on raw brand
 *    fields the theme compiler was supposed to derive or repair.
 *  - Contrast repair happens once, centrally, and is reported (`notices`) rather than hidden.
 * The type lives here with the other brand types; the pure compiler lives in `theme.ts`.
 */

/** A colour plus the text colour that is AA-legible on it — computed together, never guessed. */
export interface ColorPair {
  /** 6-digit uppercase hex WITHOUT `#` — pptxgenjs's required form (§1.1). */
  bg: string;
  fg: string;
}

/** Point sizes. Points (not px/rem) because PPTX is the authority; CSS derives from these. */
export interface TypeScale {
  display: number;
  title: number;
  heading: number;
  body: number;
  caption: number;
}

/** Why a token differs from what the brand literally asked for. Surfaced as amber badges (§12). */
export interface ThemeNotice {
  kind: "contrast-repaired" | "font-unmapped";
  /** Already user-readable. */
  message: string;
  detail?: Record<string, string>;
}

export interface DesignTokens {
  /** All hex values here are 6-digit uppercase and `#`-less, ready for pptxgenjs. */
  colors: BrandColors & {
    /** Derived tints/shades of `primary`, light → dark. */
    primaryTints: string[];
    primaryShades: string[];
  };
  /** Contrast-safe pairings for the surfaces a slide actually paints. */
  pairs: {
    onBackground: ColorPair;
    onSurface: ColorPair;
    onPrimary: ColorPair;
    onAccent: ColorPair;
  };
  fonts: {
    /** PowerPoint-safe family names resolved from the FONTS registry (`pptxName`). */
    headingPptx: string;
    bodyPptx: string;
    /** CSS font stacks for the browser preview. */
    headingCss: string;
    bodyCss: string;
  };
  type: TypeScale;
  notices: ThemeNotice[];
}

/**
 * What `BrandRepository.list()` returns — enough for the gallery (palette strip, logo,
 * template count) without loading every full config. A DynamoDB impl can project exactly these
 * attributes; a file impl reads the file and drops the rest. Same semantics either way.
 */
export interface BrandSummary {
  id: string;
  name: string;
  colors: BrandColors;
  fonts: BrandFonts;
  logo?: BrandLogo;
  /** Layout ids with a brand-defined template — drives the gallery's template thumbnails. */
  templatedLayoutIds: string[];
  createdAt: string;
  updatedAt: string;
}
