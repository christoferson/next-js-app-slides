/**
 * §1.1 final probes — the master-background mitigation in realistic conditions:
 *  L) Multiple distinct backgrounds (one master per brand template) — still 1 media part each?
 *  M) Master background from base64 `data:` (asset ports must not return fs paths).
 *  N) Does a master background STRETCH a 4:3 image (distortion) — i.e. is the letterbox
 *     path forced onto slide-level addImage, giving up dedup for non-16:9 assets?
 *  O) Mixed deck: some slides templated (master bg), some token-styled (solid bg).
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SLIDE_16x9, zoneToInches, toEmu } from "./zone-math";

const OUT = join(process.cwd(), "out");
const FIX = join(process.cwd(), "fixtures");
const big = join(FIX, "bg-1920.png");
const bigData = `image/png;base64,${readFileSync(big).toString("base64")}`;
const fourThree = join(FIX, "bg-4x3.png");

function deck() {
  const p = new pptxgen();
  p.defineLayout(SLIDE_16x9);
  p.layout = SLIDE_16x9.name;
  return p;
}
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

async function stats(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const media = Object.keys(zip.files).filter((n) => /^ppt\/media\/.+/.test(n));
  const hashes = new Set<string>();
  for (const m of media) hashes.add(createHash("sha1").update(await zip.file(m)!.async("nodebuffer")).digest("hex"));
  return { zip, parts: media.length, distinct: hashes.size, names: media };
}

async function main() {
  // L) three distinct backgrounds via three masters, 15 slides cycling through them
  {
    const p = deck();
    p.defineSlideMaster({ title: "T_title", background: { path: big } });
    p.defineSlideMaster({ title: "T_section", background: { path: join(FIX, "bg-16x9.png") } });
    p.defineSlideMaster({ title: "T_content", background: { path: fourThree } });
    const masters = ["T_title", "T_section", "T_content"];
    for (let i = 0; i < 15; i++) {
      const s = p.addSlide({ masterName: masters[i % 3] });
      s.addText(`Slide ${i + 1}`, { ...zoneToInches({ x: 8, y: 12, w: 60, h: 20 }), fontSize: 28, color: "FFFFFF" });
    }
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const st = await stats(buf);
    console.log(`L) 3 masters / 15 slides: ${kb(buf.length)} — ${st.parts} media parts, ${st.distinct} distinct`);
    console.log(`   → ${st.parts === 3 ? "one embed per distinct background (optimal)" : `unexpected: ${st.names.join(", ")}`}`);
    writeFileSync(join(OUT, "probe5-multimaster.pptx"), buf);
  }

  // M) master background from base64
  {
    const p = deck();
    p.defineSlideMaster({ title: "T_data", background: { data: bigData } });
    for (let i = 0; i < 5; i++) p.addSlide({ masterName: "T_data" }).addText(`S${i}`, { x: 1, y: 1, w: 3, h: 1, color: "FFFFFF" });
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const st = await stats(buf);
    const layout = await st.zip.file("ppt/slideLayouts/slideLayout2.xml")!.async("string");
    console.log(`M) master bg via base64 data: ${st.parts} media part(s), layout has blipFill bg: ${/<p:bgPr>[\s\S]*?blipFill/.test(layout)}`);
    console.log(`   → ${st.parts === 1 && /blipFill/.test(layout) ? "WORKS without filesystem paths" : "FAILED"}`);
  }

  // N) master background fill mode — stretch (distorts) vs contain?
  {
    const p = deck();
    p.defineSlideMaster({ title: "T_43", background: { path: fourThree } });
    p.addSlide({ masterName: "T_43" }).addText("4:3 as master bg", { x: 1, y: 1, w: 5, h: 1, color: "FFFFFF" });
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const st = await stats(buf);
    const layout = await st.zip.file("ppt/slideLayouts/slideLayout2.xml")!.async("string");
    const stretch = /<a:stretch><a:fillRect\/><\/a:stretch>/.test(layout);
    const srcRect = /<a:srcRect([^/]*)\/>/.exec(layout)?.[1]?.trim() || "(empty)";
    console.log(`N) 4:3 master bg: stretch/fillRect=${stretch}, srcRect=${srcRect}`);
    console.log(`   → master bg ALWAYS stretches to slide (${stretch ? "confirmed" : "not confirmed"}); a 4:3 asset is DISTORTED, not letterboxed.`);
    console.log(`     Letterbox therefore requires slide-level addImage with explicit contain math (loses dedup for that asset).`);
  }

  // O) mixed deck: templated (master) + token-styled (solid) slides in one file
  {
    const p = deck();
    p.defineSlideMaster({ title: "T_brand", background: { path: big } });
    for (let i = 0; i < 6; i++) {
      if (i % 2 === 0) {
        const s = p.addSlide({ masterName: "T_brand" });
        s.addText(`templated ${i}`, { ...zoneToInches({ x: 8, y: 12, w: 60, h: 20 }), fontSize: 24, color: "FFFFFF" });
      } else {
        const s = p.addSlide();
        s.background = { color: "1A1A2E" };
        s.addText(`token-styled ${i}`, { ...zoneToInches({ x: 8, y: 12, w: 60, h: 20 }), fontSize: 24, color: "FFFFFF" });
      }
    }
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const st = await stats(buf);
    const s2 = await st.zip.file("ppt/slides/slide2.xml")!.async("string");
    const s1 = await st.zip.file("ppt/slides/slide1.xml")!.async("string");
    const r1 = await st.zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("string");
    const r2 = await st.zip.file("ppt/slides/_rels/slide2.xml.rels")!.async("string");
    console.log(`O) mixed deck: ${kb(buf.length)}, ${st.parts} media part(s)`);
    console.log(`   templated slide1 → layout ${/slideLayout(\d+)/.exec(r1)?.[0]}; token slide2 → layout ${/slideLayout(\d+)/.exec(r2)?.[0]}`);
    console.log(`   slide2 own <p:bg> solid: ${/<p:bg>[\s\S]*?srgbClr val="1A1A2E"/.test(s2)}; slide1 has no own bg: ${!/<p:bg>/.test(s1)}`);
    console.log(`   → both render strategies coexist in one deck: ${st.parts === 1 && /srgbClr val="1A1A2E"/.test(s2) ? "YES" : "CHECK"}`);
    writeFileSync(join(OUT, "probe5-mixed.pptx"), buf);
  }

  // P) explicit letterbox (contain) at slide level — the fallback for non-16:9
  {
    const p = deck();
    const s = p.addSlide();
    s.background = { color: "000000" };
    const srcAspect = 800 / 600;
    const w = SLIDE_16x9.height * srcAspect;
    s.addImage({ path: fourThree, x: (SLIDE_16x9.width - w) / 2, y: 0, w, h: SLIDE_16x9.height });
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const st = await stats(buf);
    const xml = await st.zip.file("ppt/slides/slide1.xml")!.async("string");
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/g;
    const all = [...xml.matchAll(ext)].map((m) => [+m[1], +m[2]]).filter(([a, b]) => a > 0 && b > 0);
    const pic = all[0];
    console.log(`P) explicit contain: ext=${pic?.[0]}x${pic?.[1]} aspect=${(pic[0] / pic[1]).toFixed(4)} (src 1.3333) → ${Math.abs(pic[0] / pic[1] - 4 / 3) < 1e-3 ? "no distortion" : "DISTORTED"}`);
    console.log(`   x-offset=${/<a:off x="(\d+)"/.exec(xml.slice(xml.indexOf("<p:pic>")))?.[1]} (expected ${Math.round((toEmu(SLIDE_16x9.width) - toEmu(w)) / 2)})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
