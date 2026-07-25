/**
 * §1.1 follow-up probes for the two riskiest details:
 *  A) CJK: does pptxgenjs write <a:ea>/<a:cs> typefaces, or only <a:latin>?
 *     (If only latin, PowerPoint picks the East-Asian font itself for CJK runs —
 *      brand font control over CJK text is then NOT guaranteed.)
 *  B) Native image `sizing: {type:'contain'|'cover'}` vs our manual letterbox math.
 *  C) Zone overflow: measured text width vs zone width, to calibrate maxChars budgets.
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SLIDE_16x9, zoneToInches, toEmu } from "./zone-math";

const OUT = join(process.cwd(), "out");
const FIX = join(process.cwd(), "fixtures");

async function build() {
  const pptx = new pptxgen();
  pptx.defineLayout(SLIDE_16x9);
  pptx.layout = SLIDE_16x9.name;

  // A) CJK typeface probe
  const a = pptx.addSlide();
  a.addText("Latin only", { x: 0.5, y: 0.5, w: 4, h: 1, fontFace: "Georgia", fontSize: 20 });
  a.addText("日本語のみ", { x: 0.5, y: 1.6, w: 4, h: 1, fontFace: "Georgia", fontSize: 20 });
  a.addText("Mixed 混在 text", { x: 0.5, y: 2.7, w: 4, h: 1, fontFace: "Georgia", fontSize: 20 });

  // B) native sizing: contain + cover on a 4:3 source in a 16:9 full-bleed box
  const b = pptx.addSlide();
  b.addImage({
    path: join(FIX, "bg-4x3.png"),
    x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height,
    sizing: { type: "contain", w: SLIDE_16x9.width, h: SLIDE_16x9.height },
  });
  const c = pptx.addSlide();
  c.addImage({
    path: join(FIX, "bg-4x3.png"),
    x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height,
    sizing: { type: "cover", w: SLIDE_16x9.width, h: SLIDE_16x9.height },
  });

  const buf = await pptx.write({ outputType: "nodebuffer" });
  writeFileSync(join(OUT, "probe2.pptx"), buf as Buffer);
  return buf as Buffer;
}

function shapes(xml: string) {
  return [...xml.matchAll(/<p:(sp|pic)>([\s\S]*?)<\/p:\1>/g)].map((m) => ({ kind: m[1], body: m[2] }));
}

async function main() {
  const zip = await JSZip.loadAsync(await build());
  const s1 = await zip.file("ppt/slides/slide1.xml")!.async("string");

  console.log("=== A) CJK typeface handling ===");
  for (const s of shapes(s1)) {
    const text = [...s.body.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("");
    const latin = /<a:latin typeface="([^"]*)"/.exec(s.body)?.[1];
    const ea = /<a:ea typeface="([^"]*)"/.exec(s.body)?.[1];
    const cs = /<a:cs typeface="([^"]*)"/.exec(s.body)?.[1];
    const legacy = /typeface="([^"]*)"/.exec(s.body)?.[1];
    console.log(` "${text}" → latin=${latin ?? "-"} ea=${ea ?? "ABSENT"} cs=${cs ?? "ABSENT"} (first typeface attr: ${legacy})`);
  }
  const raw = /<a:rPr[^>]*>[\s\S]{0,200}/.exec(s1)?.[0] ?? "";
  console.log(" sample rPr block:", raw.replace(/\s+/g, " ").slice(0, 220));

  console.log("\n=== B) native sizing contain/cover ===");
  for (const [i, label] of [["2", "contain"], ["3", "cover"]] as const) {
    const xml = await zip.file(`ppt/slides/slide${i}.xml`)!.async("string");
    const pic = shapes(xml).find((s) => s.kind === "pic")!;
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(pic.body);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(pic.body);
    const srcRect = /<a:srcRect([^/]*)\/>/.exec(pic.body)?.[1] ?? "ABSENT";
    const stretch = /<a:stretch>/.test(pic.body);
    console.log(` ${label}: off=(${off?.[1]},${off?.[2]}) ext=(${ext?.[1]}x${ext?.[2]}) srcRect=${srcRect.trim() || "empty"} stretch=${stretch}`);
    console.log(`   → aspect ${(Number(ext?.[1]) / Number(ext?.[2])).toFixed(4)}; slide aspect ${(toEmu(SLIDE_16x9.width) / toEmu(SLIDE_16x9.height)).toFixed(4)}; src aspect 1.3333`);
  }

  console.log("\n=== C) rough char-budget calibration (Georgia-like avg 0.5em advance) ===");
  const zonesToCheck = [
    { slotKey: "title", w: 60, fontSize: 28 },
    { slotKey: "subtitle", w: 45, fontSize: 14 },
    { slotKey: "bullets", w: 52, h: 34, fontSize: 16 },
  ];
  for (const zz of zonesToCheck) {
    const box = zoneToInches({ x: 0, y: 0, w: zz.w, h: zz.h ?? 10 });
    const widthPt = box.w * 72;
    const charsPerLine = Math.floor(widthPt / (zz.fontSize * 0.5));
    const lines = zz.h ? Math.floor((box.h * 72) / (zz.fontSize * 1.2)) : 1;
    console.log(` ${zz.slotKey}: ${box.w.toFixed(2)}in wide @ ${zz.fontSize}pt → ~${charsPerLine} chars/line × ${lines} line(s) ≈ ${charsPerLine * lines} chars before overflow`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
