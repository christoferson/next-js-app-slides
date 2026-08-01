/**
 * Outline generation (SPEC §7.1: "one LLM call, zod-validated … Invalid → one repair pass → readable
 * error").
 *
 * ## Why this differs from the slide pipeline, deliberately
 *
 * The slide chain ends in a fallback because a deck with one weak slide is far better than no deck.
 * The outline has **no fallback**: it is the plan the whole deck is generated from, and a fabricated
 * plan ("Introduction / Body / Conclusion" from the topic string) would be worse than an error. The user
 * would spend a full generation pass discovering it. So this is `validate → repair → readable error`,
 * and the error is honest.
 *
 * That asymmetry is the reason this is a separate file rather than a variant of `handlers.ts`. Sharing
 * the chain would mean sharing the fallback, and the fallback is exactly what must not exist here.
 */

import type { Briefing, Outline, OutlineSection } from "@/lib/domain/deck";
import type { BrandTone } from "@/lib/brand/types";
import type { LLMPort } from "@/lib/ports/llm-port";
import { GenerationFailed } from "@/lib/errors/errors";
import { extractJsonObject } from "@/lib/generation/extract-json";
import {
  type OutlineAdvisory, type OutlineIssue, describeOutlineIssues, outlineAdvisories, parseOutline,
  parseOutlineSection,
} from "@/lib/generation/outline-schema";
import {
  OUTLINE_SYSTEM_PROMPT, REPAIR_SYSTEM_PROMPT, buildOutlinePrompt, buildRepairPrompt,
  buildSectionOutlinePrompt,
} from "@/lib/generation/prompts";

/**
 * Larger than a slide's ceiling: an outline is up to 60 slides of question + message + evidence in one
 * response, and a `max_tokens` cut-off mid-JSON is unrecoverable (the extractor will not close braces
 * it did not see — see `extract-json.ts`). Being generous here is cheap; being tight is a hard failure.
 */
export const OUTLINE_MAX_TOKENS = 8000;

export interface OutlineDeps {
  llm: LLMPort;
  modelId: string;
  temperature?: number;
  signal?: AbortSignal;
  /** §7's `DEBUG_PROMPTS=1`. Called with the final prompt so purity is verifiable in logs. */
  onPrompt?: (label: string, prompt: string) => void;
}

export interface OutlineGenerationRequest {
  briefing: Briefing;
  tone: BrandTone;
  instruction?: string;
}

export interface OutlineResult {
  outline: Outline;
  /** Non-blocking quality notes for the editor's advisory strip (§12). */
  advisories: OutlineAdvisory[];
  /** True when the first response needed the repair pass — surfaced so the log tells the story. */
  repaired: boolean;
}

export async function generateOutline(
  request: OutlineGenerationRequest, deps: OutlineDeps,
): Promise<OutlineResult> {
  const prompt = buildOutlinePrompt({
    briefing: request.briefing,
    tone: request.tone,
    ...(request.instruction !== undefined ? { instruction: request.instruction } : {}),
  });
  deps.onPrompt?.("outline", prompt);

  const attempt = await complete(deps, OUTLINE_SYSTEM_PROMPT, prompt);
  const first = interpret(attempt, parseOutline);
  if (first.ok) {
    return {
      outline: first.value,
      advisories: outlineAdvisories(first.value, request.briefing.targetSlideCount),
      repaired: false,
    };
  }

  // The ONE repair pass. Non-streaming on purpose: nothing is displayed incrementally here, and the
  // outline editor only renders once a complete plan exists.
  const repairPrompt = buildRepairPrompt({
    originalPrompt: prompt,
    previousResponse: attempt,
    issues: first.issues,
  });
  deps.onPrompt?.("outline-repair", repairPrompt);

  const repaired = await complete(deps, REPAIR_SYSTEM_PROMPT, repairPrompt);
  const second = interpret(repaired, parseOutline);
  if (second.ok) {
    return {
      outline: second.value,
      advisories: outlineAdvisories(second.value, request.briefing.targetSlideCount),
      repaired: true,
    };
  }

  // No fallback — see the header. `detail` carries both issue sets for the log; the readable message
  // says what to do, and deliberately does not quote model output back at the user.
  throw GenerationFailed(
    "The AI couldn't produce a usable outline. Try again, or add more detail to the briefing.",
    { attempts: 2, firstIssues: first.issues, repairIssues: second.issues },
  );
}

export interface SectionOutlineRequest extends OutlineGenerationRequest {
  outline: Outline;
  sectionIndex: number;
}

/**
 * Regenerate ONE section (SPEC §7.1's `sectionIndex`). Same two-attempt budget, same no-fallback rule.
 *
 * Returns just the section; splicing it into the outline is the service's job, because that is the
 * layer that owns the persisted document and can do it in one write.
 */
export async function generateOutlineSection(
  request: SectionOutlineRequest, deps: OutlineDeps,
): Promise<{ section: OutlineSection; repaired: boolean }> {
  if (request.outline.sections[request.sectionIndex] === undefined) {
    // Not a model failure — a bad request. Distinct message so it is not mistaken for one in the log.
    throw GenerationFailed("That section no longer exists. Reload the outline and try again.", {
      sectionIndex: request.sectionIndex, sectionCount: request.outline.sections.length,
    });
  }

  const prompt = buildSectionOutlinePrompt({
    briefing: request.briefing,
    tone: request.tone,
    outline: request.outline,
    sectionIndex: request.sectionIndex,
    ...(request.instruction !== undefined ? { instruction: request.instruction } : {}),
  });
  deps.onPrompt?.("outline-section", prompt);

  const attempt = await complete(deps, OUTLINE_SYSTEM_PROMPT, prompt);
  const first = interpret(attempt, parseOutlineSection);
  if (first.ok) return { section: first.value, repaired: false };

  const repairPrompt = buildRepairPrompt({
    originalPrompt: prompt, previousResponse: attempt, issues: first.issues,
  });
  deps.onPrompt?.("outline-section-repair", repairPrompt);

  const second = interpret(await complete(deps, REPAIR_SYSTEM_PROMPT, repairPrompt), parseOutlineSection);
  if (second.ok) return { section: second.value, repaired: true };

  throw GenerationFailed(
    "The AI couldn't rewrite that section. Try again, or edit the slides directly.",
    { attempts: 2, firstIssues: first.issues, repairIssues: second.issues },
  );
}

/* ─────────────────────────────── shared ─────────────────────────────── */

const complete = (deps: OutlineDeps, system: string, prompt: string): Promise<string> =>
  deps.llm.complete({
    modelId: deps.modelId,
    system,
    prompt,
    maxTokens: OUTLINE_MAX_TOKENS,
    ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  }).then((r) => r.text);

/**
 * Extract, then parse. Both stages produce issues in the same shape so the repair prompt does not care
 * which failed — and both are model-facing text, never user-facing.
 *
 * Generic over the parser so the whole-outline and single-section paths share it: they differ only in
 * the schema, and a second copy of this is where "the section path forgot to run the extractor" lives.
 */
function interpret<T>(
  text: string,
  parse: (input: unknown) => { ok: true; outline: T } | { ok: true; section: T } | { ok: false; issues: OutlineIssue[] },
): { ok: true; value: T } | { ok: false; issues: string[] } {
  const extracted = extractJsonObject(text);
  if (extracted === undefined) {
    return {
      ok: false,
      issues: [
        "the response was not a JSON object. Respond with the JSON object only — no explanation and "
        + "no code fence.",
      ],
    };
  }

  const parsed = parse(extracted);
  if (!parsed.ok) return { ok: false, issues: describeOutlineIssues(parsed.issues) };
  return { ok: true, value: "outline" in parsed ? parsed.outline : parsed.section };
}
