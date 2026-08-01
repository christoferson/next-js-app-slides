/**
 * What each `visualHint` means, described for the MODEL (SPEC §7.1).
 *
 * The outline call has to choose a hint per slide, so it needs to know what the words mean. These
 * descriptions are that vocabulary.
 *
 * ## Why this is not the "parallel table" §4 forbids
 *
 * It would be one if it mapped hints to layouts — that mapping lives in the registry
 * (`layoutsForIntent`) and `lib/mapping/rules.ts` reads it from there. This table maps a hint to a
 * description of the *content shape* it implies, which is genuinely new information the registry does
 * not carry: `layout.description` describes a layout to a *human* picking one in the UI, and no layout
 * description could serve here anyway, since several layouts may claim one hint and a hint may be
 * chosen before any layout exists for it.
 *
 * Two invariants keep it honest, both enforced rather than reviewed:
 *   - `Record<VisualHint, string>` makes the compiler reject a new hint with no description;
 *   - `assertHintCoverage()` (at load) rejects a registry intent with no entry here, which is the
 *     failure that would otherwise leave the model unable to request a layout that exists.
 *
 * Every string below is prompt-bound, so §7 applies verbatim: no colour, font, size, coordinate, or
 * asset reference. `tests/prompt-purity` asserts it over this whole table.
 */

import type { VisualHint } from "@/lib/domain/deck";
import { LAYOUTS } from "@/lib/layouts/registry";

/**
 * Written as *when to choose this*, not as *what it looks like*. "list" says "several parallel
 * points", not "a bulleted slide" — the second would be visual vocabulary and would also be a lie
 * whenever a brand's template renders that layout differently.
 */
export const HINT_DESCRIPTIONS: Record<VisualHint, string> = {
  opening: "The deck's first slide: names the subject and why this audience should care.",
  agenda: "Sets out what the deck will cover, as a short sequence of topics.",
  section: "Marks a transition to a new part of the argument. Carries a heading, little else.",
  list: "Several parallel points that support one message and have no inherent order of importance.",
  comparison: "Two alternatives, states, or time periods set against each other.",
  quote: "A single verbatim statement from a named person or source, standing on its own.",
  metrics: "Two to four numbers that carry the message, each needing a short label.",
  closing: "The deck's last slide: what the audience should do, decide, or remember.",
  detail: "One point developed in prose rather than split into parallel parts.",
};

/** The vocabulary block injected into the outline prompt. Deterministic order — see below. */
export const hintVocabulary = (): string =>
  (Object.keys(HINT_DESCRIPTIONS) as VisualHint[])
    .map((hint) => `- ${hint}: ${HINT_DESCRIPTIONS[hint]}`)
    .join("\n");

/**
 * Object key order is the insertion order above, which makes the block stable across calls and
 * therefore diffable in `DEBUG_PROMPTS` logs. Deliberately not sorted alphabetically: the declared
 * order runs roughly opening → body → closing, which is itself a hint to the model about deck shape.
 */
export const hintOrder = (): VisualHint[] => Object.keys(HINT_DESCRIPTIONS) as VisualHint[];

export const isVisualHint = (value: unknown): value is VisualHint =>
  typeof value === "string" && value in HINT_DESCRIPTIONS;

/* ─────────────────────────────── load-time invariant ─────────────────────────────── */

export function hintCoverageProblems(layouts: readonly { id: string; intents: readonly VisualHint[] }[] = LAYOUTS): string[] {
  const problems: string[] = [];
  for (const layout of layouts) {
    for (const intent of layout.intents) {
      if (!(intent in HINT_DESCRIPTIONS)) {
        problems.push(
          `layout "${layout.id}" claims intent "${intent}", which has no description in `
          + "HINT_DESCRIPTIONS — the outline model would never know to request it.",
        );
      }
    }
  }
  return problems;
}

export function assertHintCoverage(): void {
  const problems = hintCoverageProblems();
  if (problems.length > 0) {
    throw new Error(`Incomplete visual-hint vocabulary:\n  - ${problems.join("\n  - ")}`);
  }
}

assertHintCoverage();
