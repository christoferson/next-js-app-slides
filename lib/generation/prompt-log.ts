/**
 * `DEBUG_PROMPTS=1` (CLAUDE.md §7: "Add a `DEBUG_PROMPTS=1` mode that logs final prompts — the
 * acceptance criterion says 'verifiable in debug logs'; make that real").
 *
 * ## Why the purity scan lives here rather than only in the test
 *
 * §7's acceptance test builds prompts from a loud fixture and asserts nothing brand-visual appears. That
 * catches every leak the *fixture* provokes — which is every leak reachable from the seed layouts and
 * the seed registries. What it cannot catch is a leak reachable only from a brand shape the fixture does
 * not have: a tone id someone adds later whose `promptFragment` mentions a colour, a layout whose slot
 * `description` says "the large centred title". Those pass CI and leak in production.
 *
 * So the same rule runs twice: `promptImpurities` is the shared predicate, asserted over fixtures by
 * `tests/prompt-purity.test.ts` and re-checked at runtime on every prompt when `DEBUG_PROMPTS=1`. The
 * scanner is not a security control — it is a tripwire on the guarantee, positioned where a developer
 * adding a registry entry will trip it.
 *
 * Off by default and never on in production request paths: the scan walks the FONTS registry per prompt,
 * and the log would contain the user's briefing text.
 */

import { FONTS } from "@/lib/brand/fonts";

/** One suspected leak. `match` is the offending substring, for a log line that says what to fix. */
export interface PromptImpurity {
  kind: "hex-color" | "font-name" | "coordinate" | "asset-reference";
  match: string;
}

/**
 * §7's four forbidden categories, as one regex each where possible.
 *
 * Deliberately conservative about false positives in only one direction: a *user's own* briefing can
 * legitimately contain "#FF0000" (a deck about brand guidelines, say) and will be flagged. That is
 * acceptable for a debug-mode log line and unacceptable for a build gate — which is why the test asserts
 * over prompts built from a fixture whose free text contains none of these, rather than over arbitrary
 * input.
 */
const PATTERNS: readonly { kind: PromptImpurity["kind"]; re: RegExp }[] = [
  // §7 verbatim: "any hex pattern `#[0-9a-fA-F]{3,8}`".
  { kind: "hex-color", re: /#[0-9a-fA-F]{3,8}\b/g },

  // Zone/coordinate vocabulary: `x:42`, `x = 42`, `"y": 12`, `w:84%`. Bare numbers are NOT matched —
  // slot budgets are numbers and are supposed to be there.
  { kind: "coordinate", re: /"?\b[xywh]"?\s*[:=]\s*-?\d/g },

  // Also coordinates, spelled out. `valign`/`align` are zone fields; a prompt has no business naming
  // either, and `defaultZones` leaking as prose would read exactly like this.
  { kind: "coordinate", re: /\b(?:defaultZones|slotZone|valign|zone(?:s)?\s*(?:at|of|:))\b/gi },

  // An asset id or filename. Ids are `asset-…` by construction; the extensions cover a raw filename
  // reaching a prompt through a template or a logo field.
  { kind: "asset-reference", re: /\basset[-_][A-Za-z0-9][\w-]*|\b[\w-]+\.(?:png|jpe?g|webp|svg|gif)\b/gi },
];

/**
 * Every FONTS identifier, longest first.
 *
 * All three fields are checked — `id`, `pptxName`, `displayName` — because a leak could arrive through
 * any of them: the id via a brand config echoed into a prompt, the `pptxName` via a theme token, the
 * `displayName` via a UI string reused server-side. Longest-first so "Times New Roman" reports as itself
 * rather than as a partial.
 */
const FONT_TERMS: readonly string[] = [...new Set(
  FONTS.flatMap((f) => [f.id, f.pptxName, f.displayName]),
)].sort((a, b) => b.length - a.length);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Word-bounded so `arial` does not match inside an unrelated word. Underscore-separated ids
 * (`times_new_roman`) need `\b` at both ends too, which works because `_` is a word character on the
 * inside and the surrounding characters are not.
 */
const FONT_RE = new RegExp(`\\b(?:${FONT_TERMS.map(escapeRe).join("|")})\\b`, "gi");

/**
 * Scan one final prompt string. Empty array ⇒ clean.
 *
 * Returns findings rather than throwing: at runtime this is diagnostic, and a false positive from a
 * user's own briefing must never fail their generation. The test is what turns it into a gate.
 */
export function promptImpurities(prompt: string): PromptImpurity[] {
  const found: PromptImpurity[] = [];

  for (const { kind, re } of PATTERNS) {
    for (const match of prompt.matchAll(re)) found.push({ kind, match: match[0] });
  }
  for (const match of prompt.matchAll(FONT_RE)) found.push({ kind: "font-name", match: match[0] });

  return found;
}

export const describeImpurities = (impurities: readonly PromptImpurity[]): string =>
  impurities.map((i) => `${i.kind}:"${i.match}"`).join(", ");

/* ─────────────────────────────── the logger ─────────────────────────────── */

export interface PromptLogger {
  (label: string, prompt: string): void;
}

/** No-op when debugging is off, so call sites need no `if` and the hot path costs one call. */
const NOOP: PromptLogger = () => { /* deliberately empty */ };

/**
 * Build the `onPrompt` hook the pipelines take.
 *
 * `sink` is injectable so a test can assert what would be logged without capturing `console`. Default
 * `console.info`: this is developer-facing diagnostic output, not an application error, and routing it
 * through the error channel would make a debug flag look like a fault in the logs.
 */
export function createPromptLogger(
  enabled: boolean,
  sink: (line: string) => void = (line) => { console.info(line); },
): PromptLogger {
  if (!enabled) return NOOP;

  return (label, prompt) => {
    const impurities = promptImpurities(prompt);

    // The banner states the §7 verdict FIRST. The whole point of this mode is that someone can look at
    // one log line and know whether the guarantee held — having to read a 2 KB prompt to find out would
    // defeat it.
    sink(impurities.length === 0
      ? `[DEBUG_PROMPTS] ${label}: clean (${prompt.length} chars)`
      : `[DEBUG_PROMPTS] ${label}: ⚠️ POSSIBLE BRAND LEAK — ${describeImpurities(impurities)}`);
    sink(prompt);
  };
}
