/**
 * Outline validation (SPEC §7.1: "zod-validated (count ±2, opening/closing at boundaries, one message
 * per slide, tone fragment). Invalid → one repair pass → readable error").
 *
 * ## Two tiers, and the split is the whole design
 *
 * `parseOutline` enforces what makes an outline *usable*: sections exist, each slide has a question, a
 * message, and a recognized hint. A failure here is unrecoverable by us and feeds the repair pass.
 *
 * `outlineAdvisories` reports what makes an outline *good*: the slide count landing within ±2 of the
 * target, an opening-ish first slide, a closing-ish last one. These are **not** validation failures,
 * and that is deliberate. §9 says "slide-count wildly off target → regenerate guidance surfaced" —
 * surfaced, not rejected. An outline of 9 slides against a target of 12 is a perfectly good outline
 * that the user may prefer; failing it would spend the repair call and then possibly error out on
 * something the user never minded. They get an advisory and a regenerate button instead.
 *
 * Boundary hints in particular are advisory because `PositionalRule` (SPEC §7.2) *already* forces the
 * first slide to `title` and the last to `closing` regardless of what the model said. The hint being
 * "wrong" there changes nothing about the rendered deck — so rejecting the outline over it would be
 * pure cost.
 */

import { z } from "zod";
import type { Outline, OutlineSection, OutlineSlide, VisualHint } from "@/lib/domain/deck";
import { HINT_DESCRIPTIONS, hintOrder } from "@/lib/generation/hints";
import { OUTLINE_COUNT_TOLERANCE } from "@/lib/generation/prompts";

/** Caps that keep one bad response from producing an unusable editor. Generous, not tight. */
export const OUTLINE_LIMITS = {
  maxSections: 12,
  maxSlidesPerSection: 20,
  maxSlidesTotal: 60,
  maxQuestionChars: 300,
  maxMessageChars: 400,
  maxEvidenceItems: 4,
  maxEvidenceChars: 400,
  maxHeadingChars: 120,
} as const;

const hintValues = hintOrder() as [VisualHint, ...VisualHint[]];

/**
 * `visualHint` falls back to `detail` rather than failing.
 *
 * An invented hint is recoverable without a repair call: `detail` is the general-purpose shape, and
 * `IntentMatchRule` resolves it through the registry like any other. Failing the whole outline — every
 * section, every slide — because one slide said `"chart"` would be wildly disproportionate.
 */
const visualHintSchema = z.preprocess(
  (value) => (typeof value === "string" && value in HINT_DESCRIPTIONS ? value : "detail"),
  z.enum(hintValues),
);

/**
 * Evidence is tolerant on the way in: a model asked for `string[]` occasionally sends one string.
 * That is packaging, not a content failure, so it is coerced rather than repaired.
 */
const evidenceSchema = z.preprocess(
  (value) => {
    if (typeof value === "string") return value.trim() === "" ? [] : [value];
    if (value === undefined || value === null) return [];
    return value;
  },
  z.array(z.string().max(OUTLINE_LIMITS.maxEvidenceChars).transform((s) => s.trim()))
    .transform((items) => items.filter((item) => item !== "").slice(0, OUTLINE_LIMITS.maxEvidenceItems)),
);

const nonEmpty = (max: number, field: string) =>
  z.string()
    .transform((s) => s.trim())
    .refine((s) => s !== "", { error: `${field} must not be empty` })
    .refine((s) => s.length <= max, { error: `${field} must be ${max} characters or fewer` });

export const outlineSlideSchema: z.ZodType<OutlineSlide> = z.object({
  question: nonEmpty(OUTLINE_LIMITS.maxQuestionChars, "question"),
  message: nonEmpty(OUTLINE_LIMITS.maxMessageChars, "message"),
  evidence: evidenceSchema,
  visualHint: visualHintSchema,
  // Never model-supplied — the user sets it in the editor. Stripped here so a model cannot pin a
  // layout by inventing the field, which would silently outrank the whole mapping chain (§7.2).
}).transform(({ question, message, evidence, visualHint }) => ({
  question, message, evidence, visualHint,
})) as unknown as z.ZodType<OutlineSlide>;

export const outlineSectionSchema: z.ZodType<OutlineSection> = z.object({
  // A blank heading is allowed: `PositionalRule` already declines to divide an unheaded section, so
  // an untitled section renders correctly. Requiring one would fail an otherwise fine outline.
  heading: z.string().max(OUTLINE_LIMITS.maxHeadingChars).transform((s) => s.trim()).catch(""),
  slides: z.array(outlineSlideSchema).max(OUTLINE_LIMITS.maxSlidesPerSection),
}) as unknown as z.ZodType<OutlineSection>;

export const outlineSchema: z.ZodType<Outline> = z.object({
  sections: z.array(outlineSectionSchema)
    .min(1, { error: "at least one section is required" })
    .max(OUTLINE_LIMITS.maxSections),
})
  // Empty sections are dropped here rather than rejected: `mapOutline` already skips them, and one
  // stray empty section is not worth a repair call.
  .transform((outline) => ({ sections: outline.sections.filter((s) => s.slides.length > 0) }))
  .refine((outline) => outline.sections.length > 0, {
    error: "the outline contains no slides",
  })
  .refine((outline) => countSlides(outline) <= OUTLINE_LIMITS.maxSlidesTotal, {
    error: `an outline may contain at most ${OUTLINE_LIMITS.maxSlidesTotal} slides`,
  }) as unknown as z.ZodType<Outline>;

export const countSlides = (outline: Outline): number =>
  outline.sections.reduce((total, section) => total + section.slides.length, 0);

export interface OutlineIssue {
  path: string;
  message: string;
}

export type OutlineParse =
  | { ok: true; outline: Outline }
  | { ok: false; issues: OutlineIssue[] };

export function parseOutline(input: unknown): OutlineParse {
  const parsed = outlineSchema.safeParse(input);
  if (parsed.success) return { ok: true, outline: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

/** One regenerated section (SPEC §7.1's `sectionIndex` path). */
export function parseOutlineSection(input: unknown): { ok: true; section: OutlineSection } | { ok: false; issues: OutlineIssue[] } {
  const parsed = outlineSectionSchema.safeParse(input);
  if (parsed.success) {
    if (parsed.data.slides.length === 0) {
      return { ok: false, issues: [{ path: "slides", message: "the section contains no slides" }] };
    }
    return { ok: true, section: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

/** Repair-pass feedback, written for a model: name the field, state the requirement. */
export const describeOutlineIssues = (issues: readonly OutlineIssue[]): string[] =>
  issues.map((i) => (i.path ? `"${i.path}": ${i.message}` : i.message));

/* ─────────────────────────────── advisories ─────────────────────────────── */

export type OutlineAdvisoryKind = "count-off-target" | "no-opening" | "no-closing" | "single-section";

export interface OutlineAdvisory {
  kind: OutlineAdvisoryKind;
  /** Already user-readable — this text goes on screen next to a regenerate control (§12). */
  message: string;
}

/**
 * Quality notes on a *valid* outline. Never blocks; drives the editor's advisory strip.
 *
 * The count check uses the same ±2 the prompt asked for, so the user is never told the model missed a
 * target it was never given. See the header for why none of these are validation failures.
 */
export function outlineAdvisories(outline: Outline, targetSlideCount: number): OutlineAdvisory[] {
  const advisories: OutlineAdvisory[] = [];
  const count = countSlides(outline);

  if (Math.abs(count - targetSlideCount) > OUTLINE_COUNT_TOLERANCE) {
    advisories.push({
      kind: "count-off-target",
      message: `This outline has ${count} slides; you asked for about ${targetSlideCount}. `
        + "Regenerate, or add and remove slides directly.",
    });
  }

  const slides = outline.sections.flatMap((s) => s.slides);
  const first = slides[0];
  const last = slides.at(-1);

  // "opening"/"closing" are the hints; a slide may legitimately carry another and still read as one,
  // which is why the wording is a suggestion rather than a diagnosis.
  if (first && first.visualHint !== "opening") {
    advisories.push({
      kind: "no-opening",
      message: "The first slide isn't framed as an opening. It will still render as the title slide.",
    });
  }
  if (last && slides.length > 1 && last.visualHint !== "closing") {
    advisories.push({
      kind: "no-closing",
      message: "The last slide isn't framed as a close. It will still render as the closing slide.",
    });
  }
  if (outline.sections.length === 1 && count > 4) {
    advisories.push({
      kind: "single-section",
      message: "Everything is in one section. Splitting it gives the deck section dividers and a "
        + "clearer structure.",
    });
  }
  return advisories;
}
