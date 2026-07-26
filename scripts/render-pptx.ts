/**
 * Renders a .pptx to per-page PNGs so the §1.1 visual gate is repeatable and reviewable
 * without a human in front of PowerPoint: LibreOffice (headless) → PDF → pdfjs raster.
 *
 * LibreOffice is a *second* implementation of the OOXML spec, so agreement between it and
 * our EMU assertions is meaningful independent evidence. It is NOT PowerPoint, though —
 * see VERIFICATION.md for what remains PowerPoint-only.
 *
 * Usage: tsx scripts/render-pptx.ts [pptx=out/OPEN-TEST.pptx] [outDir=out/render] [scale=2]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const SOFFICE_CANDIDATES = [
  "C:/Program Files/LibreOffice/program/soffice.exe",
  "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
  "/usr/bin/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
];

function findSoffice(): string {
  const hit = SOFFICE_CANDIDATES.find(existsSync);
  if (!hit) {
    console.error("LibreOffice not found. Install it, or add its path to SOFFICE_CANDIDATES.");
    process.exit(1);
  }
  return hit;
}

/** `soffice --version` prints nothing on some Windows builds; fall back to the file's own metadata. */
export function sofficeVersion(soffice: string): string {
  const flag = execFileSync(soffice, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
  if (flag) return flag;
  if (process.platform !== "win32") return "LibreOffice (version unknown)";
  const v = execFileSync("powershell",
    ["-NoProfile", "-Command", `(Get-Item '${soffice.replace(/\//g, "\\")}').VersionInfo.ProductVersion`],
    { encoding: "utf8" }).trim();
  return v ? `LibreOffice ${v}` : "LibreOffice (version unknown)";
}

async function main() {
  const pptxPath = process.argv[2] ?? join("out", "OPEN-TEST.pptx");
  const outDir = process.argv[3] ?? join("out", "render");
  const scale = process.argv[4] ?? "2";
  if (!existsSync(pptxPath)) {
    console.error(`${pptxPath} not found — run npm run verify:pptx:opentest first.`);
    process.exit(1);
  }

  const soffice = findSoffice();
  const version = sofficeVersion(soffice);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`renderer: ${version}`);
  execFileSync(soffice,
    ["--headless", "--norestore", "--convert-to", "pdf:impress_pdf_Export", "--outdir", outDir, pptxPath],
    { stdio: "pipe" });

  const pdf = join(outDir, basename(pptxPath).replace(/\.pptx$/i, ".pdf"));
  if (!existsSync(pdf)) { console.error(`conversion produced no PDF at ${pdf}`); process.exit(1); }

  execFileSync("npx", ["tsx", join("scripts", "render-pdf-pages.ts"), pdf, outDir, scale],
    { stdio: "inherit", shell: process.platform === "win32" });
  console.log(`\nInspect ${outDir}/page-*.png against each slide's CONFIRM: line.`);
}

// Only run when invoked directly — sofficeVersion() is imported by verify-font-substitution.ts.
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
