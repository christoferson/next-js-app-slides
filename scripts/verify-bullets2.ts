/**
 * Isolate WHY OPEN-TEST slide 1's bullets collapsed into one paragraph when the same
 * itemized-runs form produces three paragraphs in isolation.
 * Bisects the shape-level options used in verify-pptx-opentest.ts.
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";

const ITEMS = [
  { text: "Point one", options: { bullet: true } },
  { text: "Point two nested", options: { bullet: true, indentLevel: 1 } },
  { text: "Point three numbered", options: { bullet: { type: "number" as const } } },
];

const CASES: Array<[string, any]> = [
  ["baseline (x,y,w,h,fontSize)", { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13 }],
  ["+ color", { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, color: "FFFFFF" }],
  ["+ margin:0", { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, color: "FFFFFF", margin: 0 }],
  ["+ align:left", { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, color: "FFFFFF", margin: 0, align: "left" }],
  ["+ valign:top", { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, color: "FFFFFF", margin: 0, align: "left", valign: "top" }],
  ["+ fit:shrink", { x: 0.8, y: 2.7, w: 5.2, h: 1.9, fontSize: 13, color: "FFFFFF", margin: 0, align: "left", valign: "top", fit: "shrink" }],
  ["EXACT opentest opts", { x: 0.8, y: 2.7, w: 5.2, h: 1.9, align: "left", valign: "top", fontSize: 13, color: "FFFFFF", margin: 0 }],
];

async function paraCount(opts: any) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "16x9", width: 10, height: 5.625 });
  pptx.layout = "16x9";
  const s = pptx.addSlide();
  s.addText(ITEMS as any, opts);
  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => m[1]);
  const bullets = paras.filter((p) => /<a:bu(Char|AutoNum)/.test(p)).length;
  const lvls = [...xml.matchAll(/lvl="(\d+)"/g)].map((m) => m[1]);
  return { paras: paras.length, bullets, lvls: lvls.join(",") || "none" };
}

async function main() {
  for (const [label, opts] of CASES) {
    const r = await paraCount(opts);
    console.log(`${r.paras === 3 && r.bullets === 3 ? "OK  " : "BAD "} ${label.padEnd(30)} paragraphs=${r.paras} bulleted=${r.bullets} lvls=${r.lvls}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
