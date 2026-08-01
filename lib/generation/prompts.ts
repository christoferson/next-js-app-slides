/**
 * Prompt construction (SPEC §7.1/§7.3, CLAUDE.md §2 step 11 and §7).
 *
 * ## This file is where "on-brand by construction" is won or lost
 *
 * The first product guarantee is that a deck cannot be off-brand, and the mechanism is negative: the
 * model is **never told what the brand looks like**. It receives content guidance — the message to
 * make, the tone to make it in, the words to avoid, and how many characters it has — and nothing else.
 * Appearance is applied afterwards, by the template system, from data the model never saw. A model
 * that has never been told the palette cannot contradict it.
 *
 * So the rule for every string in this file: **no hex, no font name, no coordinate or zone, no asset
 * id or filename**. `tests/prompt-purity` builds prompts from a brand stuffed with greppable values
 * (`#FF00AA`, `Zapfino`, a zone at `x:42`) and asserts none of them appear (§7). That test is a build
 * gate, not a nicety, and it is the reason this module takes a `BrandTone` rather than a
 * `BrandDefinition` — the visual fields are not in scope to leak.
 *
 * ## Why the slot contract is sent verbatim from the registry
 *
 * `SlotSpec.description` and `maxChars` go to the model exactly as the layout declares them. §1.1/C1
 * proved `fit:'shrink'` never shrinks, so a budget overrun costs real content: either it spills across
 * neighbouring zones or it is silently clipped. Telling the model the budget up front is much cheaper
 * than truncating after — the model can *compose to length*, whereas truncation can only amputate.
 * `normalizeSlots` is still the guarantee (§9); this is what keeps it from firing constantly.
 */

import type { BrandTone } from "@/lib/brand/types";
import type { Briefing, Outline, OutlineSlide } from "@/lib/domain/deck";
import type { SlideLayout, SlotSpec } from "@/lib/layouts/types";
import { SPEAKER_NOTES_MAX_CHARS } from "@/lib/layouts/validate";
import { resolveTone } from "@/lib/brand/tones";
import { hintVocabulary } from "@/lib/generation/hints";

/** Slide-count tolerance, matching the outline validator (SPEC §7.1: "±2"). */
export const OUTLINE_COUNT_TOLERANCE = 2;

export interface PromptContext {
  briefing: Briefing;
  /** Tone only. The rest of the brand is deliberately not in scope here — see the header. */
  tone: BrandTone;
  /** From the outline/slide regenerate inputs (SPEC §7.1/§7.4). Free text, so it is fenced below. */
  instruction?: string;
}

export interface SlidePromptContext extends PromptContext {
  layout: SlideLayout;
  slide: OutlineSlide;
  /** The section heading this slide sits under, for continuity. Empty when the section has none. */
  sectionHeading?: string;
  /** 1-based, for "slide 4 of 12" — helps the model pitch scope. */
  position?: { index: number; total: number };
  /** SPEC §7.3's generate options. */
  includeSpeakerNotes?: boolean;
  density?: "concise" | "standard" | "detailed";
}

/* ─────────────────────────────── shared blocks ─────────────────────────────── */

const block = (heading: string, body: string): string => `## ${heading}\n${body}`;

const joinBlocks = (parts: (string | undefined)[]): string =>
  parts.filter((p): p is string => p !== undefined && p.trim() !== "").join("\n\n");

/**
 * Fence user-supplied text so it reads as *data*, not as instructions.
 *
 * `sourceText` and `instruction` are the only free-text fields in a prompt, and both are
 * user-controlled. This is not a security boundary — a user pasting "ignore your instructions" into
 * their own deck's briefing can only damage their own deck, and there is no other tenant's data in the
 * context to reach. It is a *quality* measure: a pasted document containing the word "instructions"
 * routinely derails an unfenced prompt, and the delimiter makes the boundary unambiguous.
 */
const fenced = (label: string, text: string): string =>
  `<${label}>\n${text.trim()}\n</${label}>`;

/**
 * The tone block — the ONLY brand-derived content in any prompt (§7).
 *
 * `voice` is a TONES registry id whose `promptFragment` is written to be prompt-safe by construction;
 * an unknown id contributes nothing rather than being echoed, so a hand-edited brand config cannot
 * inject arbitrary text through this field. `traits` and `bannedWords` are the user's own words and
 * are content guidance by nature.
 */
function toneBlock(tone: BrandTone): string {
  const parts: string[] = [];
  const descriptor = resolveTone(tone.voice);
  if (descriptor) parts.push(descriptor.promptFragment);

  const traits = tone.traits.map((t) => t.trim()).filter((t) => t !== "");
  if (traits.length > 0) parts.push(`Qualities to hit: ${traits.join(", ")}.`);

  const banned = tone.bannedWords.map((w) => w.trim()).filter((w) => w !== "");
  if (banned.length > 0) {
    parts.push(
      `Never use these words or phrases, in any form: ${banned.join(", ")}. `
      + "If one is the obvious choice, rewrite the sentence instead of substituting a synonym.",
    );
  }
  return block("Voice", parts.join("\n"));
}

const briefingBlock = (briefing: Briefing): string => block("Briefing", joinBlocks([
  `Topic: ${briefing.topic}`,
  `Audience: ${briefing.audience}`,
  `What this presentation must achieve: ${briefing.objective}`,
]));

/** Instructions outrank everything else in the prompt, so they go last and say so. */
const instructionBlock = (instruction: string | undefined): string | undefined =>
  instruction === undefined || instruction.trim() === ""
    ? undefined
    : block(
      "Additional instruction",
      "This takes priority over the general guidance above where they conflict.\n"
      + fenced("instruction", instruction),
    );

/* ─────────────────────────────── outline ─────────────────────────────── */

export const OUTLINE_SYSTEM_PROMPT =
  "You are an experienced presentation strategist. You plan the argument of a deck before any slide "
  + "is written.\n\n"
  + "Your one rule: ONE SLIDE, ONE MESSAGE. Each slide answers a single question with a single "
  + "declarative sentence. A slide that needs \"and\" to state its message is two slides.\n\n"
  + "Respond with JSON only — no explanation, no code fence.";

/**
 * The outline call (SPEC §7.1). One call produces the whole plan.
 *
 * `sourceText` is capped by `MAX_SOURCE_TEXT_CHARS` at the config edge, so no truncation happens here;
 * a silent second cap would make the limit untraceable.
 */
export function buildOutlinePrompt(context: PromptContext): string {
  const { briefing, tone, instruction } = context;
  const { targetSlideCount } = briefing;
  const min = Math.max(1, targetSlideCount - OUTLINE_COUNT_TOLERANCE);
  const max = targetSlideCount + OUTLINE_COUNT_TOLERANCE;

  return joinBlocks([
    briefingBlock(briefing),
    toneBlock(tone),

    briefing.sourceText === undefined || briefing.sourceText.trim() === ""
      ? undefined
      : block(
        "Source material",
        "Ground every claim in this material. Do not introduce facts it does not support; where it is "
        + "silent, say less rather than inventing.\n"
        + fenced("source", briefing.sourceText),
      ),

    block("Structure", [
      `Plan ${targetSlideCount} slides (${min}–${max} is acceptable). Group them into 2–5 sections, `
      + "each with a short heading naming what that part of the argument establishes.",
      "The first slide opens the deck. The last slide closes it with what the audience should do, "
      + "decide, or remember.",
      "Sections are the argument's structure, not a table of contents: each should move the argument "
      + "forward rather than restate the topic.",
    ].join("\n")),

    block("Per-slide fields", [
      "- question: what this slide answers for the audience, as a question.",
      "- message: the answer, in ONE declarative sentence. This is the slide's whole point.",
      "- evidence: 0–4 short supports for the message"
      + (briefing.sourceText ? ", quoted or paraphrased from the source material." : "."),
      `- visualHint: one of the values below, describing the shape of the content.\n${hintVocabulary()}`,
    ].join("\n")),

    instructionBlock(instruction),

    block("Response format", [
      "Respond with this JSON object and nothing else:",
      "{\"sections\":[{\"heading\":\"…\",\"slides\":[{\"question\":\"…\",\"message\":\"…\","
      + "\"evidence\":[\"…\"],\"visualHint\":\"…\"}]}]}",
    ].join("\n")),
  ]);
}

/**
 * Regenerate ONE section, with the rest of the outline as fixed context (SPEC §7.1).
 *
 * The surrounding sections are included as read-only context rather than being regenerated, because
 * the point of a section-level regenerate is that the user liked everything else.
 */
export function buildSectionOutlinePrompt(
  context: PromptContext & { outline: Outline; sectionIndex: number },
): string {
  const { outline, sectionIndex, briefing, tone, instruction } = context;
  const target = outline.sections[sectionIndex];
  const targetCount = target?.slides.length ?? 3;

  const others = outline.sections
    .map((section, index) => ({ section, index }))
    .filter(({ index }) => index !== sectionIndex)
    .map(({ section, index }) =>
      `${index + 1}. ${section.heading || "(untitled)"}\n`
      + section.slides.map((s) => `   - ${s.message}`).join("\n"))
    .join("\n");

  return joinBlocks([
    briefingBlock(briefing),
    toneBlock(tone),

    others === "" ? undefined : block(
      "The rest of the deck (do not change, do not repeat)",
      others,
    ),

    block("Your task", [
      `Rewrite section ${sectionIndex + 1}, currently titled "${target?.heading ?? ""}".`,
      `Produce ${targetCount} slides (${Math.max(1, targetCount - 1)}–${targetCount + 1} is `
      + "acceptable), each with one message, following the same field rules:",
      "- question: what the slide answers, as a question.",
      "- message: the answer in ONE declarative sentence.",
      "- evidence: 0–4 short supports.",
      `- visualHint: one of:\n${hintVocabulary()}`,
    ].join("\n")),

    instructionBlock(instruction),

    block("Response format", [
      "Respond with this JSON object and nothing else — ONE section:",
      "{\"heading\":\"…\",\"slides\":[{\"question\":\"…\",\"message\":\"…\",\"evidence\":[\"…\"],"
      + "\"visualHint\":\"…\"}]}",
    ].join("\n")),
  ]);
}

/* ─────────────────────────────── per-slide ─────────────────────────────── */

export const SLIDE_SYSTEM_PROMPT =
  "You write the words that go on a presentation slide.\n\n"
  + "Slide copy is not prose. No full paragraphs, no lead-ins, no \"In this slide we will…\". Every "
  + "line earns its place or is cut.\n\n"
  + "Character limits are hard. Text over its limit is cut off, losing whatever came after it — so "
  + "compose to the limit rather than writing long and hoping.\n\n"
  + "Respond with JSON only — no explanation, no code fence.";

const DENSITY_GUIDANCE: Record<NonNullable<SlidePromptContext["density"]>, string> = {
  concise: "Aim for roughly half of each character limit. Fewer, shorter items; no supporting detail "
    + "that the speaker can supply out loud.",
  standard: "Use the character limits as a target, not a ceiling to reach for.",
  detailed: "Use most of each character limit. Include the supporting specifics — figures, names, "
    + "conditions — rather than leaving them to the speaker.",
};

/**
 * The slot contract, rendered from the registry (§4: never a parallel table).
 *
 * Both the budget and the item cap are stated because the model can satisfy them and truncation
 * cannot: dropping a fifth bullet loses a point outright, whereas the model asked for four would have
 * merged or chosen. `required` is stated too — an omitted required slot is the one failure that costs
 * the repair call (§9).
 */
function slotContract(spec: SlotSpec): string {
  const parts = [`- ${spec.key} (${spec.required ? "required" : "optional"}): ${spec.description}`];

  if (spec.type === "list") {
    const itemMax = spec.itemMaxChars ?? spec.maxChars;
    const cap = spec.maxItems === undefined
      ? "A list of strings."
      : `A list of at most ${spec.maxItems} strings.`;
    parts.push(`  ${cap} Each item: ${itemMax} characters maximum.`);
  } else {
    parts.push(`  A single string, ${spec.maxChars} characters maximum.`);
  }
  return parts.join("\n");
}

const jsonShape = (layout: SlideLayout, includeSpeakerNotes: boolean): string => {
  const slots = layout.slots
    .map((s) => `"${s.key}":${s.type === "list" ? "[\"…\"]" : "\"…\""}`)
    .join(",");
  const notes = includeSpeakerNotes ? ",\"speakerNotes\":\"…\"" : "";
  return `{"slots":{${slots}}${notes}}`;
};

/**
 * One slide's content prompt (SPEC §7.3).
 *
 * Note what is absent and cannot be added by accident: the layout's `defaultZones`, the brand's
 * colours and fonts, the background asset id. `layout.displayName` and `layout.description` are also
 * withheld — they are written for a human choosing a layout in the UI, and phrases like "large centred
 * title" would be visual vocabulary. The model sees only the slot keys, their content descriptions,
 * and their budgets.
 */
export function buildSlidePrompt(context: SlidePromptContext): string {
  const {
    layout, slide, briefing, tone, instruction, sectionHeading, position,
    includeSpeakerNotes = false, density = "standard",
  } = context;

  const evidence = slide.evidence.map((e) => e.trim()).filter((e) => e !== "");

  return joinBlocks([
    briefingBlock(briefing),
    toneBlock(tone),

    block("This slide", joinBlocks([
      position ? `Slide ${position.index + 1} of ${position.total}.` : undefined,
      sectionHeading !== undefined && sectionHeading.trim() !== ""
        ? `It sits in the section "${sectionHeading}".`
        : undefined,
      `The question it answers: ${slide.question}`,
      `The message it must land — this is not optional, and every field must serve it: ${slide.message}`,
      evidence.length > 0
        ? `Supporting material:\n${evidence.map((e) => `- ${e}`).join("\n")}`
        : "No supporting material was supplied. Do not invent figures, names, or citations.",
    ])),

    block("Fields to write", [
      ...layout.slots.map(slotContract),
      "",
      DENSITY_GUIDANCE[density],
      "Omit an optional field rather than padding it. Do not add fields that are not listed.",
    ].join("\n")),

    includeSpeakerNotes
      ? block("Speaker notes", "Also write speakerNotes: what the presenter says that the slide "
        + `does not show. ${SPEAKER_NOTES_MAX_CHARS} characters maximum. Do not restate the slide.`)
      : undefined,

    instructionBlock(instruction),

    block("Response format", `Respond with this JSON object and nothing else:\n${jsonShape(layout, includeSpeakerNotes)}`),
  ]);
}

/* ─────────────────────────────── repair ─────────────────────────────── */

export const REPAIR_SYSTEM_PROMPT =
  "You are correcting a JSON response that failed validation. Return the corrected JSON only — "
  + "no explanation, no code fence, no apology.";

/**
 * The ONE repair pass (SPEC §7.3, §9). Deliberately narrow.
 *
 * It restates the original prompt, shows what came back, and lists the specific validation failures
 * (`describeSlotIssues` — written for a model: name the field, state the requirement). It does not
 * re-argue the content: the failure is structural, and a broader "try again" prompt tends to return a
 * *different* structurally-wrong answer instead of a fix.
 *
 * The previous response is fenced. It is model output, i.e. hostile input by policy (§0.4), and
 * unfenced it can and does contain text that reads as instructions.
 */
export function buildRepairPrompt(args: {
  originalPrompt: string;
  previousResponse: string;
  issues: readonly string[];
}): string {
  return joinBlocks([
    block("The request that was made", args.originalPrompt),
    block("What you returned", fenced("previous_response", args.previousResponse)),
    block("What was wrong with it", joinBlocks([
      args.issues.map((issue) => `- ${issue}`).join("\n"),
      "Fix exactly these problems. Keep everything else as it was — do not rewrite content that was "
      + "not flagged. Respond with the corrected JSON object only.",
    ])),
  ]);
}
