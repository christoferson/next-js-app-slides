/**
 * Text colour over a background IMAGE (the §2-step-15 open defect).
 *
 * ## The defect this closes
 *
 * `compileTheme(brand)` derives `pairs.onBackground` from `brand.colors.background` — a *colour*. In
 * Templated mode the thing behind the text is not that colour, it is an uploaded image. When the two
 * disagree in luminance, `bestTextOn` picks a foreground that is correct for the colour it was given and
 * invisible against the image.
 *
 * The smoke run (VERIFICATION.md §2 step 15) is the observed case: a brand with `background: #FFFFFF` and
 * a dark-navy background image exported two `title` slides whose text was present in the XML
 * (`srgbClr val="1A1A2E"`) and unreadable on screen. The browser preview shared the flaw exactly, because
 * `SlideFrame` layers the image over the same token — so this was never an §8 preview-vs-export
 * divergence, and the §8 remedy would not have touched it.
 *
 * ## Why the fix is HERE and not in `compileTheme`
 *
 * `pairs.onBackground` is per-BRAND; a background image is per-LAYOUT. A brand may template `title` with
 * a dark image and leave `bullets` token-styled, and those two slides need different text colours from one
 * `DesignTokens`. So this cannot be another `compileTheme` argument — it is a per-render adjustment of one
 * pair, applied where the render plan is already known.
 *
 * It is applied in `tokensForBackground` below, which BOTH renderers reach through `RenderArgs`
 * (`lib/layouts/paint.tsx`'s `colorOf` reads `tokens.pairs.onBackground.fg` in each). One function, two
 * consumers — the same construction §8 uses for geometry, applied to colour.
 *
 * ## Pure, like the rest of `lib/brand`
 *
 * Sampling an image needs a decoder, which is native and server-only. That work is behind
 * `ImageLuminancePort`; this module takes the *number* it produced. So the substitution stays pure and
 * deterministic (`compileTheme`'s contract), and `lib/brand` acquires no IO — which is also what keeps it
 * importable by the client-side brand editor.
 */

import type { ColorPair, DesignTokens, ThemeNotice } from "@/lib/brand/types";
import { bestTextOn, contrastRatio, parseHex, relativeLuminance, toHex } from "@/lib/brand/contrast";

/**
 * Mean WCAG relative luminance of an image's pixels, 0..1. Alpha-weighted: a mostly-transparent PNG is
 * described by the pixels that will actually be seen, not by the ones the compositor discards.
 *
 * Named as a branded-ish field rather than a bare `number` on `AssetMeta` so a caller cannot pass a
 * *contrast ratio* or an 0..255 grey level by mistake — the two most plausible confusions here.
 */
export interface BackgroundLuminance {
  /** 0 = black, 1 = white. WCAG relative luminance, same curve `lib/brand/contrast.ts` uses. */
  mean: number;
}

/**
 * How far the image's luminance may sit from the brand colour's before the pair is re-derived.
 *
 * 0.15 in WCAG relative-luminance space. Chosen so the case that must be caught is caught with room to
 * spare (`#FFFFFF` = 1.0 against the smoke fixture's 0.016 image is a gap of ~0.98), while a background
 * colour the author picked to approximate their image is left alone — re-deriving a pair that already
 * works would move text off the brand's declared `textOnLight`/`textOnDark` for no legibility gain.
 *
 * A gap is the trigger rather than "the image is dark", because the failure is symmetric: a dark brand
 * colour with a light photographic background is the same bug with the colours swapped, and a
 * dark-only check would fix one direction and leave the other.
 */
export const LUMINANCE_DIVERGENCE = 0.15;

/** WCAG AA for large text. Slot content over a background image is titles and body both, so the pair is */
/** re-derived at the same normal/large split `compileTheme` uses — see `large` below. */
const AA_LARGE = 3;

/**
 * Whether `mean` is far enough from `colorHex`'s luminance to matter.
 *
 * Exported for the brand editor's amber badge (§12) and for tests; `tokensForBackground` is the path
 * renderers use.
 */
export function divergesFrom(colorHex: string, mean: number): boolean {
  const rgb = parseHex(colorHex);
  // Unparseable is not divergence: `compileTheme` already substituted `SAFE_FALLBACK` for that colour, and
  // claiming a mismatch against a value nobody chose would badge a brand for a bug elsewhere.
  if (!rgb) return false;
  return Math.abs(relativeLuminance(rgb) - mean) > LUMINANCE_DIVERGENCE;
}

/**
 * The nearest grey with the image's luminance — the surface `bestTextOn` is asked about.
 *
 * A grey rather than the image's mean *colour*: hue carries no legibility information at all (WCAG
 * luminance discards it), and a mean hue over a photograph is a muddy value that would make the repair
 * notice read as though we had invented a brand colour. Solving luminance directly says what we mean.
 *
 * Binary search over the sRGB→linear curve, 12 iterations — deterministic and well inside a rounding
 * error of the target, which `compileTheme`'s byte-identical-output contract requires (§8).
 */
export function greyOfLuminance(mean: number): string {
  const target = Math.min(1, Math.max(0, mean));
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 12; i += 1) {
    const mid = (lo + hi) / 2;
    if (relativeLuminance({ r: mid, g: mid, b: mid }) < target) lo = mid;
    else hi = mid;
  }
  const v = Math.round((lo + hi) / 2);
  return toHex({ r: v, g: v, b: v });
}

/**
 * `DesignTokens` adjusted for the background actually behind the text.
 *
 * Returns the SAME object when there is no background, when its luminance is unknown, or when it agrees
 * with the brand colour — identity being preserved matters because the export path resolves one asset per
 * distinct background and compares by object identity (`resolveRenderAssets`), and because a `useMemo` in
 * the preview should not invalidate on every render for a token-styled slide.
 *
 * Only `pairs.onBackground` moves. `colors.background` is deliberately left alone: it is what the preview
 * paints behind a letterboxed image and what the exporter writes as the slide fill, so rewriting it would
 * change the visible bar colour to something the brand author never chose. `onSurface`/`onPrimary`/
 * `onAccent` are painted on shapes the layout fills itself, which the image does not sit behind.
 */
export function tokensForBackground(
  tokens: DesignTokens,
  luminance: BackgroundLuminance | undefined,
): DesignTokens {
  if (!luminance) return tokens;
  if (!divergesFrom(tokens.colors.background, luminance.mean)) return tokens;

  const surface = greyOfLuminance(luminance.mean);
  // `large: false` — the normal 4.5:1 threshold, matching `compileTheme`'s own `onBackground`. A
  // background image sits behind body text as often as behind a title (`bullets`, `agenda`), so the
  // large-text relaxation would under-repair exactly the slides with the most text on them.
  const repair = bestTextOn(surface, tokens.colors.textOnLight, tokens.colors.textOnDark, false);

  const pair: ColorPair = { bg: tokens.colors.background, fg: repair.fg };
  const notice: ThemeNotice = {
    kind: "contrast-repaired",
    message:
      "This layout's background image is much " +
      `${luminance.mean < 0.5 ? "darker" : "lighter"} than the brand's background colour, so the ` +
      "text colour was adjusted to stay readable on it.",
    detail: {
      surface: "background-image",
      from: tokens.pairs.onBackground.fg,
      to: repair.fg,
      bg: surface,
    },
  };

  return {
    ...tokens,
    pairs: { ...tokens.pairs, onBackground: pair },
    // Appended, not replaced: a font-unmapped or contrast-repaired notice from `compileTheme` is still
    // true, and §12 says quality badges are never suppressed.
    notices: [...tokens.notices, notice],
  };
}

/**
 * Whether text at `fg` would be unreadable over an image of this luminance — the question the brand
 * editor's badge asks, independent of whether we repaired anything.
 *
 * Uses the large-text threshold deliberately: this reports a problem to a human, and flagging a 3.2:1
 * title as broken would cry wolf on a design that is within AA.
 */
export const unreadableOverBackground = (fg: string, mean: number): boolean => {
  const text = parseHex(fg);
  const surface = parseHex(greyOfLuminance(mean));
  if (!text || !surface) return false;
  return contrastRatio(text, surface) < AA_LARGE;
};
