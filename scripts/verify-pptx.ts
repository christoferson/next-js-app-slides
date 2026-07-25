/**
 * §1.1 GATING SPIKE — pptxgenjs capability probe.
 *
 * Builds one .pptx exercising every capability the template/zone design depends on,
 * then (in verify-pptx-assert.ts) cracks the OOXML open to prove the geometry.
 *
 * Run: npx tsx scripts/verify-pptx.ts
 */
import pptxgen from "pptxgenjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SLIDE_16x9, zoneToInches, type SlotZone } from "./zone-math";
import { FONT_CANDIDATES } from "./fonts-candidates";

const OUT_DIR = join(process.cwd(), "out");
const FIXTURES = join(process.cwd(), "fixtures");
mkdirSync(OUT_DIR, { recursive: true });

/** Deliberately asymmetric zones (§8) — off-centre so wrong math is obvious. */
export const PROBE_ZONES: SlotZone[] = [
  { slotKey: "title", x: 8, y: 12, w: 60, h: 20, align: "left", valign: "top" },
  { slotKey: "subtitle", x: 8, y: 34, w: 45, h: 10, align: "left", valign: "middle" },
  { slotKey: "bullets", x: 8, y: 48, w: 52, h: 34, align: "left", valign: "top" },
  { slotKey: "sidebar", x: 66, y: 48, w: 26, h: 34, align: "right", valign: "bottom" },
  { slotKey: "centered", x: 25, y: 88, w: 50, h: 8, align: "center", valign: "middle" },
];

const notes: string[] = [];
const note = (s: string) => { notes.push(s); console.log(s); };

function newDeck() {
  const pptx = new pptxgen();
  pptx.defineLayout(SLIDE_16x9);          // capability: custom 16:9 layout
  pptx.layout = SLIDE_16x9.name;
  return pptx;
}

async function main() {
  const pptx = newDeck();
  note(`pptxgenjs version: ${(pptx as any).version ?? "unknown"}`);
  note(`presLayout after defineLayout: ${JSON.stringify(pptx.presLayout)}`);

  // ── Slide 1: templated render — full-bleed bg + zone-positioned text + logo ──
  const s1 = pptx.addSlide();

  // (1) full-bleed background image
  s1.addImage({
    path: join(FIXTURES, "bg-16x9.png"),
    x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height,
  });

  const z = (k: string) => {
    const zone = PROBE_ZONES.find((p) => p.slotKey === k)!;
    return { zone, box: zoneToInches(zone) };
  };

  // (2) text box at percent-derived coords, incl. CJK round-trip
  {
    const { zone, box } = z("title");
    s1.addText("Zone-positioned title — 日本語も確認", {
      ...box, align: zone.align, valign: zone.valign,
      fontFace: "Georgia", fontSize: 28, color: "FFFFFF", margin: 0,
    });
  }
  {
    const { zone, box } = z("subtitle");
    s1.addText("Subtitle in a middle-valign zone", {
      ...box, align: zone.align, valign: zone.valign,
      fontFace: "Verdana", fontSize: 14, color: "FFD600", margin: 0,
    });
  }

  // (3) bullets as itemized runs + (4) shrink-to-fit via the NON-deprecated `fit`
  {
    const { zone, box } = z("bullets");
    s1.addText(
      [
        { text: "Point one — itemized run", options: { bullet: true } },
        { text: "Point two — nested", options: { bullet: true, indentLevel: 1 } },
        { text: "Point three", options: { bullet: { type: "number" } } },
      ],
      { ...box, align: zone.align, valign: zone.valign, fontSize: 16, color: "FFFFFF", fit: "shrink", margin: 0 },
    );
  }

  // right/bottom alignment probe
  {
    const { zone, box } = z("sidebar");
    s1.addText("right + bottom", {
      ...box, align: zone.align, valign: zone.valign,
      fontSize: 12, color: "00D6FF", margin: 0,
    });
  }
  {
    const { zone, box } = z("centered");
    s1.addText("centered footer zone", {
      ...box, align: zone.align, valign: zone.valign,
      fontSize: 11, color: "FFFFFF", margin: 0,
    });
  }

  // (5) logo image in a corner
  s1.addImage({ path: join(FIXTURES, "logo.png"), x: 9.0, y: 0.2, w: 0.8, h: 0.8 });

  s1.addNotes("Speaker notes round-trip probe — 600 char budget slot.");

  // ── Slide 2: overflow behaviour (drives truncation budgets) ──
  const s2 = pptx.addSlide();
  const overflowBox = zoneToInches({ x: 8, y: 20, w: 40, h: 15 });
  const long = "Overflow probe. ".repeat(40);
  s2.addText(long, { ...overflowBox, fontSize: 18, color: "1A1A2E", fit: "none", margin: 0, line: { color: "FF00AA", width: 1 } });
  const shrinkBox = zoneToInches({ x: 52, y: 20, w: 40, h: 15 });
  s2.addText(long, { ...shrinkBox, fontSize: 18, color: "1A1A2E", fit: "shrink", margin: 0, line: { color: "00AAFF", width: 1 } });

  // ── Slide 3: token-styled (no background) — solid fill + shapes ──
  const s3 = pptx.addSlide();
  s3.background = { color: "1A1A2E" };
  s3.addShape("rect", { x: 0, y: 0, w: 0.25, h: SLIDE_16x9.height, fill: { color: "FF00AA" } });
  s3.addText("Token-styled render path", {
    ...zoneToInches({ x: 8, y: 12, w: 84, h: 20 }),
    fontFace: "Verdana", fontSize: 30, color: "FFFFFF", bold: true, margin: 0,
  });

  // ── Slide 4: letterbox — 4:3 background, "contain" (no distortion) ──
  const s4 = pptx.addSlide();
  s4.background = { color: "000000" };
  const srcAspect = 800 / 600;
  const containH = SLIDE_16x9.height;
  const containW = containH * srcAspect;
  s4.addImage({
    path: join(FIXTURES, "bg-4x3.png"),
    x: (SLIDE_16x9.width - containW) / 2, y: 0, w: containW, h: containH,
  });
  s4.addText("4:3 background, contain (pillarboxed) — no distortion", {
    ...zoneToInches({ x: 8, y: 80, w: 84, h: 12 }),
    fontSize: 16, color: "FFFFFF", margin: 0,
  });

  // ── Slides 5+: one slide per FONTS candidate ──
  for (const f of FONT_CANDIDATES) {
    const fs = pptx.addSlide();
    fs.background = { color: "FFFFFF" };
    fs.addText(`${f.id} → pptxName: "${f.pptxName}"`, {
      x: 0.4, y: 0.3, w: 9.2, h: 0.5, fontFace: "Arial", fontSize: 12, color: "888888", margin: 0,
    });
    fs.addText("Handgloves 0123 — The quick brown fox; 日本語テスト", {
      x: 0.4, y: 1.1, w: 9.2, h: 1.4, fontFace: f.pptxName, fontSize: 36, color: "1A1A2E", margin: 0,
    });
    fs.addText("Body sample: On-brand by construction. AVAST Wavy 1,234.56", {
      x: 0.4, y: 2.7, w: 9.2, h: 1.0, fontFace: f.pptxName, fontSize: 18, color: "1A1A2E", margin: 0,
    });
  }

  // (6) server-side buffer output — verified API on the pinned version
  const buf = await pptx.write({ outputType: "nodebuffer" });
  note(`write({outputType:"nodebuffer"}) -> ${buf?.constructor?.name}, isBuffer=${Buffer.isBuffer(buf)}, bytes=${(buf as Buffer).length}`);
  const file = join(OUT_DIR, "verify-pptx.pptx");
  writeFileSync(file, buf as Buffer);
  note(`wrote ${file}`);

  // sanity: default write() (no props) for comparison
  const d2 = newDeck();
  d2.addSlide().addText("x", { x: 1, y: 1, w: 2, h: 1 });
  const def = await d2.write();
  note(`write() with no props -> ${def?.constructor?.name}`);

  writeFileSync(join(OUT_DIR, "probe-zones.json"), JSON.stringify({ slide: SLIDE_16x9, zones: PROBE_ZONES }, null, 2));
  writeFileSync(join(OUT_DIR, "spike-notes.txt"), notes.join("\n"));
}

main().catch((e) => { console.error("SPIKE FAILED:", e); process.exit(1); });
