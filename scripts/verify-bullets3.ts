/**
 * Confirms the fix for the align-vs-bullet paragraph bug.
 *
 * Cause (dist/pptxgen.cjs.js STEP 5, ~L6189): the paragraph-splitting logic is
 *   if (arrTexts.length && (textObj.options.align || opts.align)) { split only if align CHANGED }
 *   else if (arrTexts.length && textObj.options.bullet)            { split }
 * Because it is an `else if`, a shape-level `align` sends every run down the align branch —
 * and since all runs share the same (undefined) per-run align, nothing ever splits, so the
 * whole list collapses into ONE bulleted paragraph.
 *
 * Fix: set `breakLine: true` on each item. Branch C runs unconditionally after the
 * if/else-if, so paragraphs split regardless of align.
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";

type Item = { text: string; options: Record<string, unknown> };
const base: Array<Record<string, unknown>> = [
  { bullet: true },
  { bullet: true, indentLevel: 1 },
  { bullet: { type: "number" } },
];
const labels = ["Point one", "Point two nested", "Point three numbered"];

const mk = (extra: Record<string, unknown>): Item[] =>
  labels.map((t, i) => ({ text: t, options: { ...base[i], ...extra } }));

const CASES: Array<[string, Item[], any]> = [
  ["align + plain items (BUG)", mk({}), { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, align: "left", valign: "top", margin: 0 }],
  ["align + breakLine (FIX)", mk({ breakLine: true }), { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, align: "left", valign: "top", margin: 0 }],
  ["align:center + breakLine", mk({ breakLine: true }), { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, align: "center", valign: "middle", margin: 0 }],
  ["align:right + breakLine", mk({ breakLine: true }), { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, align: "right", valign: "bottom", margin: 0 }],
  ["no align + breakLine", mk({ breakLine: true }), { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, margin: 0 }],
];

async function main() {
  let bad = 0;
  for (const [label, items, opts] of CASES) {
    const pptx = new pptxgen();
    pptx.defineLayout({ name: "16x9", width: 10, height: 5.625 });
    pptx.layout = "16x9";
    pptx.addSlide().addText(items as any, opts);
    const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => m[1]);
    const bulleted = paras.filter((p) => /<a:bu(Char|AutoNum)/.test(p)).length;
    const numbered = paras.filter((p) => /<a:buAutoNum/.test(p)).length;
    const nested = /lvl="1"/.test(xml);
    const expectFix = label !== "align + plain items (BUG)";
    const ok = expectFix ? paras.length === 3 && bulleted === 3 && numbered === 1 && nested : paras.length === 1;
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} ${label.padEnd(28)} paragraphs=${paras.length} bulleted=${bulleted} numbered=${numbered} nested=${nested}`);
  }
  console.log(bad ? `\n${bad} unexpected result(s)` : "\nAll as expected: breakLine restores one paragraph per item under any align.");
  if (bad) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
