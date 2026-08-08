/**
 * The §1.1 constraints C1 and C5, enforced at the choke point.
 *
 * These are not style tests. C5 is a bug that has already happened: pptxgenjs groups runs with an
 * `if (align) … else if (bullet) …` chain, so a shape-level `align` — which every `SlotZone` carries —
 * collapses an entire bullet list into ONE paragraph, silently dropping items 2..n's bullet, numbering
 * and indent. 48 OOXML assertions in the §1.1 spike did not catch it; only a raster render did. So the
 * test that matters here is the boring one: **every** item carries `breakLine`.
 *
 * C1 is the same shape of problem — `fit:'shrink'` never shrinks, and its mere presence flips overflow
 * from spill to clip in LibreOffice. `fit` must therefore be `'none'` on every box we emit, forever.
 */

import { describe, expect, it } from "vitest";
import { compileTheme } from "@/lib/brand/theme";
import { makeBrand } from "./fixtures";
import type { SlotZone } from "@/lib/brand/types";
import { LAYOUTS } from "@/lib/layouts/registry";
import {
  addZoneBullets, addZoneText, assertParagraphCount, bodyStyle, bulletRuns, headingStyle, zoneOptions,
} from "@/lib/layouts/pptx-text";
import type { PptxTarget, PptxTextOptions, PptxTextRun } from "@/lib/layouts/types";
import { EMU_PER_INCH, toEmu } from "@/lib/layouts/zone-math";

/** Records everything a layout draws, so assertions can inspect the whole slide. */
class RecordingTarget implements PptxTarget {
  texts: { runs: PptxTextRun[]; options: PptxTextOptions }[] = [];
  images: unknown[] = [];
  shapes: unknown[] = [];
  notes: string[] = [];

  addText(runs: PptxTextRun[], options: PptxTextOptions): void {
    this.texts.push({ runs, options });
  }
  addImage(options: unknown): void { this.images.push(options); }
  addShape(shape: string, options: unknown): void { this.shapes.push({ shape, options }); }
  addNotes(text: string): void { this.notes.push(text); }
}

const zone = (over: Partial<SlotZone> = {}): SlotZone => ({
  slotKey: "items", x: 8, y: 30, w: 84, h: 48, align: "left", valign: "top", ...over,
});

// Two distinct faces, so "heading and body differ" below is an actual assertion.
const tokens = compileTheme(makeBrand({ fonts: { heading: "georgia", body: "verdana" } }));

describe("C5 — breakLine on every bullet run", () => {
  it("stamps breakLine on all items, not just the first", () => {
    const runs = bulletRuns(["one", "two", "three"]);
    expect(runs).toHaveLength(3);
    for (const run of runs) expect(run.options?.breakLine).toBe(true);
  });

  it("stamps it on a single-item list too", () => {
    // The collapse is invisible at n=1, which is exactly why the rule must be unconditional rather
    // than "when there is more than one item".
    expect(bulletRuns(["only"])[0]?.options?.breakLine).toBe(true);
  });

  it("marks every item as a bullet", () => {
    for (const run of bulletRuns(["a", "b"])) expect(run.options?.bullet).toBe(true);
  });

  it("numbers items 1..n, so an agenda does not render as \"1. 1. 1.\"", () => {
    // This test's previous assertion was `toEqual({type:'number'})` for every run — which passed
    // while the deck rendered every item as "1.". pptxgenjs writes `<a:buAutoNum startAt="N"/>` on
    // EVERY numbered paragraph and defaults N to 1, and in OOXML a `startAt` restarts the sequence,
    // so identical options across items is precisely the bug rather than the fix. Caught by eye in
    // the step-13 fixture render; the mechanism is probed in `scripts/verify-pptx-numbering.ts`.
    const runs = bulletRuns(["a", "b", "c"], { type: "number" });
    expect(runs.map((r) => r.options?.bullet)).toEqual([
      { type: "number", numberStartAt: 1 },
      { type: "number", numberStartAt: 2 },
      { type: "number", numberStartAt: 3 },
    ]);
  });

  it("numbers from the kept items, so a blank entry does not leave a gap", () => {
    // Filtering happens before numbering. If it did not, dropping item 2 would emit 1,3,4 — a list
    // that looks like it lost an entry, which is worse than the blank it was avoiding.
    const runs = bulletRuns(["first", "  ", "second"], { type: "number" });
    expect(runs.map((r) => r.options?.bullet)).toEqual([
      { type: "number", numberStartAt: 1 },
      { type: "number", numberStartAt: 2 },
    ]);
  });

  it("drops blank and whitespace-only items rather than emitting empty paragraphs", () => {
    const runs = bulletRuns(["real", "   ", "", "\t\n", "also real"]);
    expect(runs.map((r) => r.text)).toEqual(["real", "also real"]);
  });

  it("trims surrounding whitespace, which models emit inconsistently", () => {
    expect(bulletRuns(["  padded  "])[0]?.text).toBe("padded");
  });

  it("applies indentLevel to every item when set", () => {
    for (const run of bulletRuns(["a", "b"], { indentLevel: 1 })) {
      expect(run.options?.indentLevel).toBe(1);
    }
  });

  it("omits indentLevel entirely when unset, rather than sending 0", () => {
    expect(bulletRuns(["a"])[0]?.options).not.toHaveProperty("indentLevel");
  });

  it("suppresses the marker for type:'none' — while keeping one paragraph per item", () => {
    /*
     * The §8 defect this pair of assertions locks down. `SlotPaint.marker` always offered `"none"` and
     * the preview honoured it, but `paintPptx` sent `{}`, which fell into the `bullet: true` default —
     * so a markerless list previewed clean and exported with bullets. No seed layout used the value,
     * so nothing failed.
     *
     * `bullet: false` (not omission) is what pptxgenjs turns into `<a:buNone/>`; verified against
     * 4.0.1 in `scripts/verify-pptx-bullet-none.ts`, which also showed the collapse still happens
     * without `breakLine` even when there is no bullet — C5 is about `align`, not about markers.
     */
    const runs = bulletRuns(["one", "two", "three"], { type: "none" });
    expect(runs.map((r) => r.options?.bullet)).toEqual([false, false, false]);
    for (const run of runs) expect(run.options?.breakLine).toBe(true);
  });

  it("still bullets when no type is given, so the default is unchanged", () => {
    // The other half of the fix: `"none"` had to become an explicit value rather than being expressed
    // by omission, because omission is what every existing caller of a bulleted list already does.
    expect(bulletRuns(["a"])[0]?.options?.bullet).toBe(true);
  });
});

describe("addZoneBullets", () => {
  it("returns the paragraph count and writes one addText call", () => {
    const target = new RecordingTarget();
    const count = addZoneBullets(target, zone(), ["a", "b", "c"], bodyStyle(tokens, 18, "111111"));
    expect(count).toBe(3);
    expect(target.texts).toHaveLength(1);
    expect(target.texts[0]!.runs).toHaveLength(3);
  });

  it("counts kept items, not supplied ones, so the C5 assertion compares like with like", () => {
    const target = new RecordingTarget();
    const count = addZoneBullets(target, zone(), ["a", "", "b"], bodyStyle(tokens, 18, "111111"));
    expect(count).toBe(2);
  });

  it("writes nothing for an all-empty list", () => {
    const target = new RecordingTarget();
    expect(addZoneBullets(target, zone(), ["", "  "], bodyStyle(tokens, 18, "111111"))).toBe(0);
    expect(target.texts).toHaveLength(0);
  });

  it("still sets the shape-level align that triggers C5 — the hazard is not avoided, it is handled", () => {
    // If a future change dropped `align` to dodge the collapse, zones would stop being honoured and §8
    // would break instead. The point is that `align` AND correct bullets coexist.
    const target = new RecordingTarget();
    addZoneBullets(target, zone({ align: "center" }), ["a", "b"], bodyStyle(tokens, 18, "111111"));
    expect(target.texts[0]!.options.align).toBe("center");
    expect(target.texts[0]!.runs.every((r) => r.options?.breakLine === true)).toBe(true);
  });
});

describe("assertParagraphCount — the export-time backstop", () => {
  it("passes when counts agree", () => {
    expect(() => assertParagraphCount("slide 1 items", 3, 3)).not.toThrow();
  });

  it("throws naming the constraint when they disagree", () => {
    expect(() => assertParagraphCount("slide 1 items", 3, 1)).toThrow(/C5 collapse/);
    expect(() => assertParagraphCount("slide 1 items", 3, 1)).toThrow(/expected 3, got 1/);
  });
});

describe("C1 — fit is always 'none'", () => {
  it("pins fit on a text box", () => {
    expect(zoneOptions(zone(), bodyStyle(tokens, 18, "111111")).fit).toBe("none");
  });

  it("pins fit on a bullet box", () => {
    const target = new RecordingTarget();
    addZoneBullets(target, zone(), ["a"], bodyStyle(tokens, 18, "111111"));
    expect(target.texts[0]!.options.fit).toBe("none");
  });

  it("pins fit on every box every seed layout emits", () => {
    // The guarantee that matters: not that the helper is right, but that no layout bypasses it.
    for (const layout of LAYOUTS) {
      const target = new RecordingTarget();
      layout.toPptx(target, {
        slots: sampleSlots(layout),
        tokens,
        zones: layout.defaultZones.map((z) => ({ ...z })),
      });
      expect(target.texts.length, `${layout.id} drew no text`).toBeGreaterThan(0);
      for (const { options } of target.texts) {
        expect(options.fit, `${layout.id} emitted a box with fit:${String(options.fit)}`).toBe("none");
      }
    }
  });

  it("no layout emits a bullet run without breakLine", () => {
    // The C5 equivalent, across the whole registry. This is the assertion that would have caught the
    // original collapse.
    for (const layout of LAYOUTS) {
      const target = new RecordingTarget();
      layout.toPptx(target, {
        slots: sampleSlots(layout),
        tokens,
        zones: layout.defaultZones.map((z) => ({ ...z })),
      });
      for (const { runs } of target.texts) {
        if (runs.length <= 1) continue;   // a single-run box is not a list
        for (const run of runs) {
          expect(
            run.options?.breakLine,
            `${layout.id} emitted a multi-run box whose run "${run.text}" lacks breakLine`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("zoneOptions geometry", () => {
  it("converts percent to inches on a 16:9 slide", () => {
    const options = zoneOptions(
      { slotKey: "t", x: 50, y: 50, w: 50, h: 50, align: "left", valign: "top" },
      bodyStyle(tokens, 18, "111111"),
    );
    expect(options.x).toBeCloseTo(5, 10);
    expect(options.y).toBeCloseTo(2.8125, 10);
    expect(options.w).toBeCloseTo(5, 10);
    expect(options.h).toBeCloseTo(2.8125, 10);
  });

  it("is EMU-exact at the §1.1-verified anchor", () => {
    // The spike's zone-math proof, carried into production code: 8% of 10in = 0.8in = 731520 EMU.
    const options = zoneOptions(zone({ x: 8 }), bodyStyle(tokens, 18, "111111"));
    expect(toEmu(options.x)).toBe(731520);
    expect(EMU_PER_INCH).toBe(914400);
  });

  it("passes align and valign through unchanged", () => {
    const options = zoneOptions(
      zone({ align: "right", valign: "middle" }), bodyStyle(tokens, 18, "111111"),
    );
    expect(options.align).toBe("right");
    expect(options.valign).toBe("middle");
  });

  it("omits optional style keys rather than sending undefined", () => {
    // §1.1/C4: pptxgenjs validates nothing, so an explicit `undefined` can reach the XML writer.
    const options = zoneOptions(zone(), { fontFace: "Georgia", fontSize: 18, color: "111111" });
    expect(options).not.toHaveProperty("bold");
    expect(options).not.toHaveProperty("italic");
    expect(options).not.toHaveProperty("lineSpacingMultiple");
  });
});

describe("addZoneText", () => {
  it("writes one run", () => {
    const target = new RecordingTarget();
    addZoneText(target, zone(), "Hello", headingStyle(tokens, 32, "111111"));
    expect(target.texts[0]!.runs).toEqual([{ text: "Hello" }]);
  });

  it("writes nothing for empty or whitespace-only text", () => {
    const target = new RecordingTarget();
    addZoneText(target, zone(), "   ", headingStyle(tokens, 32, "111111"));
    expect(target.texts).toHaveLength(0);
  });
});

describe("style helpers derive from tokens, never from a brand", () => {
  it("headingStyle uses the heading face and bolds", () => {
    const style = headingStyle(tokens, 32, "111111");
    expect(style.fontFace).toBe(tokens.fonts.headingPptx);
    expect(style.bold).toBe(true);
  });

  it("bodyStyle uses the body face with line spacing", () => {
    const style = bodyStyle(tokens, 18, "111111");
    expect(style.fontFace).toBe(tokens.fonts.bodyPptx);
    expect(style.lineSpacingMultiple).toBe(1.2);
  });

  it("the two faces differ when the brand sets them differently", () => {
    expect(tokens.fonts.headingPptx).not.toBe(tokens.fonts.bodyPptx);
  });
});

/** Plausible content for every slot of a layout, so `toPptx` actually draws something. */
function sampleSlots(layout: { slots: readonly { key: string; type: string; maxItems?: number }[] }) {
  const slots: Record<string, string | string[]> = {};
  for (const spec of layout.slots) {
    slots[spec.key] = spec.type === "list"
      ? Array.from({ length: Math.min(3, spec.maxItems ?? 3) }, (_, i) => `Item ${i + 1}`)
      : "Sample";
  }
  return slots;
}
