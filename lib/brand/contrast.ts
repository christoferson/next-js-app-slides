/**
 * WCAG contrast: measurement + deterministic repair (CLAUDE.md §2 step 7).
 *
 * Why repair at all: a user picks brand colours for a logo, not for legibility over a slide
 * background. Left alone, "on-brand" and "readable" conflict and the deck loses. So the theme
 * compiler measures every pairing a slide actually paints and, when one fails AA, adjusts it along
 * a single axis (lightness) until it passes — then REPORTS it (`contrast-repaired`, an amber badge,
 * §12). Silent repair would be worse than none: the user would think they chose the colour they see.
 *
 * "Deterministic" is load-bearing. The same brand must compile to the same tokens on every call —
 * browser preview and PPTX export run this independently, and a search that wandered would make
 * the preview stop matching the export (§8).
 *
 * All hex in and out is 6-digit uppercase WITHOUT `#`, because that is the only form pptxgenjs
 * accepts (§1.1). Parsing tolerates `#` and 3-digit shorthand on input.
 */

/** WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large (≥18pt, or ≥14pt bold). */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

export interface Rgb { r: number; g: number; b: number }

const clamp255 = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));

/** Accepts `#abc`, `abc`, `#AABBCC`, `AABBCC`. Returns null on anything else — never guesses. */
export function parseHex(hex: string): Rgb | null {
  const raw = hex.trim().replace(/^#/, "");
  const full = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** pptxgenjs form: 6-digit uppercase, no `#`. */
export const toHex = ({ r, g, b }: Rgb): string =>
  [r, g, b].map((c) => clamp255(c).toString(16).padStart(2, "0")).join("").toUpperCase();

/** Normalize any accepted input to the canonical form, or null if unparseable. */
export function normalizeHex(hex: string): string | null {
  const rgb = parseHex(hex);
  return rgb ? toHex(rgb) : null;
}

/** WCAG relative luminance (sRGB → linear, then the 0.2126/0.7152/0.0722 weighting). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1..21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const meetsAA = (fg: Rgb, bg: Rgb, large = false): boolean =>
  contrastRatio(fg, bg) >= (large ? AA_LARGE : AA_NORMAL);

/* ─────────────────────────────────── repair ─────────────────────────────────── */

export interface ContrastRepair {
  /** Canonical hex actually used. Equals the input when nothing needed changing. */
  fg: string;
  bg: string;
  ratio: number;
  repaired: boolean;
  /** The originally requested foreground, present only when it was changed. */
  originalFg?: string;
}

/**
 * Blend toward white or black by `amount` (0..1). Simple linear interpolation in sRGB: it is not
 * perceptually uniform, but it is monotonic in luminance, which is all the search below needs —
 * and unlike an HSL round-trip it cannot drift the hue.
 */
function mixToward(color: Rgb, target: Rgb, amount: number): Rgb {
  return {
    r: color.r + (target.r - color.r) * amount,
    g: color.g + (target.g - color.g) * amount,
    b: color.b + (target.b - color.b) * amount,
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** 20 fixed steps of 5%. A fixed ladder, not a binary search, so results are reproducible. */
const STEPS = Array.from({ length: 20 }, (_, i) => (i + 1) / 20);

/**
 * Make `fg` legible on `bg`, preserving the brand hue as far as possible.
 *
 * Strategy, in order:
 *  1. If the pair already passes, return it untouched — never "improve" a passing colour.
 *  2. Push `fg` away from `bg`'s luminance in fixed 5% steps, toward whichever pole is further
 *     from the background. Stop at the FIRST passing step, so the result stays as close to the
 *     brand colour as legibility allows.
 *  3. If even the pole fails (a mid-grey background can fail against both black and white at
 *     4.5:1), take the pole with the better ratio. Guarantees termination and the best available
 *     outcome instead of throwing.
 *
 * `fg` and `bg` are canonical hex; an unparseable value is returned unchanged and unrepaired so a
 * malformed colour surfaces as a schema error rather than being silently rewritten here.
 */
export function repairContrast(fgHex: string, bgHex: string, large = false): ContrastRepair {
  const fg = parseHex(fgHex);
  const bg = parseHex(bgHex);
  if (!fg || !bg) {
    return { fg: fgHex, bg: bgHex, ratio: 0, repaired: false };
  }

  const threshold = large ? AA_LARGE : AA_NORMAL;
  const current = contrastRatio(fg, bg);
  if (current >= threshold) {
    return { fg: toHex(fg), bg: toHex(bg), ratio: current, repaired: false };
  }

  // Move away from the background: a dark background gets a lighter foreground, and vice versa.
  const pole = relativeLuminance(bg) > 0.5 ? BLACK : WHITE;

  for (const amount of STEPS) {
    const candidate = mixToward(fg, pole, amount);
    const ratio = contrastRatio(candidate, bg);
    if (ratio >= threshold) {
      return {
        fg: toHex(candidate), bg: toHex(bg), ratio, repaired: true, originalFg: toHex(fg),
      };
    }
  }

  // Neither direction can reach the threshold (mid-grey background). Take the better pole.
  const whiteRatio = contrastRatio(WHITE, bg);
  const blackRatio = contrastRatio(BLACK, bg);
  const best = whiteRatio >= blackRatio ? WHITE : BLACK;
  return {
    fg: toHex(best), bg: toHex(bg), ratio: Math.max(whiteRatio, blackRatio),
    repaired: true, originalFg: toHex(fg),
  };
}

/**
 * Pick the more legible of a brand's two text colours for a given background, then repair if even
 * the better one falls short. This is how `compileTheme` derives every `ColorPair`: the brand
 * already declares `textOnLight`/`textOnDark`, so honour that intent first and only adjust as a
 * fallback.
 */
export function bestTextOn(
  bgHex: string, textOnLight: string, textOnDark: string, large = false,
): ContrastRepair {
  const bg = parseHex(bgHex);
  const light = parseHex(textOnLight);
  const dark = parseHex(textOnDark);
  if (!bg || !light || !dark) {
    return repairContrast(textOnDark, bgHex, large);
  }
  // `textOnLight` is meant for light backgrounds; compare both and take the higher ratio.
  const preferred = contrastRatio(light, bg) >= contrastRatio(dark, bg) ? textOnLight : textOnDark;
  return repairContrast(preferred, bgHex, large);
}
