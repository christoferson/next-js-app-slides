/**
 * The FONTS registry — RATIFIED 2026-07-28 (product decision by the user).
 *
 * Every `pptxName` here was measured, not assumed. `scripts/verify-font-substitution.ts` renders
 * one slide per candidate through LibreOffice and reads the `/BaseFont` descriptors embedded in
 * the resulting PDF — the renderer names the *resolved, post-substitution* face, so substitution
 * is stated by the renderer rather than inferred. Result: 15 of 16 candidates honoured.
 *
 * The ratified decision (VERIFICATION.md §1.1 "Fonts"):
 *  - **`aptos` is DROPPED.** It was the one measured substitution (→ ArialUnicodeMS). It is an
 *    Office 2024 default, so it is missing on older Office, LibreOffice, and Google Slides.
 *    Per CLAUDE.md §14, a FONTS entry with no `pptxName` that survives the open-test does not ship.
 *  - **The 7 `core` faces are SELECTABLE.** They have shipped with both Windows and Mac Office for
 *    roughly two decades and are the least likely to surprise.
 *  - **`office` and `segoe_ui` are GATED** behind the deferred desktop-PowerPoint open-test
 *    (⚠️ VERIFY #1). They render correctly here, but "renders on this Windows box" is not the same
 *    claim as "renders on Mac Office", and that gap is exactly what the open-test closes.
 *
 * Why gated entries stay in the registry instead of being deleted: a brand may already reference
 * one, and `resolveFont` must keep resolving it. `selectableFonts()` is what the UI offers. Gating
 * is therefore a *picker* policy, not a data migration — and ungating after the open-test is a
 * one-word change per entry.
 *
 * ⚠️ pptxgenjs writes `fontFace` verbatim and cannot embed fonts (§1.1/C4), so a substituted font
 * is UNDETECTABLE at export time. Restricting this registry is the only real mitigation.
 */

export type FontTier = "core" | "office" | "risky";

/** `ratified` = offered in the UI. `gated` = resolvable, but not offered until the open-test runs. */
export type FontStatus = "ratified" | "gated";

export type FontRole = "heading" | "body" | "both";

export interface FontDescriptor {
  id: string;
  /** EXACT PowerPoint font name written into the OOXML. Verified to render, never guessed. */
  pptxName: string;
  /** Browser-preview stack; must visually approximate `pptxName` so preview ≈ export (§8). */
  webStack: string;
  displayName: string;
  tier: FontTier;
  status: FontStatus;
  role: FontRole;
  /** Shown next to gated entries so the risk is visible rather than buried in a doc. */
  note?: string;
}

export const FONTS: readonly FontDescriptor[] = [
  /* ── core: shipped with Windows AND macOS Office for ~two decades. Selectable. ── */
  { id: "arial", pptxName: "Arial", displayName: "Arial",
    webStack: "Arial, Helvetica, sans-serif", tier: "core", status: "ratified", role: "both" },
  { id: "georgia", pptxName: "Georgia", displayName: "Georgia",
    webStack: "Georgia, 'Times New Roman', serif", tier: "core", status: "ratified", role: "heading" },
  { id: "verdana", pptxName: "Verdana", displayName: "Verdana",
    webStack: "Verdana, Geneva, sans-serif", tier: "core", status: "ratified", role: "body" },
  { id: "tahoma", pptxName: "Tahoma", displayName: "Tahoma",
    webStack: "Tahoma, Geneva, sans-serif", tier: "core", status: "ratified", role: "body" },
  { id: "times_new_roman", pptxName: "Times New Roman", displayName: "Times New Roman",
    webStack: "'Times New Roman', Times, serif", tier: "core", status: "ratified", role: "heading" },
  { id: "trebuchet", pptxName: "Trebuchet MS", displayName: "Trebuchet MS",
    webStack: "'Trebuchet MS', sans-serif", tier: "core", status: "ratified", role: "both" },
  { id: "courier_new", pptxName: "Courier New", displayName: "Courier New",
    webStack: "'Courier New', monospace", tier: "core", status: "ratified", role: "body" },

  /* ── office: honoured on this Windows install; unverified on Mac Office. Gated. ── */
  { id: "calibri", pptxName: "Calibri", displayName: "Calibri",
    webStack: "Calibri, 'Segoe UI', sans-serif", tier: "office", status: "gated", role: "both",
    note: "Bundled with Office. Verified on Windows; awaiting the desktop PowerPoint open-test." },
  { id: "cambria", pptxName: "Cambria", displayName: "Cambria",
    webStack: "Cambria, Georgia, serif", tier: "office", status: "gated", role: "heading",
    note: "Bundled with Office. Verified on Windows; awaiting the desktop PowerPoint open-test." },
  { id: "candara", pptxName: "Candara", displayName: "Candara",
    webStack: "Candara, Optima, sans-serif", tier: "office", status: "gated", role: "both",
    note: "Bundled with Office. Verified on Windows; awaiting the desktop PowerPoint open-test." },
  { id: "constantia", pptxName: "Constantia", displayName: "Constantia",
    webStack: "Constantia, Georgia, serif", tier: "office", status: "gated", role: "heading",
    note: "Bundled with Office. Verified on Windows; awaiting the desktop PowerPoint open-test." },
  { id: "corbel", pptxName: "Corbel", displayName: "Corbel",
    webStack: "Corbel, 'Lucida Grande', sans-serif", tier: "office", status: "gated", role: "body",
    note: "Bundled with Office. Verified on Windows; awaiting the desktop PowerPoint open-test." },
  { id: "franklin_gothic", pptxName: "Franklin Gothic Book", displayName: "Franklin Gothic Book",
    webStack: "'Franklin Gothic Book', 'Arial Narrow', sans-serif", tier: "office", status: "gated",
    role: "heading",
    note: "Bundled with Office. Verified on Windows; awaiting the desktop PowerPoint open-test." },
  { id: "garamond", pptxName: "Garamond", displayName: "Garamond",
    webStack: "Garamond, Georgia, serif", tier: "office", status: "gated", role: "heading",
    note: "Bundled with Office. Verified on Windows; awaiting the desktop PowerPoint open-test." },

  /* ── risky: Windows-only. Gated, and expected to substitute on macOS. ── */
  { id: "segoe_ui", pptxName: "Segoe UI", displayName: "Segoe UI",
    webStack: "'Segoe UI', system-ui, sans-serif", tier: "risky", status: "gated", role: "both",
    note: "Windows-only. Expect substitution on macOS PowerPoint." },

  // `aptos` deliberately absent — the one MEASURED substitution (→ ArialUnicodeMS). Do not re-add
  // without a passing open-test on the target Office version.
];

const BY_ID: ReadonlyMap<string, FontDescriptor> = new Map(FONTS.map((f) => [f.id, f]));

/** `undefined` for an unknown id — callers decide whether that is an error or a fallback. */
export const resolveFont = (id: string): FontDescriptor | undefined => BY_ID.get(id);

export const isKnownFontId = (id: string): boolean => BY_ID.has(id);

/** What the brand editor offers. Gated entries resolve but are not selectable (see header). */
export const selectableFonts = (): readonly FontDescriptor[] => FONTS.filter((f) => f.status === "ratified");

/** Safe defaults for a new brand — both `core`, so both are open-test-safe. */
export const DEFAULT_HEADING_FONT_ID = "georgia";
export const DEFAULT_BODY_FONT_ID = "verdana";
