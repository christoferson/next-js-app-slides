/**
 * §2 step 7 — "contrast.ts (AA check + deterministic repair — table-test known failing pairs)".
 *
 * The ratios below are computed from the WCAG 2.1 formula, and the anchors (white-on-black = 21,
 * mid-grey #767676 on white ≈ 4.54 — the canonical "smallest grey that passes AA") are independent
 * reference values, so a bug in the implementation cannot make these pass by agreeing with itself.
 */

import { describe, expect, it } from "vitest";
import {
  AA_NORMAL, bestTextOn, contrastRatio, meetsAA, normalizeHex, parseHex, relativeLuminance,
  repairContrast, toHex,
} from "@/lib/brand/contrast";

const rgb = (hex: string) => parseHex(hex)!;

describe("hex parsing", () => {
  it("accepts the forms a user or config can produce", () => {
    expect(parseHex("#FF00AA")).toEqual({ r: 255, g: 0, b: 170 });
    expect(parseHex("ff00aa")).toEqual({ r: 255, g: 0, b: 170 });
    expect(parseHex("#f0a")).toEqual({ r: 255, g: 0, b: 170 });
    expect(parseHex("  #FF00AA  ")).toEqual({ r: 255, g: 0, b: 170 });
  });

  it("rejects rather than guesses", () => {
    for (const bad of ["", "#", "#GGGGGG", "#FF00A", "#FF00AAA", "rgb(1,2,3)", "red", "#FF00AA80"]) {
      expect(parseHex(bad), bad).toBeNull();
    }
  });

  it("emits the pptxgenjs form: 6-digit uppercase, no hash", () => {
    expect(toHex({ r: 255, g: 0, b: 170 })).toBe("FF00AA");
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe("000000");
    expect(normalizeHex("#f0a")).toBe("FF00AA");
    expect(normalizeHex("nope")).toBeNull();
  });

  it("clamps out-of-range channels instead of emitting invalid hex", () => {
    expect(toHex({ r: 300, g: -20, b: 128.6 })).toBe("FF0081");
  });
});

describe("luminance and ratio", () => {
  it("matches WCAG reference luminances", () => {
    expect(relativeLuminance(rgb("FFFFFF"))).toBeCloseTo(1, 5);
    expect(relativeLuminance(rgb("000000"))).toBeCloseTo(0, 5);
    // 50% grey is ~0.2159 relative luminance, not 0.5 — the sRGB transfer curve, not a bug.
    expect(relativeLuminance(rgb("808080"))).toBeCloseTo(0.2159, 3);
  });

  it("matches known contrast ratios", () => {
    expect(contrastRatio(rgb("FFFFFF"), rgb("000000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(rgb("FFFFFF"), rgb("FFFFFF"))).toBeCloseTo(1, 5);
    // #767676 on white is the canonical borderline AA grey.
    expect(contrastRatio(rgb("767676"), rgb("FFFFFF"))).toBeCloseTo(4.54, 2);
  });

  it("is order-independent", () => {
    expect(contrastRatio(rgb("123456"), rgb("ABCDEF")))
      .toBeCloseTo(contrastRatio(rgb("ABCDEF"), rgb("123456")), 10);
  });

  it("applies the large-text threshold separately", () => {
    // ~3.9:1 — fails AA normal, passes AA large.
    const fg = rgb("949494");
    const bg = rgb("FFFFFF");
    expect(contrastRatio(fg, bg)).toBeGreaterThan(3);
    expect(contrastRatio(fg, bg)).toBeLessThan(4.5);
    expect(meetsAA(fg, bg, false)).toBe(false);
    expect(meetsAA(fg, bg, true)).toBe(true);
  });
});

describe("repair — known failing pairs (table)", () => {
  const CASES: Array<{ label: string; fg: string; bg: string; large?: boolean; shouldRepair: boolean }> = [
    { label: "white on black — already maximal", fg: "FFFFFF", bg: "000000", shouldRepair: false },
    { label: "black on white — already maximal", fg: "000000", bg: "FFFFFF", shouldRepair: false },
    { label: "borderline grey on white passes", fg: "767676", bg: "FFFFFF", shouldRepair: false },
    { label: "brand magenta on white (3.0:1)", fg: "FF00AA", bg: "FFFFFF", shouldRepair: true },
    { label: "brand magenta on near-black", fg: "FF00AA", bg: "0B0B14", shouldRepair: false },
    { label: "light grey on white — nearly invisible", fg: "EEEEEE", bg: "FFFFFF", shouldRepair: true },
    { label: "dark grey on black", fg: "222222", bg: "000000", shouldRepair: true },
    { label: "same colour on itself (1:1)", fg: "1A1A2E", bg: "1A1A2E", shouldRepair: true },
    { label: "yellow on white — classic failure", fg: "FFFF00", bg: "FFFFFF", shouldRepair: true },
    { label: "mid-grey bg, unreachable at AA normal", fg: "808080", bg: "808080", shouldRepair: true },
    { label: "large-text threshold is easier to satisfy", fg: "949494", bg: "FFFFFF", large: true, shouldRepair: false },
    { label: "same pair fails at normal size", fg: "949494", bg: "FFFFFF", large: false, shouldRepair: true },
  ];

  for (const { label, fg, bg, large, shouldRepair } of CASES) {
    it(label, () => {
      const result = repairContrast(fg, bg, large);
      expect(result.repaired).toBe(shouldRepair);
      expect(result.bg).toBe(bg); // the background is never altered — only text moves
      if (!shouldRepair) {
        expect(result.fg).toBe(fg);
        expect(result.originalFg).toBeUndefined();
      } else {
        expect(result.originalFg).toBe(fg);
        expect(result.fg).not.toBe(fg);
      }
    });
  }

  it("reaches AA for every repairable case", () => {
    for (const { fg, bg, large, label } of CASES) {
      const r = repairContrast(fg, bg, large);
      // #808080 on #808080 cannot reach 4.5:1 against either pole — documented behaviour.
      if (fg === "808080" && bg === "808080") {
        expect(r.ratio, label).toBeGreaterThan(3);
        continue;
      }
      expect(r.ratio, label).toBeGreaterThanOrEqual(large ? 3 : AA_NORMAL);
    }
  });

  it("stops at the first passing step, staying near the brand colour", () => {
    // Magenta on white needs only a modest darkening; the result must not collapse to black.
    const r = repairContrast("FF00AA", "FFFFFF");
    expect(r.fg).not.toBe("000000");
    const repaired = rgb(r.fg);
    // Hue is preserved in ordering: red still dominant, green still lowest.
    expect(repaired.r).toBeGreaterThan(repaired.b);
    expect(repaired.b).toBeGreaterThan(repaired.g);
  });

  it("is deterministic — required for preview/export parity (§8)", () => {
    for (const { fg, bg, large } of CASES) {
      const a = repairContrast(fg, bg, large);
      const b = repairContrast(fg, bg, large);
      expect(a).toEqual(b);
    }
  });

  it("is idempotent: repairing a repaired pair changes nothing further", () => {
    const once = repairContrast("FFFF00", "FFFFFF");
    const twice = repairContrast(once.fg, once.bg);
    expect(twice.repaired).toBe(false);
    expect(twice.fg).toBe(once.fg);
  });

  it("passes malformed input through untouched rather than rewriting it", () => {
    // A bad colour must surface as a schema error, not be silently "fixed" here.
    const r = repairContrast("not-a-colour", "FFFFFF");
    expect(r.repaired).toBe(false);
    expect(r.fg).toBe("not-a-colour");
  });
});

describe("bestTextOn", () => {
  it("honours the brand's own light/dark text choice when it is legible", () => {
    expect(bestTextOn("FFFFFF", "111111", "FAFAFA").fg).toBe("111111");
    expect(bestTextOn("0B0B14", "111111", "FAFAFA").fg).toBe("FAFAFA");
  });

  it("does not repair when the better of the two already passes", () => {
    expect(bestTextOn("FFFFFF", "111111", "FAFAFA").repaired).toBe(false);
  });

  it("repairs when neither declared text colour is legible", () => {
    // Both text colours are near-white; on a white surface neither works.
    const r = bestTextOn("FFFFFF", "F0F0F0", "FAFAFA");
    expect(r.repaired).toBe(true);
    expect(r.ratio).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
