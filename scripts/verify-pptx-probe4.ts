/**
 * §1.1 follow-up — media duplication severity + mitigation.
 *  H) Realistic 1920x1080 JPEG-ish background × 15 slides: deck size blow-up.
 *  I) Mitigation A: identical `data:` string — deduped?
 *  J) Mitigation B: background on a slide MASTER via defineSlideMaster, slides reference it.
 *  K) Mitigation C: post-process the zip — rewrite duplicate media rels to one part.
 */
import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SLIDE_16x9, zoneToInches } from "./zone-math";

const OUT = join(process.cwd(), "out");
const FIX = join(process.cwd(), "fixtures");

function deck() {
  const p = new pptxgen();
  p.defineLayout(SLIDE_16x9);
  p.layout = SLIDE_16x9.name;
  return p;
}
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

async function mediaStats(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const media = Object.keys(zip.files).filter((n) => /^ppt\/media\/.+/.test(n));
  const hashes = new Map<string, number>();
  for (const m of media) {
    const b = await zip.file(m)!.async("nodebuffer");
    const h = createHash("sha1").update(b).digest("hex").slice(0, 12);
    hashes.set(h, (hashes.get(h) ?? 0) + 1);
  }
  return { parts: media.length, distinct: hashes.size, dupes: [...hashes.values()].filter((v) => v > 1) };
}

async function main() {
  const bigPath = join(FIX, "bg-1920.png");
  const bigSize = statSync(bigPath).size;
  const bigData = `image/png;base64,${readFileSync(bigPath).toString("base64")}`;
  console.log(`source background: ${kb(bigSize)} (1920x1080)\n`);

  // H) path input, 15 slides
  {
    const p = deck();
    for (let i = 0; i < 15; i++) {
      const s = p.addSlide();
      s.addImage({ path: bigPath, x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height });
      s.addText(`Slide ${i + 1}`, { ...zoneToInches({ x: 8, y: 12, w: 84, h: 20 }), fontSize: 28, color: "FFFFFF" });
    }
    const t0 = process.hrtime.bigint();
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const st = await mediaStats(buf);
    console.log(`H) path × 15 slides:  ${kb(buf.length)} in ${ms.toFixed(0)} ms — ${st.parts} media parts, ${st.distinct} distinct`);
    console.log(`   overhead vs single embed: ${(buf.length / bigSize).toFixed(1)}× the background size`);
    writeFileSync(join(OUT, "probe4-path.pptx"), buf);
  }

  // I) identical data: string, 15 slides
  {
    const p = deck();
    for (let i = 0; i < 15; i++) {
      const s = p.addSlide();
      s.addImage({ data: bigData, x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height });
      s.addText(`Slide ${i + 1}`, { ...zoneToInches({ x: 8, y: 12, w: 84, h: 20 }), fontSize: 28, color: "FFFFFF" });
    }
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const st = await mediaStats(buf);
    console.log(`I) data × 15 slides:  ${kb(buf.length)} — ${st.parts} media parts, ${st.distinct} distinct → dedup ${st.parts === st.distinct && st.parts > 1 ? "NO" : "?"}`);
  }

  // J) slide master carrying the background
  {
    const p = deck();
    p.defineSlideMaster({
      title: "BRAND_TITLE_BG",
      background: { path: bigPath },
    });
    for (let i = 0; i < 15; i++) {
      const s = p.addSlide({ masterName: "BRAND_TITLE_BG" });
      s.addText(`Slide ${i + 1}`, { ...zoneToInches({ x: 8, y: 12, w: 84, h: 20 }), fontSize: 28, color: "FFFFFF" });
    }
    const t0 = process.hrtime.bigint();
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const st = await mediaStats(buf);
    const zip = await JSZip.loadAsync(buf);
    const masterXml = await zip.file("ppt/slideMasters/slideMaster1.xml")!.async("string");
    const s1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    console.log(`J) master bg × 15:    ${kb(buf.length)} in ${ms.toFixed(0)} ms — ${st.parts} media parts, ${st.distinct} distinct`);
    console.log(`   master has blipFill bg: ${/<p:bg>[\s\S]*?blip/.test(masterXml)}; slide1 has own pic: ${/<p:pic>/.test(s1)}`);
    console.log(`   → ${st.parts === 1 ? "DEDUP ACHIEVED: one embed for the whole deck" : "still duplicated"}`);
    writeFileSync(join(OUT, "probe4-master.pptx"), buf);
  }

  // J2) does a master-based slide still honour per-slide zone text + a second image (logo)?
  {
    const p = deck();
    p.defineSlideMaster({ title: "M", background: { path: bigPath } });
    const s = p.addSlide({ masterName: "M" });
    s.addText("zoned over master bg", { ...zoneToInches({ x: 8, y: 12, w: 60, h: 20 }), fontSize: 28, color: "FFFFFF", align: "left", valign: "top" });
    s.addImage({ path: join(FIX, "logo.png"), x: 9, y: 0.2, w: 0.8, h: 0.8 });
    const buf = (await p.write({ outputType: "nodebuffer" })) as Buffer;
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const off = /<a:off x="(\d+)" y="(\d+)"\/>/.exec(xml);
    console.log(`J2) master + zoned text + logo: text off=(${off?.[1]},${off?.[2]}) expected (731520,617220) → ${off?.[1] === "731520" && off?.[2] === "617220" ? "zone math unaffected by master" : "MISMATCH"}`);
    const st = await mediaStats(buf);
    console.log(`    media parts=${st.parts} distinct=${st.distinct} (bg + logo)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
