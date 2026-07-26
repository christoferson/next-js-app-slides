/**
 * Rasterizes a PDF (produced by LibreOffice from our .pptx) to per-page PNGs so the
 * §1.1 visual gate can actually be inspected.
 *
 * Usage: tsx scripts/render-pdf-pages.ts <pdf> <outDir> [scale]
 */
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const [pdfPath, outDir, scaleArg] = process.argv.slice(2);
  const scale = Number(scaleArg ?? 2);
  mkdirSync(outDir, { recursive: true });

  // pdfjs-dist 6.x is ESM-only; the legacy build avoids DOM/worker assumptions.
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({
    data,
    disableFontFace: true,
    standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/",
    cMapUrl: "./node_modules/pdfjs-dist/cmaps/",
    cMapPacked: true,
  }).promise;
  console.log(`${pdfPath}: ${doc.numPages} pages`);

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as any, viewport: vp }).promise;
    const file = join(outDir, `page-${String(i).padStart(2, "0")}.png`);
    writeFileSync(file, canvas.toBuffer("image/png"));
    console.log(`  ${file} ${canvas.width}x${canvas.height}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
