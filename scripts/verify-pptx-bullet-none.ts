/**
 * Probe: how do you render a MARKERLESS multi-item list in pptxgenjs 4.0.1?
 *
 * `SlotPaint.marker` has always had a `"none"` value, and `preview.tsx` honours it
 * (`listStyleType: none`). `paintPptx` did not: it passed `{}` to `addZoneBullets`, and `bulletRuns`
 * defaults to `bullet: true` — so a `marker:"none"` list previews without markers and exports WITH
 * them. No seed layout used the value, so nothing caught it.
 *
 * Fixing it needs two facts I must not guess (Prime Directive #1):
 *
 *   Q1. Which option suppresses the glyph — `bullet: false`, or omitting `bullet` entirely?
 *   Q2. Does the suppressed form still produce ONE PARAGRAPH PER ITEM? This is the §1.1/C5 trap:
 *       pptxgenjs groups runs with an `if (align) … else if (bullet) …` chain, and `SlotZone` always
 *       carries `align`. C5's fix was `breakLine: true` on every run, which takes an unconditional
 *       path — but that was verified with `bullet: true` present. If dropping the bullet re-collapses
 *       the items, a markerless list is not safely expressible and the layout must use a real marker.
 *
 * Run: npx tsx scripts/verify-pptx-bullet-none.ts
 */

import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { SLIDE_16x9, zoneToInches } from "../lib/layouts/zone-math";

const ITEMS = ["first item", "second item", "third item"];

const BOX = {
  ...zoneToInches({ x: 8, y: 30, w: 84, h: 40 }),
  // `align` is the C5 trigger — every zone-positioned box has it, so the probe must too.
  align: "left" as const,
  fontSize: 18,
  fit: "none" as const,
};

interface Variant {
  label: string;
  /** What goes in each run's `options`. */
  runOptions: (index: number) => Record<string, unknown>;
}

const VARIANTS: Variant[] = [
  { label: "A: bullet:true (control — today's marker:'bullet')", runOptions: () => ({ bullet: true, breakLine: true }) },
  { label: "B: bullet:false", runOptions: () => ({ bullet: false, breakLine: true }) },
  { label: "C: bullet omitted entirely", runOptions: () => ({ breakLine: true }) },
  { label: "D: bullet omitted, NO breakLine (the C5 collapse, for contrast)", runOptions: () => ({}) },
];

/** Per-shape paragraph and bullet-element counts, read from the real OOXML. */
function inspect(xml: string): { paras: number; buChar: number; buNone: number; buAuto: number; texts: number }[] {
  const shapes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  return shapes.map((sp) => ({
    paras: (sp.match(/<a:p>/g) ?? []).length,
    buChar: (sp.match(/<a:buChar/g) ?? []).length,
    buNone: (sp.match(/<a:buNone/g) ?? []).length,
    buAuto: (sp.match(/<a:buAutoNum/g) ?? []).length,
    texts: (sp.match(/<a:t>/g) ?? []).length,
  }));
}

async function slideXml(pptx: pptxgen, index = 1): Promise<string> {
  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  const zip = await JSZip.loadAsync(buf);
  return zip.file(`ppt/slides/slide${index}.xml`)!.async("string");
}

async function main(): Promise<void> {
  console.log(`Probing markerless bullet rendering — ${ITEMS.length} items per variant\n`);

  for (const variant of VARIANTS) {
    const pptx = new pptxgen();
    pptx.defineLayout({ name: "16x9", width: SLIDE_16x9.width, height: SLIDE_16x9.height });
    pptx.layout = "16x9";
    const slide = pptx.addSlide();

    slide.addText(
      ITEMS.map((text, i) => ({ text, options: variant.runOptions(i) })),
      BOX,
    );

    const [shape] = inspect(await slideXml(pptx));
    const ok = shape?.paras === ITEMS.length;
    console.log(`${variant.label}`);
    console.log(
      `   paragraphs=${shape?.paras} (want ${ITEMS.length}${ok ? " ✅" : " ❌ COLLAPSED"})  `
      + `texts=${shape?.texts}  buChar=${shape?.buChar} buNone=${shape?.buNone} buAutoNum=${shape?.buAuto}\n`,
    );
  }

  console.log(
    "Read: the variant that gives paragraphs == item count with buChar=0 is the one `paintPptx`\n"
    + "must emit for marker:'none'. buNone>0 means pptxgenjs writes an explicit <a:buNone/>, which is\n"
    + "the OOXML way to say 'no marker' and is what makes the export match the preview.",
  );
}

void main();
