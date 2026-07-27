/**
 * Can shrink-to-fit be made to work at all? (VERIFICATION.md C1)
 *
 * pptxgenjs emits a BARE `<a:normAutofit/>` for fit:'shrink' — the fontScale/lnSpcReduction
 * attributes that actually do the shrinking are commented out in the library
 * (dist/pptxgen.cjs.js L6067). Measured behaviour: text overflows on open AND on click, in both
 * LibreOffice and PowerPoint on the web.
 *
 * This probe post-processes the ZIP to inject `fontScale`/`lnSpcReduction` by hand, to establish
 * whether the attributes are honoured by renderers when present. That tells us whether autofit
 * is available as a belt-and-braces safety net on top of our own truncation, or whether
 * truncation is the ONLY lever we have.
 *
 * Slides: 1 bare normAutofit (what pptxgenjs emits) · 2 fontScale=62.5% · 3 fontScale+lnSpcReduction
 *         4 no autofit at all (control) · all four with identical over-long text in identical boxes.
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { zoneToInches } from "./zone-math";

// Must genuinely overflow: at 18pt in a 40%×30% box this needs ~3× the lines that fit, so a
// fontScale of 62.5% would visibly help if honoured. (A first cut at 4 repeats / h:44 fit the
// box exactly and proved nothing.)
const LONG = "This paragraph is deliberately far too long for its box so the overflow behaviour is visible at a glance. ".repeat(9);
const BOX = zoneToInches({ x: 6, y: 22, w: 40, h: 30 });

/** Rewrites the Nth <a:bodyPr .../> autofit element in slide XML. */
function setAutofit(xml: string, replacement: string): string {
  // pptxgenjs emits <a:normAutofit/> inside the text body's bodyPr
  return xml.replace(/<a:normAutofit\/>/, replacement);
}

async function main() {
  mkdirSync(join(process.cwd(), "out"), { recursive: true });

  const pptx = new pptxgen();
  pptx.defineLayout({ name: "16x9", width: 10, height: 5.625 });
  pptx.layout = "16x9";

  const cases = [
    { label: "1 — bare <a:normAutofit/> (what pptxgenjs emits for fit:'shrink')", fit: "shrink" as const, inject: null },
    { label: "2 — normAutofit fontScale=\"62500\" (injected by hand)", fit: "shrink" as const, inject: '<a:normAutofit fontScale="62500"/>' },
    { label: "3 — fontScale=\"62500\" + lnSpcReduction=\"20000\" (injected)", fit: "shrink" as const, inject: '<a:normAutofit fontScale="62500" lnSpcReduction="20000"/>' },
    { label: "4 — no autofit element at all (control, fit:'none')", fit: "none" as const, inject: null },
  ];

  for (const c of cases) {
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addText(c.label, { x: 0.3, y: 0.15, w: 9.4, h: 0.5, fontSize: 12, color: "AA0000", margin: 0 });
    s.addText("CONFIRM: does the text fit inside the blue box, or spill past it?", { x: 0.3, y: 0.65, w: 9.4, h: 0.35, fontSize: 11, color: "666666", margin: 0 });
    s.addText(LONG, { ...BOX, fontSize: 18, color: "1A1A2E", fit: c.fit, margin: 0, line: { color: "0066FF", width: 1 } });
  }

  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  const zip = await JSZip.loadAsync(buf);

  // Inject per-slide, then repack.
  for (let i = 0; i < cases.length; i++) {
    const inject = cases[i].inject;
    if (!inject) continue;
    const path = `ppt/slides/slide${i + 1}.xml`;
    const xml = await zip.file(path)!.async("string");
    const next = setAutofit(xml, inject);
    if (next === xml) { console.error(`slide ${i + 1}: no <a:normAutofit/> found to replace`); process.exit(1); }
    zip.file(path, next);
  }

  const out = join(process.cwd(), "out", "AUTOFIT-TEST.pptx");
  writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));

  // Report what each slide actually carries.
  const check = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));
  for (let i = 0; i < cases.length; i++) {
    const xml = await check.file(`ppt/slides/slide${i + 1}.xml`)!.async("string");
    const el = /<a:(normAutofit|spAutoFit)[^>]*\/>/.exec(xml)?.[0] ?? "(no autofit element)";
    console.log(`slide ${i + 1}: ${el}`);
  }
  console.log(`\nwrote ${out}`);
  console.log("MANUAL: open it and compare slides 1-4. If 2/3 fit and 1/4 overflow, fontScale IS honoured");
  console.log("        and autofit is usable as a safety net. If all four overflow, truncation is our only lever.");
}

main().catch((e) => { console.error(e); process.exit(1); });
