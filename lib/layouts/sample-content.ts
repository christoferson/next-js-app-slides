/**
 * Placeholder slot content, derived from a layout's own `SlotSpec[]`.
 *
 * ## What it is for
 *
 * The brand editor previews a layout with no deck behind it: the user is positioning zones, not writing
 * slides. Something has to be in the boxes or there is nothing to position, and that something has to
 * come from the registry — a table of `{ title: "Your title here", bullets: [...] }` keyed by slot name
 * would be exactly the parallel table §4 forbids, and §10's one-file-layout proof would fail on it (a new
 * layout's zones would preview empty until someone remembered to edit this file).
 *
 * So the text is generated from what a `SlotSpec` already declares: its key, its type, and its budgets.
 * A new layout gets sensible placeholders for free, and a changed budget changes them.
 *
 * ## Why it fills most of the budget rather than a little
 *
 * `FILL_RATIO` puts the text at ~70% of `maxChars`. A three-word placeholder in a zone sized for 50
 * characters tells the user nothing about whether their zone is big enough, and §1.1/C1 is the reason
 * that matters: nothing shrinks text to fit, so a zone that is slightly too small does not degrade
 * gracefully — it clips. Filling most of the budget makes the preview show the case the export will
 * actually have to survive.
 *
 * It deliberately does NOT fill to 100%. That is `scripts/export-fixture-deck.ts`'s job — it exists to
 * make the worst case visible in a real PPTX — whereas this is a working surface the user reads while
 * dragging numbers around, and text pinned to the last character of its budget reads as broken.
 *
 * Pure, dependency-free, and client-importable: this runs in the brand editor, in the browser.
 */

import type { SlotValues, SlotValue } from "@/lib/domain/slots";
import type { SlotSpec } from "@/lib/layouts/types";

/** Fraction of each budget the placeholder text occupies. See the header for why it is not 1. */
const FILL_RATIO = 0.7;

/**
 * Filler words. Ordinary English rather than lorem ipsum, because the user is judging whether a real
 * sentence fits a real box, and Latin's word lengths are not English's.
 */
const WORDS = [
  "placeholder", "text", "shows", "how", "much", "room", "this", "zone", "gives", "you",
  "before", "the", "words", "run", "past", "its", "edge",
];

/**
 * `"sectionHeading"` → `"Section heading"`.
 *
 * The slot key is the only human-meaningful thing a spec carries that is short enough to lead with —
 * `description` is a prompt instruction, often two sentences, and would read as nonsense on a slide.
 */
export function humanizeSlotKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * `lead`, then filler words until `budget` is reached — cut at a WORD boundary, never mid-word.
 *
 * Word-boundary truncation matches what the server's own budget enforcement does (§9's `trimmed` row),
 * so the placeholder cannot show the user a hard mid-word cut the real pipeline would never produce.
 */
function fill(lead: string, budget: number): string {
  const target = Math.max(1, Math.floor(budget * FILL_RATIO));
  if (lead.length >= target) {
    const cut = lead.slice(0, target);
    const lastSpace = cut.lastIndexOf(" ");
    return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  }

  let text = lead;
  for (let i = 0; text.length < target; i += 1) {
    // `%` cycles the word list, so an unusually generous budget keeps producing words instead of
    // running off the end of the array and appending "undefined".
    const next = ` ${WORDS[i % WORDS.length]!}`;
    if (text.length + next.length > target) break;
    text += next;
  }
  return text;
}

/**
 * Placeholder values for every slot a layout declares — optional ones included.
 *
 * Optional slots are filled deliberately: an optional slot's zone is still a zone the user has to
 * position, and leaving it empty would make it invisible in the very screen where they are positioning
 * it. `paintPreview` skips absent slots, so an unfilled optional slot is not a placeholder — it is a
 * missing box.
 */
export function sampleSlots(specs: readonly SlotSpec[]): SlotValues {
  const out: Record<string, SlotValue> = {};
  for (const spec of specs) {
    const label = humanizeSlotKey(spec.key);
    if (spec.type === "list") {
      const count = spec.maxItems ?? 3;
      const budget = spec.itemMaxChars ?? spec.maxChars;
      out[spec.key] = Array.from({ length: count }, (_, i) => fill(`${label} ${i + 1} —`, budget));
      continue;
    }
    out[spec.key] = fill(label, spec.maxChars);
  }
  return out;
}
