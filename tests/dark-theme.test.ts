/**
 * Dark mode: the two properties that cannot be left to convention (§8, §12).
 *
 * `app/globals.css` makes two claims about itself in prose. Prose does not fail a build, and both claims
 * have a failure mode that is invisible in the theme you happen to be developing in:
 *
 *  1. **§8 — a slide preview must look identical in both themes.** The preview is a scale model of the
 *     .pptx; its colours come from `DesignTokens` (`compileTheme`), never from the studio palette. One
 *     well-meaning `dark:text-ink` added to a `FallbackRenderer` months from now would make the preview
 *     show something the export does not contain — the exact preview/export divergence §8 exists to
 *     prevent, and it would look *better*, not broken, to whoever added it.
 *  2. **§12 — the palette meets the bar the app enforces on brands.** `compileTheme` repairs any brand
 *     pairing below AA. Studio chrome that failed that same check would be the tool not eating its own
 *     cooking, and the amber quality badge is the pair that matters most: §12 says a flag may never be
 *     suppressed, and an illegible badge is suppression by another name.
 *
 * Both are checked here against the project's OWN `contrastRatio` — not a second implementation of WCAG,
 * which could drift from the one that decides brands' fate.
 *
 * This is a node-environment test (there is no jsdom in this repo, deliberately): it reads the CSS and the
 * component sources as text and runs the pure contrast functions. It therefore proves things about the
 * declared palette and the source, not about a rendered browser — the visual check is recorded in
 * VERIFICATION.md instead.
 */

import { describe, expect, it } from "vitest";
import { readFile, glob } from "node:fs/promises";
import path from "node:path";
import { AA_NORMAL, contrastRatio, parseHex } from "@/lib/brand/contrast";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): Promise<string> => readFile(path.join(ROOT, rel), "utf8");

/** Read once at module scope: vitest supports top-level await, and every check below is a text assertion. */
const CSS = await read("app/globals.css");
const THEME_TSX = await read("components/theme.tsx");

/* ─────────────────────────── parsing the declared palette ─────────────────────────── */

/** Comments are stripped first: they contain hex literals in prose, which would parse as tokens. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The body of the rule whose selector matches `opener`, matched by counting braces rather than reading to
 * the first `}` — so a nested rule added later cannot silently truncate the block and make the checks
 * vacuous.
 *
 * `opener` is a regex, not a string, because a substring search for `.dark` finds it inside
 * `@custom-variant dark (&:where(.dark, .dark *))` first and then takes the NEXT `{` — which is `@theme`'s.
 * That is not hypothetical: it is what this function did on its first run, and the dark palette silently
 * parsed as a second copy of the light one. Every AA assertion below passed, against the wrong colours.
 * Anchoring on `^\.dark\s*\{` (multiline) requires a real rule at the start of a line.
 */
function blockBody(css: string, opener: RegExp): string {
  const start = css.search(opener);
  expect(start, `\`${opener}\` block missing from app/globals.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after \`${opener}\``);
}

const colorTokens = (body: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1] as string] = m[2] as string;
  }
  return out;
};

const bare = stripComments(CSS);
const LIGHT = colorTokens(blockBody(bare, /^@theme\s*\{/m));
const DARK = colorTokens(blockBody(bare, /^\.dark\s*\{/m));

/* ─────────────────────────── the pairs the chrome actually paints ─────────────────────────── */

/**
 * Every foreground/background pairing the studio chrome puts on screen, with the WCAG threshold that
 * applies to it. Derived from `components/ui/primitives.tsx` — each entry names the variant it comes from,
 * because a pair that exists in CSS but is never painted would be a check with no user behind it.
 *
 * Every entry uses `AA_NORMAL`: no chrome text in this app is large by WCAG's definition (≥18pt, or ≥14pt
 * bold), so the 4.5:1 threshold is the only one that applies. Non-text pairs (borders) are deliberately
 * absent — see the border check below for why they are not held to a text threshold.
 */
const TEXT_PAIRS: ReadonlyArray<{ fg: string; bg: string; threshold: number; where: string }> = [
  { fg: "ink", bg: "canvas", threshold: AA_NORMAL, where: "body text on the page" },
  { fg: "ink", bg: "surface", threshold: AA_NORMAL, where: "text on a Card" },
  { fg: "ink-soft", bg: "canvas", threshold: AA_NORMAL, where: "Field label, ghost Button" },
  { fg: "ink-soft", bg: "surface", threshold: AA_NORMAL, where: "hint text inside a Card" },
  // The primary Button. `text-canvas` on `bg-ink` rather than `text-white`: see BUTTON_VARIANT's comment.
  { fg: "canvas", bg: "ink", threshold: AA_NORMAL, where: "primary Button label" },
  // Hover swaps the FILL to `ink-soft` and leaves the label `text-canvas`, so this is the pair — the
  // hover state is where a "passing" button most often stops passing, since only the background moved.
  { fg: "canvas", bg: "ink-soft", threshold: AA_NORMAL, where: "primary Button label, hovered" },
  // Same shape for the two variants whose hover fills a previously-transparent background.
  { fg: "ink", bg: "canvas", threshold: AA_NORMAL, where: "secondary/ghost Button, hovered" },
  { fg: "danger", bg: "danger-bg", threshold: AA_NORMAL, where: "danger Button label, hovered" },
  // §12: the quality badge. The pair that may never become unreadable.
  { fg: "flag", bg: "flag-bg", threshold: AA_NORMAL, where: "amber quality badge (§12)" },
  { fg: "danger", bg: "danger-bg", threshold: AA_NORMAL, where: "ErrorNote body" },
  { fg: "danger", bg: "surface", threshold: AA_NORMAL, where: "danger Button label" },
];

const ratio = (palette: Record<string, string>, fg: string, bg: string): number => {
  const a = parseHex(palette[fg] ?? "");
  const b = parseHex(palette[bg] ?? "");
  expect(a, `--color-${fg} missing or unparseable`).not.toBeNull();
  expect(b, `--color-${bg} missing or unparseable`).not.toBeNull();
  return contrastRatio(a as NonNullable<typeof a>, b as NonNullable<typeof b>);
};

/* ─────────────────────────── the tests ─────────────────────────── */

describe("dark theme — the palette", () => {
  it("parses both palettes out of globals.css", () => {
    // A parser that matched nothing would make every assertion below vacuously green. Anchor it.
    expect(Object.keys(LIGHT).length).toBeGreaterThan(5);
    expect(LIGHT.ink).toBe("#14141b");
    expect(DARK.ink).toBe("#ececf1");
  });

  /**
   * The whole mechanism, in one line of CSS.
   *
   * Tailwind v4's `dark:` compiles to a `prefers-color-scheme` media query by default and emits no `.dark`
   * selector at all (VERIFIED in `out/probe-dark-variant/`). `next-themes` is mounted with
   * `attribute="class"`, so without this declaration the toggle would be completely inert — it would set a
   * class nothing selects on. The two settings are one mechanism; this asserts they stay together.
   */
  it("declares the class-based dark variant that next-themes' attribute=\"class\" needs", () => {
    expect(bare).toMatch(/@custom-variant\s+dark\s+\(&:where\(\.dark,\s*\.dark\s+\*\)\)/);
    expect(THEME_TSX).toMatch(/attribute="class"/);
  });

  /** A token present in one palette and not the other keeps its light value under `.dark` — a stuck colour. */
  it("overrides every light token in the dark palette, and introduces none", () => {
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
  });

  it.each(TEXT_PAIRS)(
    "light: $fg on $bg meets AA ($where)",
    ({ fg, bg, threshold }) => {
      expect(ratio(LIGHT, fg, bg)).toBeGreaterThanOrEqual(threshold);
    },
  );

  it.each(TEXT_PAIRS)(
    "dark: $fg on $bg meets AA ($where)",
    ({ fg, bg, threshold }) => {
      expect(ratio(DARK, fg, bg)).toBeGreaterThanOrEqual(threshold);
    },
  );

  /**
   * Borders are held to PARITY, not to a fixed floor.
   *
   * The first version of this check asserted a 1.5:1 non-text minimum — and the already-shipped LIGHT
   * palette failed it at 1.28:1. That was an acceptance bar invented here, not a defect in the design: a
   * barely-there hairline is a deliberate choice, and WCAG's 3:1 non-text minimum applies to controls that
   * convey state, not to decorative separators between stacked cards.
   *
   * What actually matters is that the dark palette does not lose the separation the light one has. So the
   * bar is comparative, with a 10% tolerance: a card must read as a distinct surface in both themes.
   */
  it("keeps card borders as visible in dark as in light", () => {
    const light = ratio(LIGHT, "line", "surface");
    const dark = ratio(DARK, "line", "surface");
    expect(dark).toBeGreaterThanOrEqual(light * 0.9);
  });

  /** A card must read as RAISED off the page in both themes, so the two must differ at all. */
  it("keeps surface distinguishable from canvas", () => {
    expect(LIGHT.surface).not.toBe(LIGHT.canvas);
    expect(DARK.surface).not.toBe(DARK.canvas);
  });

  /**
   * Native widgets (scrollbars, the brand editor's file input) follow `color-scheme`, not our variables.
   * `next-themes` maintains it via `enableColorScheme`; these declarations are the no-JS fallback and must
   * agree with the class, or a themed page keeps light scrollbars against a dark canvas.
   */
  it("declares color-scheme for both themes as the no-JS fallback", () => {
    expect(bare).toMatch(/html\s*\{[^}]*color-scheme:\s*light/);
    expect(bare).toMatch(/html\.dark\s*\{[^}]*color-scheme:\s*dark/);
    // …and the provider maintains it at runtime, which is what themes widgets once JS is up.
    expect(THEME_TSX).toMatch(/enableColorScheme/);
  });
});

/* ─────────────────────────── the §8 hazard ─────────────────────────── */

describe("dark theme — §8: a slide preview must render identically in both themes", () => {
  /**
   * Every file that paints slide content: the shared preview primitives, the shared painter, and each
   * layout's `FallbackRenderer`.
   *
   * `components/preview/slide-preview.tsx` is deliberately NOT in this set. Its one Tailwind-coloured
   * element is the unknown-layout placeholder, which returns *before* `SlideFrame` and is therefore studio
   * chrome standing in for a slide, not a slide — it should follow the theme. Everything rendered inside
   * `SlideFrame` comes from this set.
   */
  async function previewSources(): Promise<Array<{ rel: string; source: string }>> {
    const rels: string[] = [];
    for await (const entry of glob("lib/layouts/**/*.{ts,tsx}", { cwd: ROOT })) {
      rels.push((entry as string).split(path.sep).join("/"));
    }
    return Promise.all(rels.map(async (rel) => ({ rel, source: await read(rel) })));
  }

  it("scans the layout render path", async () => {
    const files = (await previewSources()).map((f) => f.rel);
    // Anchored on files that must exist, so a glob that stopped matching fails loudly.
    expect(files).toContain("lib/layouts/preview.tsx");
    expect(files).toContain("lib/layouts/paint.tsx");
    expect(files).toContain("lib/layouts/defs/title.tsx");
    // One per seed layout plus `checklist`; the count is derived, not frozen (§10).
    expect(files.filter((f) => f.startsWith("lib/layouts/defs/")).length).toBeGreaterThanOrEqual(9);
  });

  it("uses no Tailwind class at all in the layout render path", async () => {
    const offenders: string[] = [];
    for (const { rel, source } of await previewSources()) {
      // `className` is the entry point for EVERY Tailwind utility, so forbidding the prop is stricter and
      // more durable than enumerating colour utilities — a slide styles exclusively from inline
      // `DesignTokens`, and there is no legitimate reason for one of these files to carry a class.
      if (/className\s*[=:]/.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("uses no dark: variant anywhere in the layout render path", async () => {
    const offenders: string[] = [];
    for (const { rel, source } of await previewSources()) {
      if (/\bdark:/.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The positive control for the two checks above: they must actually match the thing they forbid.
   * Without this, "no offenders" could mean "the patterns match nothing at all".
   */
  it("has detectors that fire", () => {
    expect(/className\s*[=:]/.test('<div className="p-2" />')).toBe(true);
    expect(/className\s*[=:]/.test("{ className: cn(x) }")).toBe(true);
    expect(/className\s*[=:]/.test('<div style={{ color: "#fff" }} />')).toBe(false);
    expect(/\bdark:/.test('className="dark:bg-black"')).toBe(true);
    expect(/\bdark:/.test("const darker = 1;")).toBe(false);
  });

  /**
   * The colours a slide DOES use come from `DesignTokens`, which is compiled from the brand — so the
   * preview's appearance is a function of the brand alone, and the studio palette cannot reach it. This
   * asserts the shape rather than the values: the primitives take `tokens` and paint from them inline.
   */
  it("drives slide colour from DesignTokens through inline style only", async () => {
    const preview = await read("lib/layouts/preview.tsx");
    expect(preview).toMatch(/color:\s*`#\$\{style\.color\}`/);
    expect(preview).toMatch(/backgroundColor:\s*`#\$\{tokens\.colors\.background\}`/);
    // And no studio token names leak in — `var(--color-…)` would tie a slide to the chrome palette.
    expect(preview).not.toMatch(/var\(--color-/);
  });
});
