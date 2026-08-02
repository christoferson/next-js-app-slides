/**
 * §2 step 13 probe — what does `<a:p>` actually look like in serialized output?
 *
 * The exporter is supposed to run `assertParagraphCount` (§1.1/C5) against its OWN serialized output.
 * That needs three facts I must not guess (Prime Directive #1):
 *
 *   Q1. Does a text-less `addShape` (our panels and accent rules) emit `<a:p>`? If it does, a naive
 *       per-slide `<a:p>` total is not comparable to "paragraphs we wrote".
 *   Q2. Does a single-run `addText` emit exactly one `<a:p>`?
 *   Q3. Is a bullet paragraph distinguishable in the XML (buChar/buAutoNum), so the count can be
 *       scoped to bullets only?
 *   Q4. Reproduce the C5 collapse: shape-level `align` + bullet runs WITHOUT `breakLine` — how many
 *       `<a:p>` does that produce, and does the distinguishing marker still appear?
 *
 * Run: npx tsx scripts/verify-pptx-paragraphs.ts
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { SLIDE_16x9, zoneToInches } from "./zone-math";

function deck() {
  const p = new pptxgen();
  p.defineLayout(SLIDE_16x9);
  p.layout = SLIDE_16x9.name;
  return p;
}

const ZONE = { x: 8, y: 36, w: 84, h: 48 };

async function slideXml(p: pptxgen, n = 1): Promise<string> {
  const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
  const zip = await JSZip.loadAsync(buf);
  return zip.file(`ppt/slides/slide${n}.xml`)!.async("string");
}

/** All <p:sp> bodies in document order, with their own paragraph/bullet counts. */
function shapes(xml: string) {
  const out: Array<{ paras: number; bulletParas: number; texts: string[] }> = [];
  const re = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[1]!;
    const paras = [...body.matchAll(/<a:p>/g)].length;
    const bulletParas = [...body.matchAll(/<a:p><a:pPr[^>]*>(?:(?!<\/a:p>)[\s\S])*?<a:bu(?:Char|AutoNum)/g)].length;
    out.push({ paras, bulletParas, texts: [...body.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]!) });
  }
  return out;
}

async function main() {
  // Q1 — a text-less rect (our panels / accent rules).
  {
    const p = deck();
    p.addSlide().addShape("rect", { x: 1, y: 1, w: 2, h: 1, fill: { color: "FF00AA" } });
    const xml = await slideXml(p);
    const sps = shapes(xml);
    console.log(`Q1) text-less addShape: ${sps.length} <p:sp>, paras=${sps[0]?.paras}, bulletParas=${sps[0]?.bulletParas}`);
    console.log(`    → a naive per-slide <a:p> total is ${sps[0]?.paras === 0 ? "SAFE" : "POLLUTED"} by shapes`);
  }

  // Q2 — a single-run addText.
  {
    const p = deck();
    p.addSlide().addText([{ text: "One line" }], { ...zoneToInches(ZONE), align: "left", fontSize: 18, fit: "none" });
    const sps = shapes(await slideXml(p));
    console.log(`Q2) single-run addText: paras=${sps[0]?.paras}, bulletParas=${sps[0]?.bulletParas}`);
  }

  // Q3 — bullets built the way `bulletRuns` builds them (breakLine on EVERY item).
  {
    const p = deck();
    p.addSlide().addText(
      ["Alpha", "Beta", "Gamma"].map((text) => ({ text, options: { bullet: true, breakLine: true } })),
      { ...zoneToInches(ZONE), align: "left", fontSize: 18, fit: "none" },
    );
    const sps = shapes(await slideXml(p));
    console.log(`Q3) 3 correct bullet runs: paras=${sps[0]?.paras}, bulletParas=${sps[0]?.bulletParas}, texts=${JSON.stringify(sps[0]?.texts)}`);
    console.log(`    → ${sps[0]?.bulletParas === 3 ? "bullet paragraphs ARE countable" : "bullet marker regex WRONG — fix before relying on it"}`);
  }

  // Q4 — the C5 collapse: shape-level align, NO breakLine.
  {
    const p = deck();
    p.addSlide().addText(
      ["Alpha", "Beta", "Gamma"].map((text) => ({ text, options: { bullet: true } })),
      { ...zoneToInches(ZONE), align: "left", fontSize: 18, fit: "none" },
    );
    const sps = shapes(await slideXml(p));
    console.log(`Q4) 3 collapsed bullet runs: paras=${sps[0]?.paras}, bulletParas=${sps[0]?.bulletParas}, texts=${JSON.stringify(sps[0]?.texts)}`);
    console.log(`    → a paragraph count ${sps[0]?.paras === 1 ? "DETECTS" : "does NOT detect"} the collapse (1 para for 3 items)`);
  }

  // Q5 — numbered list, same question (buAutoNum rather than buChar).
  {
    const p = deck();
    p.addSlide().addText(
      ["One", "Two"].map((text) => ({ text, options: { bullet: { type: "number" as const }, breakLine: true } })),
      { ...zoneToInches(ZONE), align: "left", fontSize: 18, fit: "none" },
    );
    const sps = shapes(await slideXml(p));
    console.log(`Q5) 2 numbered runs: paras=${sps[0]?.paras}, bulletParas=${sps[0]?.bulletParas}`);
  }

  // Q6 — a realistic slide: 2 panels + title + 3 bullets, to confirm per-slide totals add up.
  {
    const p = deck();
    const s = p.addSlide();
    s.addShape("rect", { x: 0.8, y: 1.8, w: 3.8, h: 2.9, fill: { color: "1A1A2E" } });
    s.addShape("rect", { x: 5.4, y: 1.8, w: 3.8, h: 2.9, fill: { color: "1A1A2E" } });
    s.addText([{ text: "Title" }], { ...zoneToInches({ x: 8, y: 8, w: 84, h: 24 }), align: "left", fontSize: 32, fit: "none" });
    s.addText(
      ["A", "B", "C"].map((text) => ({ text, options: { bullet: true, breakLine: true } })),
      { ...zoneToInches(ZONE), align: "left", fontSize: 18, fit: "none" },
    );
    const xml = await slideXml(p);
    const sps = shapes(xml);
    const totalParas = sps.reduce((n, s2) => n + s2.paras, 0);
    const totalBullets = sps.reduce((n, s2) => n + s2.bulletParas, 0);
    console.log(`Q6) 2 panels + title + 3 bullets: ${sps.length} <p:sp>, paras total=${totalParas}, bulletParas total=${totalBullets}`);
    console.log(`    per shape: ${JSON.stringify(sps.map((s2) => ({ p: s2.paras, b: s2.bulletParas })))}`);
    console.log(`    → expected bullets=3: ${totalBullets === 3 ? "MATCH" : "MISMATCH"}; expected paras=1(title)+3(items)=4: ${totalParas === 4 ? "MATCH" : `got ${totalParas}`}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
