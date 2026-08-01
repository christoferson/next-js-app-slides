/**
 * The `Validate → Repair → Fallback` chain (SPEC §7.3, CLAUDE.md §2 step 11, §9's matrix).
 *
 * ## The contract this chain exists to keep
 *
 * §0.4: "A malformed response never crashes a job, never yields a blank slide." That is an absolute,
 * so the chain is **total** — `FallbackHandler` always produces content, from material we already have
 * (the outline entry's message and evidence) rather than from anything the model returned. Every
 * escalation path ends there, including the paths that get there by throwing.
 *
 * ## Why an escalating chain rather than one function with three `if`s
 *
 * Each handler has a different *cost*: validation is free, repair is a second model call, fallback
 * costs content quality. Making them separate ordered handlers means the cost order is visible in one
 * place (`SLIDE_HANDLERS`) and testable as a sequence — §9's matrix is eight rows of "which handler
 * should have won", which is only a meaningful question if the handlers are distinct.
 *
 * ## The single repair pass is a budget, not a retry loop
 *
 * One pass, per SPEC. §1.2 measured JSON compliance at 10/10 clean on the default model, so repair is
 * the rare path; looping it would multiply cost and latency on exactly the decks that are already
 * struggling, and the second attempt's marginal value is low — a model that produced structurally
 * wrong output twice is unlikely to fix it on the third. The fallback is a better answer than a slow
 * one.
 */

import type { OutlineSlide, SlideIssue, SlideIssueReason } from "@/lib/domain/deck";
import type { QualityFlag } from "@/lib/stream/events";
import type { SlideLayout } from "@/lib/layouts/types";
import type { SlotValues } from "@/lib/domain/slots";
import { AppError, toReadable } from "@/lib/errors/errors";
import { fallbackLayout } from "@/lib/layouts/registry";
import {
  SPEAKER_NOTES_MAX_CHARS, type SlotIssue, describeSlotIssues, normalizeSlots,
  truncateAtWordBoundary, validateSlots,
} from "@/lib/layouts/validate";
import { extractJsonObject } from "@/lib/generation/extract-json";
import { buildRepairPrompt } from "@/lib/generation/prompts";

/** What a handler produces. `layoutId` is present because the fallback may CHANGE the layout. */
export interface SlideContent {
  layoutId: string;
  slots: SlotValues;
  speakerNotes?: string;
  flags: QualityFlag[];
  /** Set only when the content is not what the model was asked for. Drives the amber badge (§12). */
  issue?: SlideIssue;
}

/** Everything a handler may read, plus the one capability it may use (a second model call). */
export interface SlideAttempt {
  layout: SlideLayout;
  /** The outline entry — the fallback's content source, so it is required, not optional. */
  source: OutlineSlide;
  /** Raw model text from the first call. Empty string when the call itself failed. */
  responseText: string;
  /** The prompt that produced it — the repair pass restates it. */
  prompt: string;
  /** Present when the model call threw. Already an `AppError` (mapped by the adapter). */
  modelError?: unknown;
  /**
   * The repair call. Absent ⇒ repair is skipped and the chain escalates straight to fallback, which is
   * how the regenerate-a-single-slide path can opt out of a second call.
   */
  repair?: (prompt: string) => Promise<string>;
}

export type HandlerResult =
  | { handled: true; content: SlideContent }
  /** Escalate, carrying what was learned so the next handler can use it. */
  | { handled: false; issues: string[]; reason: SlideIssueReason };

export interface SlideHandler {
  id: "validate" | "repair" | "fallback";
  handle(attempt: SlideAttempt, previous: { issues: string[]; reason: SlideIssueReason } | undefined): Promise<HandlerResult>;
}

/* ─────────────────────────────── shared ─────────────────────────────── */

/**
 * Model text → validated, budget-fitted content.
 *
 * Shared by Validate and Repair because they differ only in *which* text they parse — duplicating this
 * is how the repair path drifts into skipping normalization, and an unnormalized repair response is
 * precisely the over-budget content §1.1/C1 says will be silently clipped in the export.
 */
function interpret(
  layout: SlideLayout, text: string,
): { ok: true; content: SlideContent } | { ok: false; issues: string[] } {
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

  const record = extracted as Record<string, unknown>;
  // Tolerated: a model that answers with the slots at the top level instead of under `slots`. A
  // deterministic packaging fix, so it must not cost the repair call. Detected by shape (a `slots`
  // key whose value is an object) rather than by guessing.
  const rawSlots = isRecord(record.slots) ? record.slots : record;

  const validated = validateSlots(layout, rawSlots);
  if (!validated.ok) return { ok: false, issues: describeSlotIssues(validated.issues) };

  const normalized = normalizeSlots(layout, validated.value);

  // A response that validates but leaves every slot empty is not usable content. It parses because
  // optional slots are optional and `normalizeSlots` drops empties — so without this check an
  // all-blank response would become a blank slide, which §0.4 forbids outright.
  if (Object.keys(normalized.slots).length === 0) {
    return { ok: false, issues: ["every field was empty. Fill at least the required fields."] };
  }

  const notes = readNotes(record);
  return {
    ok: true,
    content: {
      layoutId: layout.id,
      slots: normalized.slots,
      ...(notes !== undefined ? { speakerNotes: notes } : {}),
      flags: normalized.flags,
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Speaker notes are truncated, never rejected: they are supplementary, and failing a good slide over
 * an over-long note would be the wrong trade. Not flagged `trimmed` either — that badge means "the
 * audience-visible content lost something", and diluting it would cost its signal.
 */
function readNotes(record: Record<string, unknown>): string | undefined {
  const raw = record.speakerNotes;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.length <= SPEAKER_NOTES_MAX_CHARS
    ? trimmed
    : truncateAtWordBoundary(trimmed, SPEAKER_NOTES_MAX_CHARS);
}

/* ─────────────────────────────── 1. validate ─────────────────────────────── */

export const validateHandler: SlideHandler = {
  id: "validate",

  async handle(attempt) {
    // A failed model call has no text to validate. Escalate with the READABLE message — `AppError`
    // already carries one, and this is what reaches the user on the `slide-error` event (§13).
    if (attempt.modelError !== undefined) {
      return {
        handled: false,
        reason: "model-error",
        issues: [toReadable(attempt.modelError).message],
      };
    }

    const interpreted = interpret(attempt.layout, attempt.responseText);
    if (interpreted.ok) return { handled: true, content: interpreted.content };
    return { handled: false, reason: "validation-failed", issues: interpreted.issues };
  },
};

/* ─────────────────────────────── 2. repair ─────────────────────────────── */

export const repairHandler: SlideHandler = {
  id: "repair",

  async handle(attempt, previous) {
    // Not attempted after a model error: the first call failed for a reason (throttle, access, timeout)
    // that a second identical call will hit again, and retrying inside the chain would double the
    // latency of every failing slide. Transport-level retry is the SDK's job, not this chain's.
    if (previous?.reason === "model-error") return escalate(previous);
    if (attempt.repair === undefined || previous === undefined) return escalate(previous);

    const prompt = buildRepairPrompt({
      originalPrompt: attempt.prompt,
      previousResponse: attempt.responseText,
      issues: previous.issues,
    });

    let text: string;
    try {
      text = await attempt.repair(prompt);
    } catch (err) {
      // The repair call itself failed. The ORIGINAL issues are what the user should hear about — a
      // throttle on the repair attempt is our problem, not an explanation of their slide.
      return {
        handled: false,
        reason: "repair-failed",
        issues: [...previous.issues, ...(err instanceof AppError ? [toReadable(err).message] : [])],
      };
    }

    const interpreted = interpret(attempt.layout, text);
    if (interpreted.ok) return { handled: true, content: interpreted.content };

    // Both attempts failed. `repair-failed` rather than `validation-failed` so the UI can say "we
    // tried twice", and both issue sets are kept for the log — the second often explains the first.
    return {
      handled: false,
      reason: "repair-failed",
      issues: [...previous.issues, ...interpreted.issues],
    };
  },
};

const escalate = (
  previous: { issues: string[]; reason: SlideIssueReason } | undefined,
): HandlerResult => ({
  handled: false,
  reason: previous?.reason ?? "internal",
  issues: previous?.issues ?? [],
});

/* ─────────────────────────────── 3. fallback ─────────────────────────────── */

/**
 * The floor. ALWAYS produces content, built from the outline entry — never from model output, which is
 * by definition the thing that failed.
 *
 * It switches to the `bullets` layout (SPEC §7.3) rather than filling the mapped one. The mapped layout
 * may require slots the outline cannot supply — `stats` needs labelled figures, `quote` needs an
 * attributed quotation — and a `stats` slide with a message crammed into its title slot looks broken in
 * a way a plain bulleted slide does not. The registry asserts `bullets` is fillable from
 * `title` + `items` alone, which is exactly what an outline entry provides.
 */
export const fallbackHandler: SlideHandler = {
  id: "fallback",

  async handle(attempt, previous) {
    const layout = fallbackLayout();
    const reason: SlideIssueReason = previous?.reason ?? "internal";

    const items = attempt.source.evidence
      .map((e) => e.trim())
      .filter((e) => e !== "");

    // Message as the title, evidence as the items — and when there is no evidence, the message becomes
    // the single item so the slide is never a bare heading over blank space.
    const slots = normalizeSlots(layout, {
      title: attempt.source.question || attempt.source.message,
      items: items.length > 0 ? items : [attempt.source.message],
    });

    return {
      handled: true,
      content: {
        layoutId: layout.id,
        slots: slots.slots,
        // `fallback` always; `trimmed` only if the outline text itself had to be cut. Both are amber
        // badges and both are true, so both are reported (§12: never suppressed).
        flags: ["fallback", ...slots.flags],
        issue: { reason, message: fallbackMessage(reason) },
      },
    };
  },
};

/**
 * User-facing text for a fallback slide. Says what happened and what to do — the raw zod issues are
 * for the model and the log, never for a person reading their deck.
 */
function fallbackMessage(reason: SlideIssueReason): string {
  switch (reason) {
    case "model-error":
      return "The AI couldn't be reached for this slide, so it was built from your outline. "
        + "Regenerate it to try again.";
    case "validation-failed":
    case "repair-failed":
      return "The AI's response for this slide couldn't be used, so it was built from your outline. "
        + "Regenerate it, or edit it directly.";
    case "internal":
      return "Something went wrong generating this slide, so it was built from your outline. "
        + "Regenerate it to try again.";
  }
}

/* ─────────────────────────────── the chain ─────────────────────────────── */

/** Cheapest first, and the order IS the escalation policy. */
export const SLIDE_HANDLERS: readonly SlideHandler[] = [
  validateHandler,
  repairHandler,
  fallbackHandler,
];

/**
 * Run the chain. Total by construction: the fallback always handles, and a handler that *throws* is
 * caught rather than propagated, because §0.4's "never crashes a job" has to hold even for a bug in a
 * handler.
 */
export async function runSlideHandlers(
  attempt: SlideAttempt,
  handlers: readonly SlideHandler[] = SLIDE_HANDLERS,
): Promise<SlideContent> {
  let previous: { issues: string[]; reason: SlideIssueReason } | undefined;

  for (const handler of handlers) {
    let result: HandlerResult;
    try {
      result = await handler.handle(attempt, previous);
    } catch (err) {
      // A handler threw — a bug, or an unmapped error from a repair callback. Keep escalating with
      // what we know rather than failing the slide, and preserve the earlier reason if there was one:
      // "the model was throttled" explains the slide better than "something broke internally".
      result = {
        handled: false,
        reason: previous?.reason ?? "internal",
        issues: [...(previous?.issues ?? []), ...(err instanceof AppError ? [toReadable(err).message] : [])],
      };
    }

    if (result.handled) return result.content;
    previous = { issues: result.issues, reason: result.reason };
  }

  // Unreachable with `SLIDE_HANDLERS`, but reachable with a custom chain (a test, or a future
  // configuration). Producing the fallback is the only answer consistent with "never a blank slide".
  return (await fallbackHandler.handle(attempt, previous) as { handled: true; content: SlideContent }).content;
}

/** For the log and for `DEBUG_PROMPTS`: what the chain rejected, and why. Never shown to a user. */
export const debugIssues = (issues: readonly SlotIssue[]): string => describeSlotIssues(issues).join("; ");
