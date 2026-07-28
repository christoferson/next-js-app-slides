/**
 * §2 step 7 — `theme.ts` (pure `compileTheme`).
 *
 * The properties worth testing here are the ones other layers *depend* on rather than the exact
 * colour values: purity/determinism (§8 preview-vs-export parity), pptxgenjs hex form (§1.1),
 * AA-legible pairs for every painted surface, and that every deviation from what the brand asked
 * for is REPORTED rather than silently applied (§12).
 */

import { describe, expect, it } from "vitest";
import { compileTheme, contrastNotices, hasThemeNotices } from "@/lib/brand/theme";
import { AA_LARGE, AA_NORMAL, contrastRatio, parseHex } from "@/lib/brand/contrast";
import { DEFAULT_BODY_FONT_ID, DEFAULT_HEADING_FONT_ID, resolveFont } from "@/lib/brand/fonts";
import { makeBrand } from "@/tests/fixtures";
import type { BrandDefinition, ColorPair } from "@/lib/brand/types";

const PAIR_KEYS = ["onBackground", "onSurface", "onPrimary", "onAccent"] as const;

/** Titles/callouts are large text, so those two surfaces are held to the 3:1 threshold. */
const thresholdFor = (key: (typeof PAIR_KEYS)[number]): number =>
  key === "onPrimary" || key === "onAccent" ? AA_LARGE : AA_NORMAL;

const ratio = (pair: ColorPair): number => contrastRatio(parseHex(pair.fg)!, parseHex(pair.bg)!);

/** A readable, already-compliant palette: nothing here should need repair. */
const cleanBrand = (over: Partial<BrandDefinition> = {}): BrandDefinition =>
  makeBrand({
    colors: {
      primary: "1A3A6B", secondary: "4A5568", accent: "8B2635",
      background: "FFFFFF", surface: "F4F5F7",
      textOnLight: "111111", textOnDark: "FFFFFF",
    },
    fonts: { heading: "georgia", body: "verdana" },
    ...over,
  });

describe("compileTheme — purity", () => {
  it("is deterministic across calls", () => {
    const brand = makeBrand();
    expect(compileTheme(brand)).toEqual(compileTheme(brand));
  });

  it("does not mutate the brand it was given", () => {
    const brand = makeBrand();
    const before = structuredClone(brand);
    compileTheme(brand);
    expect(brand).toEqual(before);
  });

  it("depends only on the brand — identical configs with different ids compile identically", () => {
    const a = compileTheme(makeBrand({ id: "BRAND_A", name: "A" }));
    const b = compileTheme(makeBrand({ id: "BRAND_B", name: "B" }));
    expect(a).toEqual(b);
  });
});

describe("compileTheme — colour output form", () => {
  it("emits only 6-digit uppercase hex without '#' (pptxgenjs's required form)", () => {
    const t = compileTheme(makeBrand());
    const values = [
      ...Object.values(t.colors).flat(),
      ...PAIR_KEYS.flatMap((k) => [t.pairs[k].bg, t.pairs[k].fg]),
    ];
    expect(values.length).toBeGreaterThan(10);
    for (const v of values) expect(v, v).toMatch(/^[0-9A-F]{6}$/);
  });

  it("derives 4 tints and 4 shades of primary, ordered away from the base colour", () => {
    const t = compileTheme(cleanBrand());
    expect(t.colors.primaryTints).toHaveLength(4);
    expect(t.colors.primaryShades).toHaveLength(4);
    // Tints get lighter, shades get darker — monotonic, so a UI can index them meaningfully.
    const lum = (hex: string) => {
      const { r, g, b } = parseHex(hex)!;
      return r + g + b;
    };
    const base = lum(t.colors.primary);
    let prev = base;
    for (const tint of t.colors.primaryTints) {
      expect(lum(tint)).toBeGreaterThan(prev);
      prev = lum(tint);
    }
    prev = base;
    for (const shade of t.colors.primaryShades) {
      expect(lum(shade)).toBeLessThan(prev);
      prev = lum(shade);
    }
  });

  it("passes the brand's colours through unchanged when they are already legible", () => {
    const brand = cleanBrand();
    const t = compileTheme(brand);
    expect(t.colors.primary).toBe(brand.colors.primary);
    expect(t.colors.background).toBe(brand.colors.background);
    expect(t.notices).toEqual([]);
    expect(hasThemeNotices(t)).toBe(false);
  });

  it("normalizes accepted input forms (#-prefixed, shorthand, lowercase)", () => {
    const t = compileTheme(cleanBrand({
      colors: {
        primary: "#1a3a6b", secondary: "#456", accent: "8b2635",
        background: "#fff", surface: "#F4F5F7",
        textOnLight: "#111", textOnDark: "#ffffff",
      },
    }));
    expect(t.colors.primary).toBe("1A3A6B");
    expect(t.colors.secondary).toBe("445566");
    expect(t.colors.background).toBe("FFFFFF");
  });
});

describe("compileTheme — contrast pairs", () => {
  it("every painted surface meets AA for its text size", () => {
    // Includes the loud fixture brand (#FF00AA primary), which does NOT pass unrepaired.
    for (const brand of [makeBrand(), cleanBrand()]) {
      const t = compileTheme(brand);
      for (const key of PAIR_KEYS) {
        expect(ratio(t.pairs[key]), `${brand.name}/${key}`)
          .toBeGreaterThanOrEqual(thresholdFor(key));
      }
    }
  });

  it("keeps the brand's declared surface colour — only text is adjusted", () => {
    const brand = makeBrand();
    const t = compileTheme(brand);
    expect(t.pairs.onBackground.bg).toBe(t.colors.background);
    expect(t.pairs.onSurface.bg).toBe(t.colors.surface);
    expect(t.pairs.onPrimary.bg).toBe(t.colors.primary);
    expect(t.pairs.onAccent.bg).toBe(t.colors.accent);
  });

  it("honours textOnLight vs textOnDark rather than always picking one", () => {
    const t = compileTheme(cleanBrand({
      colors: {
        primary: "0B0B14", secondary: "4A5568", accent: "1A3A6B",
        background: "FFFFFF", surface: "F4F5F7",
        textOnLight: "111111", textOnDark: "FAFAFA",
      },
    }));
    expect(t.pairs.onBackground.fg).toBe("111111"); // light surface → dark text
    expect(t.pairs.onPrimary.fg).toBe("FAFAFA");    // near-black surface → light text
  });

  it("reports a notice for every repair it makes, and never repairs silently", () => {
    // Both declared text colours are near-white, so light surfaces cannot be satisfied as declared.
    const t = compileTheme(cleanBrand({
      colors: {
        primary: "1A3A6B", secondary: "4A5568", accent: "8B2635",
        background: "FFFFFF", surface: "FFFFFF",
        textOnLight: "F0F0F0", textOnDark: "FAFAFA",
      },
    }));
    const repairs = contrastNotices(t);
    expect(repairs.length).toBeGreaterThanOrEqual(2);
    for (const n of repairs) {
      expect(n.kind).toBe("contrast-repaired");
      expect(n.message).toMatch(/contrast/i);
      expect(n.detail?.from).toMatch(/^[0-9A-F]{6}$/);
      expect(n.detail?.to).toMatch(/^[0-9A-F]{6}$/);
      expect(n.detail?.from).not.toBe(n.detail?.to);
    }
    // Notice count matches the number of pairs that actually differ from the declared text colour.
    const changed = PAIR_KEYS.filter(
      (k) => t.pairs[k].fg !== "F0F0F0" && t.pairs[k].fg !== "FAFAFA",
    );
    expect(repairs).toHaveLength(changed.length);
  });

  it("applies the large-text threshold to primary/accent, not the normal one", () => {
    // ~3.9:1 against white: legal for large text, so a title fill must NOT be repaired.
    const t = compileTheme(cleanBrand({
      colors: {
        primary: "949494", secondary: "4A5568", accent: "949494",
        background: "FFFFFF", surface: "F4F5F7",
        textOnLight: "FFFFFF", textOnDark: "FFFFFF",
      },
    }));
    expect(t.pairs.onPrimary.fg).toBe("FFFFFF");
    expect(t.pairs.onAccent.fg).toBe("FFFFFF");
    expect(contrastNotices(t).map((n) => n.detail?.surface)).not.toContain("primary");
  });
});

describe("compileTheme — fonts", () => {
  it("resolves registry ids to the verified pptx names and web stacks", () => {
    const t = compileTheme(cleanBrand());
    expect(t.fonts.headingPptx).toBe(resolveFont("georgia")!.pptxName);
    expect(t.fonts.bodyPptx).toBe(resolveFont("verdana")!.pptxName);
    expect(t.fonts.headingCss).toBe(resolveFont("georgia")!.webStack);
    expect(t.fonts.bodyCss).toBe(resolveFont("verdana")!.webStack);
  });

  it("resolves GATED entries too — gating is a picker policy, not a data migration", () => {
    const t = compileTheme(cleanBrand({ fonts: { heading: "cambria", body: "calibri" } }));
    expect(t.fonts.headingPptx).toBe("Cambria");
    expect(t.fonts.bodyPptx).toBe("Calibri");
    expect(t.notices).toEqual([]);
  });

  it("substitutes a default WITH a notice for a font that left the registry", () => {
    // `aptos` was dropped after the substitution measurement; brands referencing it must still open.
    const t = compileTheme(cleanBrand({ fonts: { heading: "aptos", body: "verdana" } }));
    expect(t.fonts.headingPptx).toBe(resolveFont(DEFAULT_HEADING_FONT_ID)!.pptxName);
    expect(t.fonts.bodyPptx).toBe(resolveFont(DEFAULT_BODY_FONT_ID)!.pptxName);
    const notice = t.notices.find((n) => n.kind === "font-unmapped");
    expect(notice).toBeDefined();
    expect(notice!.detail).toEqual({ heading: "aptos" });
  });

  it("reports both roles in one notice when both fonts are unknown", () => {
    const t = compileTheme(cleanBrand({ fonts: { heading: "zapfino", body: "comic_sans" } }));
    const unmapped = t.notices.filter((n) => n.kind === "font-unmapped");
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]!.detail).toEqual({ heading: "zapfino", body: "comic_sans" });
  });
});

describe("compileTheme — defence in depth", () => {
  it("does not throw on a malformed colour, and never emits invalid hex", () => {
    // The schema rejects this first; if it ever slips through, a deck must still render.
    const t = compileTheme(cleanBrand({
      colors: {
        primary: "not-a-colour", secondary: "", accent: "#GGGGGG",
        background: "FFFFFF", surface: "F4F5F7",
        textOnLight: "111111", textOnDark: "FFFFFF",
      },
    }));
    for (const v of [t.colors.primary, t.colors.secondary, t.colors.accent]) {
      expect(v).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  it("emits a full type scale in descending point sizes", () => {
    const { type } = compileTheme(makeBrand());
    const order = [type.display, type.title, type.heading, type.body, type.caption];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]!).toBeLessThan(order[i - 1]!);
    }
    expect(type.caption).toBeGreaterThan(0);
  });
});
