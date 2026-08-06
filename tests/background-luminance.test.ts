/**
 * Text colour over a background IMAGE — the §2-step-15 defect (`lib/brand/background-luminance.ts`).
 *
 * The defect: `compileTheme` derives `pairs.onBackground` from `brand.colors.background`, a *colour*, but
 * in Templated mode the thing behind the text is an uploaded image. A white brand background with a
 * dark-navy image exported title slides whose text was in the XML and invisible on screen.
 *
 * Three levels are covered, because the defect could be reintroduced at any of them independently:
 *
 *  1. the pure substitution (`tokensForBackground` and friends) — table-tested;
 *  2. the decoder adapter's *degradation* contract, including the input that used to kill the process;
 *  3. the end-to-end claim — a dark image over a light brand yields light text — asserted through the
 *     real container so the wiring is under test, not just the helper.
 */

import { describe, expect, it } from "vitest";
import {
  LUMINANCE_DIVERGENCE, divergesFrom, greyOfLuminance, tokensForBackground,
  unreadableOverBackground,
} from "@/lib/brand/background-luminance";
import { AA_NORMAL, contrastRatio, parseHex, relativeLuminance } from "@/lib/brand/contrast";
import { compileTheme } from "@/lib/brand/theme";
import { buildRenderArgs } from "@/lib/layouts/render-args";
import { SharpImageLuminance } from "@/lib/adapters/sharp-image-luminance";
import { makeBrand } from "@/tests/fixtures";
import type { BrandDefinition, DesignTokens } from "@/lib/brand/types";
import type { ResolvedAsset } from "@/lib/domain/asset";

/**
 * White background, dark body text — the exact shape that produced the observed defect.
 *
 * `textOnDark` is `FAFAFA` rather than pure white on purpose: it makes every assertion below prove that
 * the repair uses the brand's own DECLARED light text colour, not a hardcoded `#FFFFFF`. With white the
 * two would be indistinguishable and a regression to a hardcoded value would pass.
 */
const lightBrand = (): BrandDefinition => makeBrand({
  colors: {
    primary: "1A3A6B", secondary: "4A5568", accent: "8B2635",
    background: "FFFFFF", surface: "F4F5F7",
    textOnLight: "111111", textOnDark: "FAFAFA",
  },
});

const lum = (hex: string): number => relativeLuminance(parseHex(hex)!);

/* ─────────────────────────────── the pure substitution ─────────────────────────────── */

describe("divergesFrom", () => {
  it("is false when the image matches the brand colour", () => {
    expect(divergesFrom("FFFFFF", lum("FFFFFF"))).toBe(false);
    expect(divergesFrom("0B0B14", lum("0B0B14"))).toBe(false);
  });

  it("catches BOTH directions, not just a dark image on a light brand", () => {
    // The symmetry is the point: a dark brand colour with a light photographic background is the same
    // bug with the colours swapped, and a "is the image dark" check would fix one and leave the other.
    expect(divergesFrom("FFFFFF", 0.016)).toBe(true);
    expect(divergesFrom("0B0B14", 0.95)).toBe(true);
  });

  it("ignores a gap inside the tolerance", () => {
    const base = lum("808080");
    expect(divergesFrom("808080", base + LUMINANCE_DIVERGENCE * 0.5)).toBe(false);
    expect(divergesFrom("808080", base + LUMINANCE_DIVERGENCE * 2)).toBe(true);
  });

  it("does not claim divergence for an unparseable colour", () => {
    // `compileTheme` already substituted a safe fallback for such a value; badging the brand here would
    // report a bug that lives somewhere else entirely.
    expect(divergesFrom("not-a-colour", 0.9)).toBe(false);
  });
});

describe("greyOfLuminance", () => {
  it("round-trips to the requested luminance within a rounding error", () => {
    for (const target of [0, 0.016, 0.1, 0.25, 0.5, 0.75, 1]) {
      expect(Math.abs(lum(greyOfLuminance(target)) - target)).toBeLessThan(0.01);
    }
  });

  it("is deterministic and clamps out-of-range input", () => {
    expect(greyOfLuminance(0.3)).toBe(greyOfLuminance(0.3));
    expect(greyOfLuminance(-5)).toBe("000000");
    expect(greyOfLuminance(50)).toBe("FFFFFF");
  });
});

describe("tokensForBackground", () => {
  const tokens = (): DesignTokens => compileTheme(lightBrand());

  it("returns the SAME object when there is nothing to adjust", () => {
    // Identity, not equality: the exporter dedupes backgrounds by object identity and the preview memoizes
    // on these tokens, so a fresh copy per render would be a real regression in both.
    const base = tokens();
    expect(tokensForBackground(base, undefined)).toBe(base);
    expect(tokensForBackground(base, { mean: lum("FFFFFF") })).toBe(base);
  });

  it("flips text to the light variant over a dark image on a light brand", () => {
    const base = tokens();
    expect(base.pairs.onBackground.fg).toBe("111111");

    const adjusted = tokensForBackground(base, { mean: 0.016 });
    expect(adjusted.pairs.onBackground.fg).toBe("FAFAFA");
  });

  it("produces an AA-legible pair against the image's actual luminance", () => {
    for (const mean of [0.0, 0.016, 0.05, 0.9, 1.0]) {
      const adjusted = tokensForBackground(tokens(), { mean });
      const surface = parseHex(greyOfLuminance(mean))!;
      const fg = parseHex(adjusted.pairs.onBackground.fg)!;
      expect(contrastRatio(fg, surface)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it("leaves colors.background and the other pairs alone", () => {
    const base = tokens();
    const adjusted = tokensForBackground(base, { mean: 0.016 });
    // `colors.background` is the letterbox bar colour and the slide fill — rewriting it would change a
    // visible surface the brand author chose.
    expect(adjusted.colors).toEqual(base.colors);
    expect(adjusted.pairs.onSurface).toEqual(base.pairs.onSurface);
    expect(adjusted.pairs.onPrimary).toEqual(base.pairs.onPrimary);
    expect(adjusted.pairs.onAccent).toEqual(base.pairs.onAccent);
  });

  it("reports the adjustment as a notice rather than applying it silently (§12)", () => {
    const base = tokens();
    const adjusted = tokensForBackground(base, { mean: 0.016 });

    expect(adjusted.notices.length).toBe(base.notices.length + 1);
    const notice = adjusted.notices.at(-1)!;
    expect(notice.kind).toBe("contrast-repaired");
    expect(notice.detail).toMatchObject({ surface: "background-image", from: "111111", to: "FAFAFA" });
    expect(notice.message).toContain("darker");
  });

  it("says 'lighter' for the inverted case", () => {
    const dark = compileTheme(makeBrand({
      colors: {
        primary: "1A3A6B", secondary: "4A5568", accent: "8B2635",
        background: "0B0B14", surface: "1A1A2E",
        textOnLight: "111111", textOnDark: "FAFAFA",
      },
    }));
    const adjusted = tokensForBackground(dark, { mean: 0.95 });
    expect(adjusted.pairs.onBackground.fg).toBe("111111");
    expect(adjusted.notices.at(-1)!.message).toContain("lighter");
  });

  it("is deterministic — the same inputs give byte-identical tokens (§8)", () => {
    expect(tokensForBackground(tokens(), { mean: 0.3 }))
      .toEqual(tokensForBackground(tokens(), { mean: 0.3 }));
  });
});

describe("unreadableOverBackground", () => {
  it("flags dark text over a dark image and clears it over a light one", () => {
    expect(unreadableOverBackground("111111", 0.016)).toBe(true);
    expect(unreadableOverBackground("111111", 0.95)).toBe(false);
  });
});

/* ─────────────────────────────── the single construction site (§8) ─────────────────────────────── */

describe("buildRenderArgs", () => {
  const asset = (over: Partial<ResolvedAsset> = {}): ResolvedAsset => ({
    id: "asset-1",
    filename: "bg.png",
    contentType: "image/png",
    byteSize: 10,
    kind: "background",
    createdAt: "2026-01-01T00:00:00.000Z",
    bytes: new Uint8Array([1, 2, 3]),
    ...over,
  } as ResolvedAsset);

  it("applies the adjustment so a layout cannot bypass it", () => {
    // This is what `stats`/`quote` depend on: they build their own boxes and never call the painters, so
    // an adjustment made inside `paintPptx` would skip exactly those layouts.
    const args = buildRenderArgs({
      slots: {}, tokens: compileTheme(lightBrand()), zones: [],
      background: asset({ luminance: 0.016 }),
    });
    expect(args.tokens.pairs.onBackground.fg).toBe("FAFAFA");
  });

  it("leaves tokens untouched when the background carries no sampled luminance", () => {
    const base = compileTheme(lightBrand());
    const args = buildRenderArgs({ slots: {}, tokens: base, zones: [], background: asset() });
    expect(args.tokens).toBe(base);
    // Presence still drives `isTemplated`, so the ornament suppression must survive.
    expect(args.background).toBeDefined();
  });

  it("omits background entirely in token-styled mode", () => {
    const args = buildRenderArgs({ slots: {}, tokens: compileTheme(lightBrand()), zones: [] });
    expect(args.background).toBeUndefined();
  });
});

/* ─────────────────────────────── the adapter's degradation contract ─────────────────────────────── */

describe("SharpImageLuminance", () => {
  const port = new SharpImageLuminance();

  /**
   * THE regression test for the process kill.
   *
   * `@napi-rs/canvas`'s `loadImage` SEGFAULTED on a buffer of ≤40 bytes — a native memory fault, so the
   * `try/catch` could not contain it and the whole process died. Reachable from an upload
   * (`POST /api/brands/:id/assets` hands the bytes straight to the port), and it took out five vitest
   * workers via the 4-byte fixture in `tests/brand-service.test.ts`.
   *
   * If this test ever *crashes the worker* rather than failing, the decoder has been swapped back for one
   * that faults instead of throwing.
   */
  it("returns null — and does not crash — for the short buffers that killed the old decoder", async () => {
    for (const length of [1, 4, 8, 33, 40]) {
      const truncated = new Uint8Array(length);
      truncated.set([0x89, 0x50, 0x4e, 0x47].slice(0, Math.min(4, length)));
      expect(await port.sample(truncated)).toBeNull();
    }
  });

  it("returns null for empty and non-image bytes", async () => {
    expect(await port.sample(new Uint8Array())).toBeNull();
    expect(await port.sample(new TextEncoder().encode("not an image at all"))).toBeNull();
  });

  it("samples a real PNG as a low mean and is deterministic", async () => {
    const { readFile } = await import("node:fs/promises");
    const bytes = new Uint8Array(await readFile("fixtures/bg-16x9.png"));

    const first = await port.sample(bytes);
    expect(first).not.toBeNull();
    // The dark-navy smoke fixture. A generous bound rather than the measured 0.0163 — this asserts "dark",
    // and pinning three decimals would make a libvips resampling change look like a defect.
    expect(first!.mean).toBeLessThan(0.1);
    expect(first!.mean).toBeGreaterThanOrEqual(0);
    expect(await port.sample(bytes)).toEqual(first);
  });

  it("rasterizes SVG rather than giving up on it", async () => {
    // An SVG background is a real SPEC §5 case; a bitmap-only decoder would silently return null.
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90">'
      + '<rect width="160" height="90" fill="#0B0B14"/></svg>',
    );
    const result = await port.sample(svg);
    expect(result).not.toBeNull();
    expect(result!.mean).toBeLessThan(0.1);
  });

  it("reports null for a fully transparent image rather than calling it black", async () => {
    // Returning 0 would make `divergesFrom` see a black surface and flip text to white over whatever is
    // actually behind it.
    const sharp = (await import("sharp")).default;
    const clear = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    expect(await port.sample(new Uint8Array(clear))).toBeNull();
  });

  it("drives the end-to-end claim: a dark image over a light brand yields light text", async () => {
    const { readFile } = await import("node:fs/promises");
    const bytes = new Uint8Array(await readFile("fixtures/bg-16x9.png"));
    const sampled = await port.sample(bytes);

    const args = buildRenderArgs({
      slots: {}, tokens: compileTheme(lightBrand()), zones: [],
      background: { luminance: sampled!.mean } as ResolvedAsset,
    });
    expect(args.tokens.pairs.onBackground.fg).toBe("FAFAFA");
  });
});
