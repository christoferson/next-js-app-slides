/**
 * Bullet paragraph structure probe.
 *
 * The LibreOffice render of OPEN-TEST slide 1 showed three bullet items collapsed onto one
 * line ("…grid intersectionnested bullet renders indentednumbered run renders as a number").
 * OOXML confirmed why: pptxgenjs put all three runs in a SINGLE <a:p>, so only the first
 * item's bullet/indent/numbering applied.
 *
 * This probe compares the candidate forms to find which produces one paragraph per item.
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ITEMS = ["Point one", "Point two nested", "Point three numbered"];

interface Variant { name: string; apply: (s: any) => void }

const VARIANTS: Variant[] = [
  {
    name: "A: runs, bullet only (what OPEN-TEST used)",
    apply: (s) => s.addText(
      ITEMS.map((t, i) => ({ text: t, options: i === 1 ? { bullet: true, indentLevel: 1 } : i === 2 ? { bullet: { type: "number" } } : { bullet: true } })),
      { x: 0.5, y: 0.5, w: 5, h: 2, fontSize: 14 },
    ),
  },
  {
    name: "B: runs + breakLine on each item",
    apply: (s) => s.addText(
      ITEMS.map((t, i) => ({ text: t, options: { breakLine: true, ...(i === 1 ? { bullet: true, indentLevel: 1 } : i === 2 ? { bullet: { type: "number" } } : { bullet: true }) } })),
      { x: 0.5, y: 0.5, w: 5, h: 2, fontSize: 14 },
    ),
  },
  {
    name: "C: one addText per item",
    apply: (s) => ITEMS.forEach((t, i) =>
      s.addText(t, { x: 0.5, y: 0.5 + i * 0.4, w: 5, h: 0.35, fontSize: 14, bullet: i === 2 ? { type: "number" } : true, indentLevel: i === 1 ? 1 : 0 })),
  },
  {
    name: "D: newline-joined single string + bullet on the shape",
    apply: (s) => s.addText(ITEMS.join("\n"), { x: 0.5, y: 0.5, w: 5, h: 2, fontSize: 14, bullet: true }),
  },
];

async function main() {
  for (const v of VARIANTS) {
    const pptx = new pptxgen();
    pptx.defineLayout({ name: "16x9", width: 10, height: 5.625 });
    pptx.layout = "16x9";
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    v.apply(s);
    const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const shapes = [...xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].map((m) => m[1]).filter((b) => b.includes("<a:t>"));
    const paras = shapes.flatMap((b) => [...b.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => m[1]));
    const withBullet = paras.filter((p) => /<a:bu(Char|AutoNum)/.test(p)).length;
    const brs = (xml.match(/<a:br\/>/g) ?? []).length;
    const texts = paras.map((p) => [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("⟂"));
    console.log(`${v.name}`);
    console.log(`   shapes=${shapes.length} paragraphs=${paras.length} paras-with-bullet=${withBullet} <a:br/>=${brs}`);
    console.log(`   per-paragraph text: ${texts.map((t) => JSON.stringify(t)).join(" | ")}`);
    console.log(`   → ${paras.length === 3 && withBullet === 3 ? "CORRECT: one bulleted paragraph per item" : "WRONG for bullet lists"}\n`);
    writeFileSync(join(process.cwd(), "out", `bullets-${v.name[0]}.pptx`), buf);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
