/**
 * Table test for placeBackground() + imageSize(), and an end-to-end proof that
 * the placement it returns serializes to non-distorted, non-negative-srcRect OOXML.
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SLIDE_16x9, toEmu } from "./zone-math";
import { placeBackground, imageSize } from "./letterbox";

let fails = 0;
const t = (ok: boolean, label: string, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

const S = SLIDE_16x9;

// ── imageSize on real fixtures ──
const FIX = join(process.cwd(), "fixtures");
for (const [f, w, h] of [["bg-16x9.png", 960, 540], ["bg-4x3.png", 800, 600], ["bg-1920.png", 1920, 1080], ["logo.png", 128, 128]] as const) {
  const got = imageSize(readFileSync(join(FIX, f)));
  t(got?.width === w && got?.height === h, `imageSize(${f})`, `${got?.width}x${got?.height} (want ${w}x${h})`);
}

// ── placement table ──
const cases = [
  { name: "exact 16:9", img: { width: 1920, height: 1080 }, fit: "contain" as const, expect: { w: 10, h: 5.625, letterboxed: false } },
  { name: "16:9 odd pixel (1920x1081)", img: { width: 1920, height: 1081 }, fit: "contain" as const, expect: { w: 10, h: 5.625, letterboxed: false } },
  { name: "4:3 contain → pillarbox", img: { width: 800, height: 600 }, fit: "contain" as const, expect: { w: 7.5, h: 5.625, letterboxed: true } },
  { name: "4:3 cover → crop sides", img: { width: 800, height: 600 }, fit: "cover" as const, expect: { w: 10, h: 7.5, letterboxed: false } },
  { name: "ultrawide 21:9 contain → letterbox top/bottom", img: { width: 2560, height: 1080 }, fit: "contain" as const, expect: { w: 10, h: 4.21875, letterboxed: true } },
  { name: "portrait 9:16 contain", img: { width: 1080, height: 1920 }, fit: "contain" as const, expect: { w: 3.1640625, h: 5.625, letterboxed: true } },
  { name: "4:3 stretch → distorted by choice", img: { width: 800, height: 600 }, fit: "stretch" as const, expect: { w: 10, h: 5.625, letterboxed: false } },
];
for (const c of cases) {
  const p = placeBackground(c.img, S, c.fit);
  const ok = Math.abs(p.w - c.expect.w) < 1e-6 && Math.abs(p.h - c.expect.h) < 1e-6 && p.letterboxed === c.expect.letterboxed;
  t(ok, `placeBackground ${c.name}`,
    `x=${p.x.toFixed(4)} y=${p.y.toFixed(4)} w=${p.w.toFixed(4)} h=${p.h.toFixed(4)} letterboxed=${p.letterboxed} cropped=${p.cropped}`);
  // centred?
  t(Math.abs((p.x * 2 + p.w) - S.width) < 1e-6 && Math.abs((p.y * 2 + p.h) - S.height) < 1e-6,
    `  ${c.name}: centred on slide`);
  // Aspect preserved unless stretch, OR the source is within snap tolerance of 16:9
  // (near-16:9 deliberately goes full-bleed; sub-1% deviation is the designed trade).
  const srcA = c.img.width / c.img.height;
  const snapped = Math.abs(srcA - S.width / S.height) <= 0.005 * (S.width / S.height);
  if (c.fit !== "stretch" && !snapped) {
    t(Math.abs(p.w / p.h - srcA) < 1e-6, `  ${c.name}: source aspect preserved`, `${(p.w / p.h).toFixed(5)} vs ${srcA.toFixed(5)}`);
  } else if (snapped) {
    const deviation = Math.abs(p.w / p.h - srcA) / srcA;
    t(deviation < 0.01, `  ${c.name}: snapped to full-bleed, distortion under 1%`, `${(deviation * 100).toFixed(3)}%`);
  }
}

// ── end-to-end: does the placement serialize cleanly (no negative srcRect, aspect kept)? ──
async function e2e() {
  const p = new pptxgen();
  p.defineLayout(S);
  p.layout = S.name;
  const buf43 = readFileSync(join(FIX, "bg-4x3.png"));
  const place = placeBackground(imageSize(buf43)!, S, "contain");
  const s = p.addSlide();
  s.background = { color: "000000" };
  s.addImage({ data: `image/png;base64,${buf43.toString("base64")}`, x: place.x, y: place.y, w: place.w, h: place.h });
  const out = (await p.write({ outputType: "nodebuffer" })) as Buffer;
  const zip = await JSZip.loadAsync(out);
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const pic = /<p:pic>[\s\S]*?<\/p:pic>/.exec(xml)![0];
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(pic)!;
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(pic)!;
  t(!/<a:srcRect[^/]*-\d/.test(pic), "e2e: no negative srcRect crop values");
  t(+off[1] === toEmu(place.x) && +ext[1] === toEmu(place.w), "e2e: EMU matches placeBackground output",
    `off.x=${off[1]} (want ${toEmu(place.x)}), ext.cx=${ext[1]} (want ${toEmu(place.w)})`);
  t(Math.abs(+ext[1] / +ext[2] - 4 / 3) < 1e-3, "e2e: 4:3 aspect preserved in OOXML", `${(+ext[1] / +ext[2]).toFixed(4)}`);
  console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
  if (fails) process.exit(1);
}
e2e();
