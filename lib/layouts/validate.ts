/**
 * `SlotSpec[]` → zod, plus the budget/truncation pass (CLAUDE.md §2 step 8, SPEC §6).
 *
 * Two passes, deliberately separate, because they answer different questions:
 *
 *  1. **`validateSlots`** — *is this usable at all?* Required slots present, right kinds of value.
 *     A failure here feeds its zod issues back into the single repair pass (§9), so the messages are
 *     written to be useful to a *model*, not to a person.
 *  2. **`normalizeSlots`** — *make it fit.* Truncate at word boundaries, cap list lengths, drop
 *     hallucinated slots, and report a `trimmed` flag. This can never fail.
 *
 * Why over-budget text is NOT a validation error: §9's matrix requires "valid JSON, one field over
 * budget → truncated at word boundary + `trimmed` flag". Spending the one repair call on something
 * we can fix deterministically would waste it — repair is for content that is genuinely unusable.
 *
 * And why truncation exists at all: §1.1/C1. `fit:'shrink'` emits a scale-less `<a:normAutofit/>`
 * that **no renderer honours** — verified in LibreOffice and by the user in PowerPoint on the web.
 * Over-long text either spills across neighbouring zones or is silently clipped. So `maxChars` is
 * the only guard there is, which makes this file load-bearing rather than cosmetic.
 */

import { z } from "zod";
import type { QualityFlag } from "@/lib/stream/events";
import type { SlotValue, SlotValues } from "@/lib/domain/slots";
import type { SlideLayout, SlotSpec } from "@/lib/layouts/types";

/** SPEC §6 — every slide carries speaker notes, capped. */
export const SPEAKER_NOTES_MAX_CHARS = 600;

/* ─────────────────────────────── truncation ─────────────────────────────── */

const ELLIPSIS = "…";

/**
 * Cut to `maxChars`, preferring a word boundary, and mark the cut with an ellipsis.
 *
 * The ellipsis is inside the budget, not added to it. It is there because the exported deck is the
 * artifact the audience sees and there is no amber badge in PowerPoint: a hard cut mid-word reads as
 * a bug, whereas "…" reads as deliberate abridgement.
 *
 * A word boundary is only used when it keeps ≥60% of the budget — otherwise a single very long token
 * (a URL, a compound German noun, CJK text with no spaces) would collapse the field to almost
 * nothing, which loses more meaning than a mid-word cut does.
 */
export function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= ELLIPSIS.length) return text.slice(0, maxChars);

  const budget = maxChars - ELLIPSIS.length;
  const hardCut = text.slice(0, budget);
  const lastSpace = hardCut.search(/\s+\S*$/);
  const keep = lastSpace >= Math.floor(budget * 0.6) ? hardCut.slice(0, lastSpace) : hardCut;

  return `${keep.replace(/[\s,;:.\-–—]+$/, "")}${ELLIPSIS}`;
}

/* ─────────────────────────────── normalization ─────────────────────────────── */

/** What was changed and why — logged, and surfaced in the UI via `flags` (§12). */
export interface SlotAdjustment {
  slotKey: string;
  kind: "truncated" | "items-dropped" | "item-truncated" | "unknown-slot-dropped" | "empty-dropped";
  detail?: string;
}

export interface NormalizeResult {
  slots: SlotValues;
  /** At most `["trimmed"]` — flags are a set, not a tally; `adjustments` carries the specifics. */
  flags: QualityFlag[];
  adjustments: SlotAdjustment[];
}

/**
 * Coerce whatever is actually stored into the shape a slot expects.
 *
 * `normalizeSlots` promises never to throw, and it is reachable with values that never passed
 * `compileSlotSchema`: slides persisted by an earlier build, a hand-edited JSON import, a repair
 * response applied without re-validation. A `.trim()` on a number is a 500 on the render path, so the
 * coercion is total. Anything with no sensible text form (an object, `null`) becomes `""` and is then
 * dropped by the normal empty-slot path rather than special-cased here.
 */
const asText = (raw: unknown): string => {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) return raw.map(asText).filter((s) => s.trim() !== "").join(" ");
  return "";
};

const asItems = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(asText).filter((s) => s.trim() !== "");
  const text = asText(raw);
  return text === "" ? [] : splitIntoItems(text);
};

const normalizeText = (
  spec: SlotSpec, value: string, adjustments: SlotAdjustment[],
): string | undefined => {
  const trimmed = value.trim();
  if (trimmed === "") {
    adjustments.push({ slotKey: spec.key, kind: "empty-dropped" });
    return undefined;
  }
  if (trimmed.length <= spec.maxChars) return trimmed;

  adjustments.push({
    slotKey: spec.key,
    kind: "truncated",
    detail: `${trimmed.length} → ${spec.maxChars} chars`,
  });
  return truncateAtWordBoundary(trimmed, spec.maxChars);
};

const normalizeList = (
  spec: SlotSpec, value: readonly string[], adjustments: SlotAdjustment[],
): string[] | undefined => {
  const itemMax = spec.itemMaxChars ?? spec.maxChars;
  const maxItems = spec.maxItems ?? value.length;

  let items = value.map((item) => item.trim()).filter((item) => item !== "");

  if (items.length > maxItems) {
    adjustments.push({
      slotKey: spec.key,
      kind: "items-dropped",
      detail: `${items.length} → ${maxItems} items`,
    });
    items = items.slice(0, maxItems);
  }

  items = items.map((item, index) => {
    if (item.length <= itemMax) return item;
    adjustments.push({
      slotKey: spec.key,
      kind: "item-truncated",
      detail: `item ${index + 1}: ${item.length} → ${itemMax} chars`,
    });
    return truncateAtWordBoundary(item, itemMax);
  });

  if (items.length === 0) {
    adjustments.push({ slotKey: spec.key, kind: "empty-dropped" });
    return undefined;
  }
  return items;
};

/**
 * Bring slot values inside the layout's budgets. Never throws and never fails: whatever comes in,
 * something renderable comes out. Unknown keys are dropped rather than passed through — a
 * hallucinated slot has no zone, so it would be invisible in the export while looking present in
 * the JSON, which is worse than absent.
 */
export function normalizeSlots(layout: SlideLayout, input: SlotValues): NormalizeResult {
  const adjustments: SlotAdjustment[] = [];
  const out: Record<string, SlotValue> = {};

  for (const spec of layout.slots) {
    const raw = input[spec.key];
    if (raw === undefined) continue;

    if (spec.type === "list") {
      // A text value in a list slot is coerced by `compileSlotSchema`; be tolerant here too so
      // `normalizeSlots` is safe to call on stored or hand-edited slots that never saw the schema.
      const value = normalizeList(spec, asItems(raw), adjustments);
      if (value !== undefined) out[spec.key] = value;
      continue;
    }

    const value = normalizeText(spec, asText(raw), adjustments);
    if (value !== undefined) out[spec.key] = value;
  }

  const known = new Set(layout.slots.map((s) => s.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) adjustments.push({ slotKey: key, kind: "unknown-slot-dropped" });
  }

  // `empty-dropped` and `unknown-slot-dropped` are not user-visible quality problems — the first is
  // just an absent optional slot, the second is noise the model emitted. Only lost *content* earns
  // the badge, or every slide would wear an amber flag and the signal would be worthless.
  const lostContent = adjustments.some(
    (a) => a.kind === "truncated" || a.kind === "items-dropped" || a.kind === "item-truncated",
  );

  return { slots: out, flags: lostContent ? ["trimmed"] : [], adjustments };
}

/** Newline-separated, or bulleted, model output for a list slot. Tolerant by design (§9). */
function splitIntoItems(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•‣▪]|\d+[.)])\s*/, "").trim())
    .filter((line) => line !== "");
}

/* ─────────────────────────────── zod compilation ─────────────────────────────── */

/**
 * Per-slot zod, compiled from the spec.
 *
 * Coercions are deliberate tolerance, not laxity — each one is a failure mode measured or
 * anticipated from real model output, and every one of them is deterministically recoverable:
 *   - a number where text was asked for (common in a `stats` layout) → stringified;
 *   - a newline/bulleted string where a list was asked for → split into items;
 *   - a single string where a list was asked for → a one-item list.
 * Spending the one repair call on any of these would be waste. What is NOT coerced: a missing
 * required slot, or a structurally wrong shape (object, nested array) — those are real failures.
 *
 * Budgets are NOT enforced here by default; `normalizeSlots` truncates instead. Pass
 * `enforceBudgets` for the user-edit path, where silently rewriting someone's typing would be wrong.
 */
export function compileSlotFieldSchema(
  spec: SlotSpec, options: { enforceBudgets?: boolean } = {},
): z.ZodType<SlotValue> {
  const { enforceBudgets = false } = options;

  // NOTE: these schemas are built without a widening `z.ZodType<…>` annotation. `.pipe()` checks the
  // *input* type of its target, and annotating a schema as `z.ZodType<string[]>` erases that input to
  // `unknown`, which then fails to match the transform's `string[]` output. Let zod infer, and narrow
  // only at the return.
  if (spec.type === "list") {
    const itemMax = spec.itemMaxChars ?? spec.maxChars;
    const item = enforceBudgets
      ? z.string().max(itemMax, { error: `must be ${itemMax} characters or fewer` })
      : z.string();
    const list = enforceBudgets && spec.maxItems !== undefined
      ? z.array(item).max(spec.maxItems, { error: `must have ${spec.maxItems} items or fewer` })
      : z.array(item);
    return z.union([
      list,
      // Tolerant: models sometimes answer a list slot with one newline-separated string.
      z.string().transform(splitIntoItems).pipe(list),
    ]) as unknown as z.ZodType<SlotValue>;
  }

  const text = enforceBudgets
    ? z.string().max(spec.maxChars, { error: `must be ${spec.maxChars} characters or fewer` })
    : z.string();
  return z.union([
    text,
    z.number().transform((n) => String(n)).pipe(text),
  ]) as unknown as z.ZodType<SlotValue>;
}

/**
 * The layout's slot object schema. Unknown keys are STRIPPED rather than rejected: a model adding a
 * plausible-but-unregistered slot has still produced usable content for the real ones, so failing
 * the whole slide over it would trade a good slide for a fallback one.
 */
export function compileSlotSchema(
  layout: SlideLayout, options: { enforceBudgets?: boolean } = {},
): z.ZodType<SlotValues> {
  const shape: Record<string, z.ZodType> = {};
  for (const spec of layout.slots) {
    const field = compileSlotFieldSchema(spec, options);
    shape[spec.key] = spec.required
      ? field
      : field.optional();
  }
  // `z.object` strips unknown keys by default; `normalizeSlots` reports them as adjustments.
  return z.object(shape) as unknown as z.ZodType<SlotValues>;
}

/** What a generation response must look like: slots plus optional notes (SPEC §6/§7.3). */
export function compileSlideResponseSchema(
  layout: SlideLayout, options: { enforceBudgets?: boolean } = {},
): z.ZodType<{ slots: SlotValues; speakerNotes?: string }> {
  const notes = options.enforceBudgets
    ? z.string().max(SPEAKER_NOTES_MAX_CHARS, {
      error: `must be ${SPEAKER_NOTES_MAX_CHARS} characters or fewer`,
    })
    : z.string();
  return z.object({
    slots: compileSlotSchema(layout, options),
    speakerNotes: notes.optional(),
  }) as unknown as z.ZodType<{ slots: SlotValues; speakerNotes?: string }>;
}

/* ─────────────────────────────── validate + repair feedback ─────────────────────────────── */

export interface SlotIssue {
  path: string;
  message: string;
}

export type SlotValidation =
  | { ok: true; value: SlotValues }
  | { ok: false; issues: SlotIssue[] };

export function validateSlots(
  layout: SlideLayout, input: unknown, options: { enforceBudgets?: boolean } = {},
): SlotValidation {
  const parsed = compileSlotSchema(layout, options).safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

/**
 * Validate, then fit. The generation happy path: a response that parses is normalized rather than
 * rejected, so budget overruns cost a flag instead of a repair call.
 */
export function validateAndNormalize(
  layout: SlideLayout, input: unknown,
): { ok: true; result: NormalizeResult } | { ok: false; issues: SlotIssue[] } {
  const validated = validateSlots(layout, input);
  if (!validated.ok) return { ok: false, issues: validated.issues };
  return { ok: true, result: normalizeSlots(layout, validated.value) };
}

/**
 * Render zod issues as instructions for the ONE repair pass (§9).
 *
 * Written for a model, not a person: name the field, state the requirement. No visual vocabulary
 * appears — these are derived from `SlotSpec`s, which §7's purity test already constrains.
 */
export const describeSlotIssues = (issues: readonly SlotIssue[]): string[] =>
  issues.map((i) => (i.path ? `"${i.path}": ${i.message}` : i.message));

/**
 * Budget counters for the workspace's inline slot editor (SPEC §7.4).
 * `over` is what turns the counter amber before the user saves, rather than after.
 */
export interface SlotBudget {
  key: string;
  used: number;
  max: number;
  over: boolean;
  items?: { used: number; max: number; over: boolean };
}

export function slotBudgets(layout: SlideLayout, slots: SlotValues): SlotBudget[] {
  return layout.slots.map((spec) => {
    const value = slots[spec.key];
    if (spec.type === "list") {
      const list = Array.isArray(value) ? value : [];
      const itemMax = spec.itemMaxChars ?? spec.maxChars;
      const longest = list.reduce((max, item) => Math.max(max, item.length), 0);
      const maxItems = spec.maxItems ?? list.length;
      return {
        key: spec.key,
        used: longest,
        max: itemMax,
        over: longest > itemMax,
        items: { used: list.length, max: maxItems, over: list.length > maxItems },
      };
    }
    const used = typeof value === "string" ? value.length : 0;
    return { key: spec.key, used, max: spec.maxChars, over: used > spec.maxChars };
  });
}
