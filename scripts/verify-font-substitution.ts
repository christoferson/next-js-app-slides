/**
 * Objective font-substitution detector.
 *
 * Builds a deck with ONE slide per FONTS candidate, each rendering the SAME string at the
 * SAME size and position — plus a deliberately-bogus control font that MUST be substituted.
 * The deck is rendered by LibreOffice and each slide's text area is hashed.
 *
 * Logic: identical bitmaps ⇒ the same glyphs were drawn ⇒ both fonts resolved to the same
 * physical face. A candidate whose bitmap equals the bogus control's was substituted.
 *
 * Caveat: this measures substitution ON THIS MACHINE'S renderer (LibreOffice + installed
 * fonts). PowerPoint on macOS may substitute differently — see VERIFICATION.md.
 */
import pptxgen from "pptxgenjs";
import { createCanvas } from "@napi-rs/canvas";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SLIDE_16x9 } from "./zone-math";
import { FONT_CANDIDATES } from "./fonts-candidates";
import { sofficeVersion } from "./render-pptx";

const SOFFICE = "C:/Program Files/LibreOffice/program/soffice.exe";
const LO_VERSION = (() => {
  try { return sofficeVersion(SOFFICE); } catch { return "unknown"; }
})();
const OUT = join(process.cwd(), "out", "fontcheck");
const SPECIMEN = "Handgloves 0123 Wavy AVAST";
const BOGUS = "ZZ_NoSuchFont_ZZ";

/** candidates + a control guaranteed to be missing */
const ENTRIES = [
  ...FONT_CANDIDATES.map((f) => ({ id: f.id, pptxName: f.pptxName, expect: f.expect })),
  { id: "__bogus_control__", pptxName: BOGUS, expect: "control" as const },
];

/**
 * One slide per candidate would be natural, but PDF `/BaseFont` objects appear in
 * FILE order, not page order (measured: every name shifted by one, producing nonsense
 * like "Georgia → CourierNewPSMT"). Since each candidate uses a unique family, comparing
 * the SET of embedded faces against the SET of requested names is order-independent and
 * therefore correct. Bitmaps are still rendered per slide for the visual record.
 */
async function buildDeck(): Promise<string> {
  const pptx = new pptxgen();
  pptx.defineLayout(SLIDE_16x9);
  pptx.layout = SLIDE_16x9.name;
  for (const e of ENTRIES) {
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    // identical geometry + size for every slide so bitmaps are directly comparable
    s.addText(SPECIMEN, {
      x: 0.3, y: 1.5, w: 9.4, h: 1.6,
      fontFace: e.pptxName, fontSize: 44, color: "000000",
      align: "left", valign: "top", margin: 0,
    });
  }
  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  mkdirSync(OUT, { recursive: true });
  const f = join(OUT, "fontcheck.pptx");
  writeFileSync(f, buf);
  return f;
}

function toPdf(pptxPath: string): string {
  execFileSync(SOFFICE, ["--headless", "--norestore", "--convert-to", "pdf:impress_pdf_Export", "--outdir", OUT, pptxPath],
    { stdio: "pipe" });
  return join(OUT, "fontcheck.pdf");
}

async function rasterize(pdfPath: string): Promise<Buffer[]> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    // MUST be true in Node: with false, pdfjs tries to install @font-face in a DOM that
    // doesn't exist and every glyph rasterizes as tofu — which silently destroys the
    // comparison (measured: all 17 slides became tofu, diffs reflecting only box widths).
    disableFontFace: true,
    standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/",
    cMapUrl: "./node_modules/pdfjs-dist/cmaps/", cMapPacked: true,
  }).promise;
  const pages: Buffer[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as any, viewport: vp }).promise;
    // crop the specimen band only (y 1.5in..3.1in of a 5.625in slide)
    const y0 = Math.floor((1.4 / SLIDE_16x9.height) * canvas.height);
    const y1 = Math.ceil((3.2 / SLIDE_16x9.height) * canvas.height);
    const band = ctx.getImageData(0, y0, canvas.width, y1 - y0);
    // binarize to kill antialiasing noise, then hash
    const bits = Buffer.alloc(band.data.length / 4);
    let ink = 0;
    for (let p = 0, q = 0; p < band.data.length; p += 4, q++) {
      const v = band.data[p] < 128 ? 1 : 0;
      bits[q] = v;
      ink += v;
    }
    pages.push(Buffer.concat([Buffer.from(`${ink}:`), bits]));
    writeFileSync(join(OUT, `slide-${String(i).padStart(2, "0")}.png`), canvas.toBuffer("image/png"));
  }
  return pages;
}

/**
 * THE authoritative signal: which physical face did LibreOffice actually put on the page?
 * It embeds the resolved (post-substitution) face and names it in the PDF `/BaseFont`
 * descriptor, so requesting "Aptos" and getting "ArialUnicodeMS" back IS the substitution,
 * stated by the renderer itself.
 *
 * Read via raw PDF parse, NOT pdfjs: pdfjs's page font objects report generic CSS families
 * ("sans-serif"/"serif") in Node, which makes every font look substituted (measured).
 * One page per candidate ⇒ /BaseFont entries appear in page order.
 */
function embeddedBaseFonts(pdfPath: string): string[] {
  const raw = readFileSync(pdfPath, "latin1");
  // subset tag is a 6-letter prefix + '+', e.g. "BAAAAA+ArialMT"
  return [...raw.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([A-Za-z0-9\-,._]+)/g)].map((m) => m[1]);
}

/**
 * Does the embedded face correspond to the requested family? PDF names strip spaces and
 * append PostScript suffixes (Times New Roman → TimesNewRomanPSMT, Arial → ArialMT,
 * Franklin Gothic Book → FranklinGothic-Book), so compare on alphanumerics with the
 * known PostScript suffixes removed.
 *
 * Equality must be EXACT after stripping, not prefix-based: a prefix test lets the fallback
 * face ArialUnicodeMS be claimed by the "Arial" candidate, which both hides the real fallback
 * and could mask a genuine substitution. Exact matching resolves all 15 installed candidates.
 */
function facesMatch(requested: string, embedded: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const strip = (s: string) => norm(s).replace(/(psmt|psbd|mt|ps|regular|book)$/g, "");
  return strip(requested) === strip(embedded);
}

/** fraction of differing pixels between two binarized bands */
function diffRatio(a: Buffer, b: Buffer): number {
  const ai = a.indexOf(58), bi = b.indexOf(58);
  const x = a.subarray(ai + 1), y = b.subarray(bi + 1);
  const n = Math.min(x.length, y.length);
  let d = 0;
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) d++;
  return d / n;
}
const inkOf = (b: Buffer) => Number(b.subarray(0, b.indexOf(58)).toString());

async function main() {
  if (!existsSync(SOFFICE)) { console.error(`LibreOffice not found at ${SOFFICE}`); process.exit(1); }
  rmSync(OUT, { recursive: true, force: true });
  const pptxPath = await buildDeck();
  const pdf = toPdf(pptxPath);
  const pages = await rasterize(pdf);
  if (pages.length !== ENTRIES.length) {
    console.error(`page/entry mismatch: ${pages.length} vs ${ENTRIES.length}`); process.exit(1);
  }

  const embedded = embeddedBaseFonts(pdf);
  const control = pages[pages.length - 1];
  console.log(`specimen: "${SPECIMEN}" @44pt · renderer: ${LO_VERSION || "LibreOffice"}`);
  console.log(`faces embedded in the PDF (${embedded.length}): ${embedded.join(", ")}\n`);

  const rows = [];
  for (let i = 0; i < ENTRIES.length - 1; i++) {
    const e = ENTRIES[i];
    // Authoritative: is a face matching this family present among the embedded set?
    const hit = embedded.find((f) => facesMatch(e.pptxName, f));
    // Corroborating: same bitmap as the bogus-font control ⇒ resolved to the same fallback.
    const sameAsControl = diffRatio(pages[i], control) < 0.005;
    const verdict = hit ? "HONOURED" : sameAsControl ? "SUBSTITUTED (= fallback)" : "SUBSTITUTED";
    rows.push({ id: e.id, pptxName: e.pptxName, tier: e.expect, resolved: hit ?? "not embedded", honoured: !!hit, sameAsControl, verdict });
  }
  // Faces present in the PDF that no candidate asked for = what fallbacks resolved to.
  const unclaimed = embedded.filter((f) => !ENTRIES.some((e) => facesMatch(e.pptxName, f)));

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`${pad("registry id", 18)}${pad("requested", 22)}${pad("tier", 9)}${pad("embedded face", 24)}verdict`);
  for (const r of rows) {
    console.log(`${pad(r.id, 18)}${pad(r.pptxName, 22)}${pad(r.tier, 9)}${pad(r.resolved, 24)}${r.verdict}`);
  }
  const bad = rows.filter((r) => !r.honoured);
  console.log(`\n${rows.length - bad.length}/${rows.length} honoured`);
  console.log(`fallback faces present (not requested by any candidate): ${unclaimed.length ? unclaimed.join(", ") : "none"}`);
  if (bad.length) console.log(`⚠️  substituted: ${bad.map((b) => b.pptxName).join(", ")}`);
  writeFileSync(join(OUT, "font-substitution-report.json"),
    JSON.stringify({ specimen: SPECIMEN, renderer: LO_VERSION, embedded, unclaimed, rows }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
