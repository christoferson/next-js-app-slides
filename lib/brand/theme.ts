/**
 * `compileTheme(brand) → DesignTokens` (SPEC §5, CLAUDE.md §2 step 7).
 *
 * **Pure and deterministic.** Same brand in, byte-identical tokens out, every time. This is not
 * stylistic: the browser preview and the PPTX exporter each call this independently, so any
 * non-determinism here would make the export stop matching the preview the user trusts (§8).
 * Hence no `Date`, no randomness, no I/O, no mutation of the input.
 *
 * It is also the ONLY appearance input renderers receive. A renderer never sees a
 * `BrandDefinition`, so it cannot reach past the theme for a raw brand colour and thereby bypass
 * contrast repair — the guarantee holds by construction rather than by discipline.
 */

import type {
  BrandDefinition, ColorPair, DesignTokens, ThemeNotice, TypeScale,
} from "@/lib/brand/types";
import { bestTextOn, normalizeHex } from "@/lib/brand/contrast";
import { DEFAULT_BODY_FONT_ID, DEFAULT_HEADING_FONT_ID, resolveFont } from "@/lib/brand/fonts";

/**
 * Point sizes. Points, not px/rem, because PPTX is the authority — the preview derives CSS from
 * these, never the other way round, so the two cannot drift.
 */
const TYPE_SCALE: TypeScale = {
  display: 40,
  title: 32,
  heading: 24,
  body: 18,
  caption: 12,
};

/** Fallback when a brand colour is unparseable. The schema should have caught it; this is depth. */
const SAFE_FALLBACK = "808080";

const safeHex = (value: string): string => normalizeHex(value) ?? SAFE_FALLBACK;

/**
 * Tints (toward white) and shades (toward black) at fixed 20% steps. A fixed ladder rather than a
 * perceptual curve keeps the output reproducible and cheap; these are decorative accents (rules,
 * chart series, hover states), not text, so they are not contrast-checked.
 */
function ramp(hex: string, toward: "white" | "black"): string[] {
  const base = normalizeHex(hex);
  if (!base) return [];
  const r = parseInt(base.slice(0, 2), 16);
  const g = parseInt(base.slice(2, 4), 16);
  const b = parseInt(base.slice(4, 6), 16);
  const target = toward === "white" ? 255 : 0;
  return [0.2, 0.4, 0.6, 0.8].map((amount) => {
    const mix = (c: number) => Math.round(c + (target - c) * amount);
    return [mix(r), mix(g), mix(b)]
      .map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
  });
}

/**
 * Resolve one text-on-surface pairing, recording a notice if it had to be repaired.
 *
 * `large` is true for surfaces that only ever carry display/title text — a slide title at 32pt
 * qualifies as WCAG large text, so holding it to the 4.5:1 normal threshold would repair colours
 * that are already compliant, needlessly moving them away from the brand.
 */
function pairOn(
  label: string, bgHex: string, textOnLight: string, textOnDark: string,
  notices: ThemeNotice[], large: boolean,
): ColorPair {
  const bg = safeHex(bgHex);
  const result = bestTextOn(bg, safeHex(textOnLight), safeHex(textOnDark), large);
  if (result.repaired) {
    notices.push({
      kind: "contrast-repaired",
      message:
        `Text on the ${label} colour wasn't legible enough, so it was adjusted to meet ` +
        `accessibility contrast (now ${result.ratio.toFixed(1)}:1).`,
      detail: { surface: label, from: result.originalFg ?? "", to: result.fg, bg },
    });
  }
  return { bg, fg: result.fg };
}

export function compileTheme(brand: BrandDefinition): DesignTokens {
  const notices: ThemeNotice[] = [];

  const colors = brand.colors;
  const background = safeHex(colors.background);
  const surface = safeHex(colors.surface);
  const primary = safeHex(colors.primary);
  const accent = safeHex(colors.accent);
  const textOnLight = safeHex(colors.textOnLight);
  const textOnDark = safeHex(colors.textOnDark);

  /* ── fonts: an unknown id is a notice + safe default, never a crash ── */
  const headingFont = resolveFont(brand.fonts.heading);
  const bodyFont = resolveFont(brand.fonts.body);
  if (!headingFont || !bodyFont) {
    // Reachable when a brand references a font later removed from the registry — exactly what
    // happened to `aptos` (VERIFICATION.md §1.1). Degrade visibly rather than render nothing.
    notices.push({
      kind: "font-unmapped",
      message: "This brand uses a font that's no longer available, so a default was substituted.",
      detail: {
        ...(headingFont ? {} : { heading: brand.fonts.heading }),
        ...(bodyFont ? {} : { body: brand.fonts.body }),
      },
    });
  }
  const heading = headingFont ?? resolveFont(DEFAULT_HEADING_FONT_ID)!;
  const body = bodyFont ?? resolveFont(DEFAULT_BODY_FONT_ID)!;

  /* ── pairs: every surface a slide actually paints text on ── */
  // Backgrounds and surfaces carry body text, so they use the normal threshold. Primary and accent
  // are used as title/callout fills, where text is large.
  const pairs = {
    onBackground: pairOn("background", background, textOnLight, textOnDark, notices, false),
    onSurface: pairOn("surface", surface, textOnLight, textOnDark, notices, false),
    onPrimary: pairOn("primary", primary, textOnLight, textOnDark, notices, true),
    onAccent: pairOn("accent", accent, textOnLight, textOnDark, notices, true),
  };

  return {
    colors: {
      primary,
      secondary: safeHex(colors.secondary),
      accent,
      background,
      surface,
      textOnLight,
      textOnDark,
      primaryTints: ramp(primary, "white"),
      primaryShades: ramp(primary, "black"),
    },
    pairs,
    fonts: {
      headingPptx: heading.pptxName,
      bodyPptx: body.pptxName,
      headingCss: heading.webStack,
      bodyCss: body.webStack,
    },
    type: TYPE_SCALE,
    notices,
  };
}

/** Whether a compiled theme has anything to badge in the UI (§12 — never suppressed). */
export const hasThemeNotices = (tokens: DesignTokens): boolean => tokens.notices.length > 0;

/** Unused so far but part of the contract: contrast repair is reported, not hidden. */
export const contrastNotices = (tokens: DesignTokens): ThemeNotice[] =>
  tokens.notices.filter((n) => n.kind === "contrast-repaired");
