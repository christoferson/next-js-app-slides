/**
 * §1.1 follow-up probe: does `bullet:{type:'number'}` actually NUMBER, or does every item render "1."?
 *
 * ## Why this probe exists
 *
 * The step-13 fixture deck (`scripts/export-fixture-deck.ts`) rendered `agenda`'s six items as
 * "1. 1. 1. 1. 1. 1." in LibreOffice. Reading the emitted XML showed why: pptxgenjs writes
 * `<a:buAutoNum type="arabicPeriod" startAt="N"/>` on EVERY paragraph, defaulting N to 1 —
 *
 *   startAt="${textObj.options.bullet.numberStartAt || textObj.options.bullet.startAt || '1'}"
 *
 * — and in OOXML a `startAt` on a paragraph RESTARTS the sequence there. So six paragraphs each
 * declaring "start at 1" is six list items numbered 1.
 *
 * This is C5's sibling and the same class of defect: the deck opens looking populated, and the damage
 * (an agenda that cannot be referred to by number) is only visible to a human reading the render. C5
 * itself is not the cause — these paragraphs are correctly separated, they are just all numbered 1.
 *
 * Q1 reproduces the defect; Q2 tests the candidate fix (an explicit per-item `numberStartAt`); Q3
 * checks that plain glyph bullets were never affected. Verified by reading the XML rather than by
 * eye, so this is repeatable in CI.
 */

import pptxgen from "pptxgenjs";
import JSZip from "jszip";

const ITEMS = ["First", "Second", "Third"];

/** The `startAt` value on each numbered paragraph, in document order. */
async function startAts(build: (slide: pptxgen.Slide) => void): Promise<(string | null)[]> {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "16x9", width: 10, height: 5.625 });
  pptx.layout = "16x9";
  build(pptx.addSlide());

  const zip = await JSZip.loadAsync(await pptx.write({ outputType: "nodebuffer" }) as Buffer);
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  return [...xml.matchAll(/<a:buAutoNum[^>]*?startAt="(\d+)"/g)].map((m) => m[1] ?? null);
}

const bullets = (opts: (i: number) => object) =>
  ITEMS.map((text, i) => ({ text, options: { breakLine: true, ...opts(i) } }));

const BOX = { x: 0.8, y: 1.2, w: 8.4, h: 3, fontSize: 18, align: "left" as const, fit: "none" as const };

async function main(): Promise<void> {
  // Q1 — what we ship today.
  const asShipped = await startAts((s) => {
    s.addText(bullets(() => ({ bullet: { type: "number" } })), BOX);
  });
  console.log(`Q1 bullet:{type:'number'}            startAt = [${asShipped.join(", ")}]`);
  console.log(`   ${asShipped.every((v) => v === "1") ? "❌ every item restarts at 1 — DEFECT REPRODUCED" : "unexpected"}`);

  // Q2 — the candidate fix. `numberStartAt` is the non-deprecated spelling (`startAt` is deprecated
  // since v3.3.0), and it is per-run, so item i can declare that it starts at i+1.
  const fixed = await startAts((s) => {
    s.addText(bullets((i) => ({ bullet: { type: "number", numberStartAt: i + 1 } })), BOX);
  });
  console.log(`\nQ2 + numberStartAt: i+1              startAt = [${fixed.join(", ")}]`);
  const ok = fixed.join(",") === "1,2,3";
  console.log(`   ${ok ? "✅ 1,2,3 — each paragraph declares its own position, so no restart" : "❌ still wrong"}`);

  // Q3 — glyph bullets emit no buAutoNum at all, so they were never affected. Asserted so that a
  // future change to the shared helper cannot silently give them one.
  const glyph = await startAts((s) => { s.addText(bullets(() => ({ bullet: true })), BOX); });
  console.log(`\nQ3 bullet:true                       startAt = [${glyph.join(", ")}] `
    + `${glyph.length === 0 ? "✅ no autonum — unaffected" : "❌ unexpected autonum"}`);

  if (!ok || glyph.length !== 0) {
    console.error("\nProbe FAILED — the numbering workaround does not hold on this pptxgenjs version.");
    process.exit(1);
  }
  console.log("\n✅ Fix confirmed: `bulletRuns` must stamp `numberStartAt` per item for type:'number'.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
