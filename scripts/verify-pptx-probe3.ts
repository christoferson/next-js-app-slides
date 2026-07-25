/**
 * §1.1 follow-up probes — production concerns:
 *  D) 15-slide deck timing + media dedup (does one reused background embed 15×?)
 *  E) `data:` base64 input (asset store returns streams/buffers, not paths — §6.4
 *     forbids ports returning filesystem paths, so the exporter must use base64).
 *  F) failure modes: missing image path, bogus fontFace, out-of-bounds zone, negative srcRect.
 *  G) does `sizing:{type:'contain'}` with mismatched box emit negative srcRect (corrupt)?
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SLIDE_16x9, zoneToInches } from "./zone-math";

const OUT = join(process.cwd(), "out");
const FIX = join(process.cwd(), "fixtures");
const bgBuf = readFileSync(join(FIX, "bg-16x9.png"));
const bgData = `image/png;base64,${bgBuf.toString("base64")}`;

function deck() {
  const p = new pptxgen();
  p.defineLayout(SLIDE_16x9);
  p.layout = SLIDE_16x9.name;
  return p;
}

async function main() {
  // ── D) 15-slide deck, same bg via `path` ──
  {
    const t0 = process.hrtime.bigint();
    const p = deck();
    for (let i = 0; i < 15; i++) {
      const s = p.addSlide();
      s.addImage({ path: join(FIX, "bg-16x9.png"), x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height });
      s.addText(`Slide ${i + 1}`, { ...zoneToInches({ x: 8, y: 12, w: 84, h: 20 }), fontFace: "Georgia", fontSize: 28, color: "FFFFFF" });
      s.addNotes("n".repeat(600));
    }
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const zip = await JSZip.loadAsync(buf);
    const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/"));
    console.log(`D) 15 slides via path: ${ms.toFixed(0)} ms, ${(buf.length / 1024).toFixed(0)} KB, media parts = ${media.length}`);
    console.log(`   media: ${media.join(", ")}`);
    console.log(`   → dedup: ${media.length === 1 ? "YES (single embed reused)" : `NO — ${media.length} copies; size grows linearly with slide count`}`);
    writeFileSync(join(OUT, "probe3-15slides.pptx"), buf);
  }

  // ── E) same via base64 data ──
  {
    const t0 = process.hrtime.bigint();
    const p = deck();
    for (let i = 0; i < 15; i++) {
      const s = p.addSlide();
      s.addImage({ data: bgData, x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height });
      s.addText(`Slide ${i + 1}`, { ...zoneToInches({ x: 8, y: 12, w: 84, h: 20 }), fontFace: "Georgia", fontSize: 28, color: "FFFFFF" });
    }
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const zip = await JSZip.loadAsync(buf);
    const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/"));
    console.log(`E) 15 slides via data: ${ms.toFixed(0)} ms, ${(buf.length / 1024).toFixed(0)} KB, media parts = ${media.length}`);
    console.log(`   → base64 (\`data:\`) input works without touching the filesystem: ${media.length > 0 ? "YES" : "NO"}`);
  }

  // ── F) failure modes ──
  console.log("F) failure modes:");
  {
    const p = deck();
    p.addSlide().addImage({ path: join(FIX, "does-not-exist.png"), x: 0, y: 0, w: 10, h: 5.625 });
    try {
      const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
      console.log(`   missing image path: NO THROW — produced ${buf.length} bytes (silent bad deck!)`);
      const zip = await JSZip.loadAsync(buf);
      console.log(`     media parts: ${Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/")).join(",") || "none"}`);
    } catch (e: any) {
      console.log(`   missing image path: THROWS → ${e?.message?.slice(0, 120)}`);
    }
  }
  {
    const p = deck();
    p.addSlide().addText("bogus font", { x: 1, y: 1, w: 4, h: 1, fontFace: "Zapfino-DoesNotExist" });
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    console.log(`   unknown fontFace: no validation — written verbatim = ${xml.includes('typeface="Zapfino-DoesNotExist"')} (PowerPoint substitutes silently at render)`);
  }
  {
    const p = deck();
    const s = p.addSlide();
    // zone deliberately off-slide / oversized — does the lib clamp?
    s.addText("off-slide", { ...zoneToInches({ x: 90, y: 95, w: 40, h: 30 }), fontSize: 18 });
    s.addText("negative", { x: -1, y: -0.5, w: 3, h: 1, fontSize: 18 });
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const offs = [...xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/g)].map((m) => `${m[1]},${m[2]}`);
    const exts = [...xml.matchAll(/<a:ext cx="(-?\d+)" cy="(-?\d+)"\/>/g)].map((m) => `${m[1]}x${m[2]}`);
    console.log(`   out-of-bounds zone: NOT clamped — offs=[${offs.join(" | ")}] exts=[${exts.join(" | ")}] → zod must enforce 0..100 bounds`);
  }

  // ── G) sizing contain with mismatched box → negative srcRect? ──
  {
    const p = deck();
    p.addSlide().addImage({
      path: join(FIX, "bg-4x3.png"),
      x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height,
      sizing: { type: "contain", w: 4, h: 5 },   // box != declared w/h
    });
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const sr = /<a:srcRect([^/]*)\/>/.exec(xml)?.[1]?.trim();
    const negative = /-\d/.test(sr ?? "");
    console.log(`G) sizing contain w/ mismatched box → srcRect=${sr}`);
    console.log(`   negative srcRect values present: ${negative} ${negative ? "→ INVALID OOXML crop; do NOT use `sizing`, use explicit letterbox math" : ""}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
