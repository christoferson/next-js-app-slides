/**
 * Candidate FONTS registry for the §1.1 open-test. SPEC.md requires a "curated
 * registry with PPTX-safe mappings" but does not enumerate it — this is the
 * proposed set, each entry gated on surviving the PowerPoint open-test.
 *
 * `webStack` = browser preview (must visually approximate pptxName).
 * `pptxName` = exact PowerPoint font name written into the OOXML.
 */
export interface FontCandidate {
  id: string;
  pptxName: string;
  webStack: string;
  /** Shipped with Office/Windows AND macOS Office? Drives substitution risk. */
  expect: "core" | "office" | "risky";
  role: "heading" | "body" | "both";
}

export const FONT_CANDIDATES: FontCandidate[] = [
  // Core web/Office fonts — present on Windows + macOS Office installs.
  { id: "arial",           pptxName: "Arial",             webStack: "Arial, Helvetica, sans-serif",      expect: "core",   role: "both" },
  { id: "georgia",         pptxName: "Georgia",           webStack: "Georgia, 'Times New Roman', serif", expect: "core",   role: "heading" },
  { id: "verdana",         pptxName: "Verdana",           webStack: "Verdana, Geneva, sans-serif",       expect: "core",   role: "body" },
  { id: "tahoma",          pptxName: "Tahoma",            webStack: "Tahoma, Geneva, sans-serif",        expect: "core",   role: "body" },
  { id: "times_new_roman", pptxName: "Times New Roman",   webStack: "'Times New Roman', Times, serif",   expect: "core",   role: "heading" },
  { id: "trebuchet",       pptxName: "Trebuchet MS",      webStack: "'Trebuchet MS', sans-serif",        expect: "core",   role: "both" },
  { id: "courier_new",     pptxName: "Courier New",       webStack: "'Courier New', monospace",          expect: "core",   role: "body" },
  // Office-bundled (ClearType) — on Windows Office + Mac Office, not bare macOS.
  { id: "calibri",         pptxName: "Calibri",           webStack: "Calibri, 'Segoe UI', sans-serif",   expect: "office", role: "both" },
  { id: "cambria",         pptxName: "Cambria",           webStack: "Cambria, Georgia, serif",           expect: "office", role: "heading" },
  { id: "candara",         pptxName: "Candara",           webStack: "Candara, Optima, sans-serif",       expect: "office", role: "both" },
  { id: "constantia",      pptxName: "Constantia",        webStack: "Constantia, Georgia, serif",        expect: "office", role: "heading" },
  { id: "corbel",          pptxName: "Corbel",            webStack: "Corbel, 'Lucida Grande', sans-serif", expect: "office", role: "body" },
  { id: "franklin_gothic", pptxName: "Franklin Gothic Book", webStack: "'Franklin Gothic Book', 'Arial Narrow', sans-serif", expect: "office", role: "heading" },
  { id: "garamond",        pptxName: "Garamond",          webStack: "Garamond, Georgia, serif",          expect: "office", role: "heading" },
  // Windows-only / newer — substitution risk on macOS PowerPoint.
  { id: "segoe_ui",        pptxName: "Segoe UI",          webStack: "'Segoe UI', system-ui, sans-serif", expect: "risky",  role: "both" },
  { id: "aptos",           pptxName: "Aptos",             webStack: "Aptos, 'Segoe UI', sans-serif",     expect: "risky",  role: "both" },
];
