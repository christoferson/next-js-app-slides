/**
 * §1.1 assertions — cracks out/verify-pptx.pptx and proves, from the OOXML itself:
 *  - slide size is exactly 16:9 at 10in x 5.625in
 *  - the background image is full-bleed (offset 0,0 / extent == slide extent)
 *  - every zone's text box landed at the EMU equivalent of our percent math
 *  - align / valign / bullets / fit / fontFace / CJK survived serialization
 *  - each FONTS candidate's pptxName is written verbatim (no library-side substitution)
 *
 * Run: npx tsx scripts/verify-pptx-assert.ts
 */
import JSZip from "jszip";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SLIDE_16x9, zoneToInches, toEmu, EMU_PER_INCH } from "./zone-math";
import { PROBE_ZONES } from "./verify-pptx";
import { FONT_CANDIDATES } from "./fonts-candidates";

const results: Array<{ ok: boolean; label: string; detail: string }> = [];
const check = (ok: boolean, label: string, detail = "") => {
  results.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

/**
 * Locally-installed font families — only used to report substitution RISK.
 * A font missing here still writes verbatim into the OOXML; it just cannot be
 * visually confirmed on this machine.
 */
function listInstalledFonts(): string[] {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | Select -Exp Name",
    ], { encoding: "utf8" });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** All <p:sp> / <p:pic> blocks with their xfrm offsets/extents, in document order. */
interface Shape { xml: string; kind: "sp" | "pic"; off?: { x: number; y: number }; ext?: { cx: number; cy: number }; text: string }

function parseShapes(xml: string): Shape[] {
  const out: Shape[] = [];
  const re = /<p:(sp|pic)>([\s\S]*?)<\/p:\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(body);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(body);
    const text = [...body.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join(" ");
    out.push({
      xml: body,
      kind: m[1] as "sp" | "pic",
      off: off ? { x: +off[1], y: +off[2] } : undefined,
      ext: ext ? { cx: +ext[1], cy: +ext[2] } : undefined,
      text,
    });
  }
  return out;
}

async function main() {
  const zip = await JSZip.loadAsync(readFileSync(join(process.cwd(), "out", "verify-pptx.pptx")));
  const names = Object.keys(zip.files);
  check(names.includes("[Content_Types].xml") && names.includes("ppt/presentation.xml"), "OOXML package structure valid",
    `${names.length} parts`);

  // ── slide size ──
  const pres = await zip.file("ppt/presentation.xml")!.async("string");
  const sz = /<p:sldSz([^/]*)\/>/.exec(pres)![1];
  const cx = +/cx="(\d+)"/.exec(sz)![1];
  const cy = +/cy="(\d+)"/.exec(sz)![1];
  const expW = toEmu(SLIDE_16x9.width), expH = toEmu(SLIDE_16x9.height);
  check(cx === expW && cy === expH, "slide size == 10in x 5.625in (16:9)",
    `got ${cx}x${cy} EMU (${(cx / EMU_PER_INCH).toFixed(4)}x${(cy / EMU_PER_INCH).toFixed(4)} in), expected ${expW}x${expH}; ratio=${(cx / cy).toFixed(6)}`);

  const slideNames = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.replace(/\D/g, "") - +b.replace(/\D/g, ""));
  const slides = await Promise.all(slideNames.map((n) => zip.file(n)!.async("string")));
  check(slides.length === 4 + FONT_CANDIDATES.length, "slide count",
    `${slides.length} slides (4 probes + ${FONT_CANDIDATES.length} font specimens)`);

  // ── slide 1: full-bleed background ──
  const s1 = parseShapes(slides[0]);
  const pics = s1.filter((s) => s.kind === "pic");
  const bg = pics[0];
  const bleedOk = bg?.off?.x === 0 && bg?.off?.y === 0 && bg?.ext?.cx === expW && bg?.ext?.cy === expH;
  check(!!bleedOk, "background image is full-bleed (0,0 → exact slide extent)",
    `off=(${bg?.off?.x},${bg?.off?.y}) ext=(${bg?.ext?.cx},${bg?.ext?.cy})`);
  check(pics.length === 2, "logo image present as second picture", `${pics.length} pictures`);

  // ── zone geometry: every probe zone, EMU-exact ──
  let worstDeltaEmu = 0;
  for (const zone of PROBE_ZONES) {
    const box = zoneToInches(zone);
    const want = { x: toEmu(box.x), y: toEmu(box.y), cx: toEmu(box.w), cy: toEmu(box.h) };
    // match the text shape by its zone-specific content
    const needle: Record<string, string> = {
      title: "Zone-positioned title", subtitle: "Subtitle in a middle",
      bullets: "Point one", sidebar: "right + bottom", centered: "centered footer",
    };
    const sp = s1.find((s) => s.kind === "sp" && s.text.includes(needle[zone.slotKey]));
    if (!sp?.off || !sp.ext) { check(false, `zone ${zone.slotKey}: shape found`, "not found"); continue; }
    const d = [Math.abs(sp.off.x - want.x), Math.abs(sp.off.y - want.y),
               Math.abs(sp.ext.cx - want.cx), Math.abs(sp.ext.cy - want.cy)];
    const maxD = Math.max(...d);
    worstDeltaEmu = Math.max(worstDeltaEmu, maxD);
    check(maxD <= 1, `zone ${zone.slotKey} @ (${zone.x},${zone.y},${zone.w},${zone.h})% → EMU exact`,
      `want ${want.x},${want.y} ${want.cx}x${want.cy}; got ${sp.off.x},${sp.off.y} ${sp.ext.cx}x${sp.ext.cy}; Δmax=${maxD} EMU (${(maxD / EMU_PER_INCH * 25.4).toFixed(5)} mm)`);

    // align / valign
    const algn = /algn="(\w+)"/.exec(sp.xml)?.[1];
    const anchor = /anchor="(\w+)"/.exec(sp.xml)?.[1];
    const wantAlgn = { left: "l", center: "ctr", right: "r" }[zone.align];
    const wantAnchor = { top: "t", middle: "ctr", bottom: "b" }[zone.valign];
    check(algn === wantAlgn, `zone ${zone.slotKey} align=${zone.align}`, `algn="${algn}" (want "${wantAlgn}")`);
    check(anchor === wantAnchor, `zone ${zone.slotKey} valign=${zone.valign}`, `anchor="${anchor}" (want "${wantAnchor}")`);
  }

  // ── text features on slide 1 ──
  const titleSp = s1.find((s) => s.text.includes("Zone-positioned title"))!;
  check(/日本語も確認/.test(titleSp.text), "CJK text round-trips unescaped in <a:t>", titleSp.text.slice(0, 60));
  check(/typeface="Georgia"/.test(titleSp.xml), "fontFace written verbatim (Georgia)",
    (/typeface="[^"]+"/.exec(titleSp.xml) ?? [])[0] ?? "");
  check(/sz="2800"/.test(titleSp.xml), "fontSize 28pt → sz=2800 (hundredths)", (/sz="\d+"/.exec(titleSp.xml) ?? [])[0] ?? "");

  const bulletSp = s1.find((s) => s.text.includes("Point one"))!;
  check(/<a:buChar|<a:buAutoNum/.test(bulletSp.xml), "bullets emit buChar/buAutoNum",
    `buChar=${/<a:buChar/.test(bulletSp.xml)} buAutoNum=${/<a:buAutoNum/.test(bulletSp.xml)}`);
  check(/lvl="1"/.test(bulletSp.xml), "nested bullet indentLevel → lvl=\"1\"");
  check(/<a:normAutofit/.test(bulletSp.xml), "fit:'shrink' → <a:normAutofit>", (/<a:normAutofit[^>]*>/.exec(bulletSp.xml) ?? [])[0] ?? "");

  // ── slide 2: overflow behaviour ──
  const s2 = parseShapes(slides[1]);
  const noFit = s2.find((s) => /<a:spAutoFit|<a:normAutofit/.test(s.xml) === false);
  check(!!noFit, "fit:'none' box has NO autofit element (text will overflow the box)",
    noFit ? "confirmed: no a:normAutofit / a:spAutoFit" : "unexpected autofit present");
  const shrink = s2.find((s) => /<a:normAutofit/.test(s.xml));
  const fontScale = shrink ? /fontScale="(\d+)"/.exec(shrink.xml)?.[1] : undefined;
  check(!!shrink, "fit:'shrink' box has <a:normAutofit>",
    `fontScale attr = ${fontScale ?? "ABSENT — PowerPoint computes on edit only"}`);

  // ── slide 3: token-styled ──
  const s3xml = slides[2];
  check(/<p:bg>/.test(s3xml), "token-styled slide has solid <p:bg> fill", (/<a:srgbClr val="(\w+)"\/>/.exec(s3xml) ?? [])[0] ?? "");
  check(/prstGeom prst="rect"/.test(s3xml), "addShape('rect') accent bar serialized");

  // ── slide 4: letterbox contain math ──
  const s4 = parseShapes(slides[3]).filter((s) => s.kind === "pic")[0];
  const srcAspect = 800 / 600;
  const containW = toEmu(SLIDE_16x9.height * srcAspect);
  const aspectKept = s4 && Math.abs((s4.ext!.cx / s4.ext!.cy) - srcAspect) < 1e-3;
  check(!!aspectKept, "4:3 background placed with source aspect preserved (contain / pillarbox)",
    `ext=${s4?.ext?.cx}x${s4?.ext?.cy} (aspect ${(s4!.ext!.cx / s4!.ext!.cy).toFixed(4)} vs src ${srcAspect.toFixed(4)}), x-offset=${s4?.off?.x} (expected ${Math.round((toEmu(SLIDE_16x9.width) - containW) / 2)})`);

  // ── FONTS registry: pptxName written verbatim ──
  const fontSlides = slides.slice(4);
  const fontReport: Array<{ id: string; pptxName: string; writtenVerbatim: boolean; installedLocally: boolean }> = [];
  const installed = new Set(listInstalledFonts());
  FONT_CANDIDATES.forEach((f, i) => {
    const xml = fontSlides[i] ?? "";
    const verbatim = xml.includes(`typeface="${f.pptxName}"`);
    fontReport.push({ id: f.id, pptxName: f.pptxName, writtenVerbatim: verbatim, installedLocally: installed.has(f.pptxName) });
    check(verbatim, `font "${f.pptxName}" written verbatim into OOXML`,
      verbatim ? `installed on this machine: ${installed.has(f.pptxName)}` : "NOT FOUND in slide XML");
  });

  // notes part
  const notesParts = names.filter((n) => /notesSlide\d+\.xml$/.test(n));
  const notesXml = notesParts.length ? await zip.file(notesParts[0])!.async("string") : "";
  check(/Speaker notes round-trip probe/.test(notesXml), "speakerNotes → notesSlide part", `${notesParts.length} notes part(s)`);

  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(process.cwd(), "out", "assert-results.json"),
    JSON.stringify({ results, fontReport, worstDeltaEmu }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; worst zone delta = ${worstDeltaEmu} EMU`);
  if (failed.length) { console.log("FAILURES:"); failed.forEach((f) => console.log(` - ${f.label}: ${f.detail}`)); process.exit(1); }
}

main().catch((e) => { console.error("ASSERT FAILED:", e); process.exit(1); });
