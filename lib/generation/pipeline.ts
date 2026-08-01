/**
 * The generation pipeline (SPEC §7.3, CLAUDE.md §2 step 11 — Template Method + Observer).
 *
 * `generateSlide` is the Template Method: a FIXED sequence — buildPrompt → invoke → handle chain →
 * notify — where the pluggable parts are the prompt builder, the model call, and the handler chain.
 * Fixed because the guarantees live in the sequence: every slide is validated, every failure escalates
 * the same way, and every outcome is announced exactly once.
 *
 * ## What this file deliberately does NOT do
 *
 * It does not know about a repository. SPEC §7.3 puts `persist` in the fixed sequence (… fallback →
 * **persist** → notify), so there is a `persist` hook — but it is a *callback*, supplied by
 * `GenerationService`, which owns the `DeckRepository`. The pipeline stays testable against canned
 * model responses with no repository at all (§9's matrix), and it remains the queue seam SPEC §15
 * names — an SQS worker replaces the *executor* below without touching the pipeline.
 *
 * The ordering is load-bearing, not cosmetic: `slide-done` tells the client a slide exists. Emitting it
 * before the write means a process death between the two leaves the client showing a slide that was
 * never stored.
 *
 * ## Observer, and why it is a callback rather than an EventEmitter
 *
 * Progress leaves through one `emit(event)` callback typed as the SSE union (`lib/stream/events`). One
 * function is enough for one consumer, it keeps the pipeline free of any transport, and — the part that
 * matters — it makes "every slide announces exactly once" checkable by collecting events in a test.
 * `emit` is also wrapped: a throwing consumer (a closed SSE stream, most likely) must not fail the
 * generation that is still producing slides worth persisting.
 */

import type { Briefing, OutlineSlide } from "@/lib/domain/deck";
import type { BrandTone } from "@/lib/brand/types";
import type { LLMPort } from "@/lib/ports/llm-port";
import type { StreamEvent } from "@/lib/stream/events";
import { AppError, toReadable } from "@/lib/errors/errors";
import { requireLayout } from "@/lib/layouts/registry";
import { type MappedSlide } from "@/lib/mapping/rules";
import {
  type SlideAttempt, type SlideContent, type SlideHandler, SLIDE_HANDLERS, runSlideHandlers,
} from "@/lib/generation/handlers";
import { buildSlidePrompt, SLIDE_SYSTEM_PROMPT, REPAIR_SYSTEM_PROMPT } from "@/lib/generation/prompts";

/** Token ceiling per slide. Slot budgets cap the *content*; this caps the cost of a runaway response. */
export const SLIDE_MAX_TOKENS = 1500;

export type EmitFn = (event: StreamEvent) => void;

export interface GenerationDeps {
  llm: LLMPort;
  /**
   * Stamps `at` on every event. Injected because a fixed clock makes emitted events assertable — and
   * because `Date.now()` scattered through a pipeline is untestable by construction.
   */
  now: () => number;
  emit: EmitFn;
  /** Slide ids are allocated here so `slide-start` can name the slide before content exists. */
  newId: () => string;
  /**
   * §7's `DEBUG_PROMPTS=1` hook — see `prompt-log.ts`. Optional and unset by default: prompts contain
   * the user's briefing text, so logging them is opt-in, and the no-op costs one absent call.
   */
  onPrompt?: (label: string, prompt: string) => void;
  /**
   * SPEC §7.3's `persist` step. A callback rather than a repository, so this file keeps no storage
   * dependency (see the header). `GenerationService` supplies one that calls `putSlide`.
   *
   * A throw here is NOT swallowed: unlike `emit`, a failed write means the slide does not exist, and
   * reporting `slide-done` for it would be a lie. It surfaces as that slide's `internal` error.
   */
  persist?: (outcome: SlideOutcome) => Promise<void>;
}

export interface SlideJob {
  /** Already mapped (SPEC §7.2) — the pipeline never decides a layout itself. */
  mapped: MappedSlide;
  slideId: string;
  sectionHeading?: string;
}

export interface DeckGenerationRequest {
  deckId: string;
  briefing: Briefing;
  tone: BrandTone;
  jobs: readonly SlideJob[];
  includeSpeakerNotes?: boolean;
  density?: "concise" | "standard" | "detailed";
  /** Whole-deck instruction; a per-slide one overrides it on the regenerate path. */
  instruction?: string;
  concurrency: number;
  signal?: AbortSignal;
}

export interface SlideOutcome {
  slideId: string;
  index: number;
  content: SlideContent;
  /** True when the content is the fallback's, i.e. the slide is present but not what was asked for. */
  degraded: boolean;
}

/* ─────────────────────────────── one slide ─────────────────────────────── */

export interface SlideGenerationRequest {
  slideId: string;
  index: number;
  total: number;
  layoutId: string;
  source: OutlineSlide;
  briefing: Briefing;
  tone: BrandTone;
  sectionHeading?: string;
  instruction?: string;
  includeSpeakerNotes?: boolean;
  density?: "concise" | "standard" | "detailed";
  modelId: string;
  temperature?: number;
  signal?: AbortSignal;
  /** Overridable so §9's matrix can drive the chain directly. */
  handlers?: readonly SlideHandler[];
}

/**
 * ONE slide, start to finish. The Template Method — the step sequence is fixed; the steps are injected.
 *
 * Resolves for every *content* failure. A slide that fails every handler still returns the fallback's
 * content, because §0.4's "never a blank slide, never a crashed job" is what the whole file is for.
 * Two things do throw, and both are deliberate:
 *
 *   - an **abort** — cancellation is not a slide failure, and §9 requires the remaining slides to stop
 *     rather than each producing a fallback;
 *   - a **`persist` failure** — the slide does not exist, so there is no honest outcome to return.
 *     `generateDeck` catches it, reports that slide as `internal`, and carries on with the rest.
 */
export async function generateSlide(
  request: SlideGenerationRequest, deps: GenerationDeps,
): Promise<SlideOutcome> {
  const layout = requireLayout(request.layoutId);

  emitSafely(deps, {
    type: "slide-start", at: deps.now(),
    slideId: request.slideId, index: request.index, layoutId: layout.id,
  });

  // 1. buildPrompt — from the registry's slot specs and the tone. No visual vocabulary (§7).
  const prompt = buildSlidePrompt({
    layout,
    slide: request.source,
    briefing: request.briefing,
    tone: request.tone,
    ...(request.sectionHeading !== undefined ? { sectionHeading: request.sectionHeading } : {}),
    ...(request.instruction !== undefined ? { instruction: request.instruction } : {}),
    position: { index: request.index, total: request.total },
    includeSpeakerNotes: request.includeSpeakerNotes ?? false,
    density: request.density ?? "standard",
  });
  deps.onPrompt?.(`slide[${request.index}]:${layout.id}`, prompt);

  // 2. invoke — streamed, so the client sees text arrive rather than a spinner.
  const invoked = await invokeStreaming(request, deps, prompt);
  if (invoked.aborted) throw invoked.error;

  // 3. handle — Validate → Repair → Fallback (§9). Total: always yields content.
  const attempt: SlideAttempt = {
    layout,
    source: request.source,
    responseText: invoked.text,
    prompt,
    ...(invoked.error !== undefined ? { modelError: invoked.error } : {}),
    // The repair prompt is built by the handler, so this callback is the only place it can be logged.
    repair: (repairPrompt) => {
      deps.onPrompt?.(`slide[${request.index}]:${layout.id}:repair`, repairPrompt);
      return deps.llm.complete({
        modelId: request.modelId,
        system: REPAIR_SYSTEM_PROMPT,
        prompt: repairPrompt,
        maxTokens: SLIDE_MAX_TOKENS,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      }).then((r) => r.text);
    },
  };

  const content = await runSlideHandlers(attempt, request.handlers ?? SLIDE_HANDLERS);
  const degraded = content.issue !== undefined;
  const outcome: SlideOutcome = { slideId: request.slideId, index: request.index, content, degraded };

  // 4. persist — BEFORE notifying, so `slide-done` never announces a slide that was not stored.
  await deps.persist?.(outcome);

  // 5. notify — exactly one terminal event per slide. A degraded slide gets `slide-error` (so the UI
  // can badge it) even though content EXISTS, which is the distinction §9's `{ok, failed}` counts on.
  emitSafely(deps, degraded
    ? {
      type: "slide-error", at: deps.now(),
      slideId: request.slideId, index: request.index,
      reason: content.issue!.reason, message: content.issue!.message,
    }
    : {
      type: "slide-done", at: deps.now(),
      slideId: request.slideId, index: request.index, flags: content.flags,
    });

  return outcome;
}

/**
 * The model call, streamed, with deltas forwarded as they arrive.
 *
 * Returns rather than throws for a model failure: the handler chain needs to *see* the error to choose
 * `model-error` and produce a fallback, so throwing here would skip the very machinery that keeps the
 * slide from being blank. An abort is the exception and is flagged for rethrow.
 *
 * Partial text is kept on failure. A throttle after 90% of a response still leaves content the
 * extractor may recover — discarding it would turn a recoverable slide into a fallback.
 */
async function invokeStreaming(
  request: SlideGenerationRequest, deps: GenerationDeps, prompt: string,
): Promise<{ text: string; error?: unknown; aborted: boolean }> {
  let text = "";
  try {
    const stream = deps.llm.stream({
      modelId: request.modelId,
      system: SLIDE_SYSTEM_PROMPT,
      prompt,
      maxTokens: SLIDE_MAX_TOKENS,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

    for await (const delta of stream) {
      text += delta.text;
      emitSafely(deps, {
        type: "slide-delta", at: deps.now(), slideId: request.slideId, text: delta.text,
      });
    }
    return { text, aborted: false };
  } catch (err) {
    if (isAbort(err)) return { text, error: err, aborted: true };
    return { text, error: err, aborted: false };
  }
}

const isAbort = (err: unknown): boolean =>
  typeof (err as { name?: unknown })?.name === "string" && (err as { name: string }).name === "AbortError";

/**
 * A consumer that throws must not take the generation with it — the likeliest cause is a client that
 * closed its SSE stream, and the slides still in flight are worth persisting (§9's abort row).
 */
function emitSafely(deps: GenerationDeps, event: StreamEvent): void {
  try {
    deps.emit(event);
  } catch {
    // Intentionally swallowed. There is nowhere to report it: the reporting channel is what failed.
  }
}

/* ─────────────────────────────── whole deck ─────────────────────────────── */

export interface DeckGenerationResult {
  ok: number;
  failed: number;
  outcomes: SlideOutcome[];
  /** True when the client hung up. Completed slides are still in `outcomes` (§9). */
  aborted: boolean;
}

/**
 * Generate a deck: `deck-start`, slides at `concurrency`, `deck-done {ok, failed}`.
 *
 * Bounded concurrency with a shared cursor rather than chunked batches. Batches would idle every worker
 * until the slowest slide in a batch finished, and slide latency varies several-fold with content
 * length — the cursor keeps all workers busy to the end.
 *
 * Order is preserved in `outcomes` regardless of completion order (results are written by index), so
 * the caller persists slides in deck order without sorting.
 */
export async function generateDeck(
  request: DeckGenerationRequest,
  deps: GenerationDeps,
  perSlide: Omit<SlideGenerationRequest, "slideId" | "index" | "total" | "layoutId" | "source" | "briefing" | "tone" | "sectionHeading">,
): Promise<DeckGenerationResult> {
  const { jobs } = request;

  emitSafely(deps, {
    type: "deck-start", at: deps.now(), deckId: request.deckId, total: jobs.length,
  });

  const outcomes: (SlideOutcome | undefined)[] = new Array(jobs.length).fill(undefined);
  let aborted = false;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      // Checked before starting each slide, not just at the top: an abort mid-deck must stop the
      // remaining slides rather than letting every worker finish its current queue.
      if (aborted || request.signal?.aborted) { aborted = true; return; }

      const job = jobs[index]!;
      try {
        outcomes[index] = await generateSlide({
          ...perSlide,
          slideId: job.slideId,
          index,
          total: jobs.length,
          layoutId: job.mapped.decision.layoutId,
          source: job.mapped.slide,
          briefing: request.briefing,
          tone: request.tone,
          ...(job.sectionHeading !== undefined ? { sectionHeading: job.sectionHeading } : {}),
          ...(request.instruction !== undefined ? { instruction: request.instruction } : {}),
          ...(request.includeSpeakerNotes !== undefined ? { includeSpeakerNotes: request.includeSpeakerNotes } : {}),
          ...(request.density !== undefined ? { density: request.density } : {}),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        }, deps);
      } catch (err) {
        if (isAbort(err)) { aborted = true; return; }
        // `generateSlide` is total, so reaching here means a bug (a thrown `requireLayout`, say) rather
        // than a model failure. One slide's bug must not take the deck: report it in-stream and carry
        // on, which is exactly §9's per-slide isolation requirement.
        emitSafely(deps, {
          type: "slide-error", at: deps.now(), slideId: job.slideId, index,
          reason: "internal",
          message: err instanceof AppError
            ? toReadable(err).message
            : "Something went wrong generating this slide. Try regenerating it.",
        });
      }
    }
  };

  const workers = Math.max(1, Math.min(request.concurrency, jobs.length));
  await Promise.all(Array.from({ length: workers }, worker));

  const produced = outcomes.filter((o): o is SlideOutcome => o !== undefined);
  const ok = produced.filter((o) => !o.degraded).length;
  // A slide that fell back counts as failed even though content exists: the count answers "how many
  // slides need your attention", and a fallback slide does. Slides never attempted (aborted) are in
  // neither count — they are absent, not failed.
  const failed = produced.length - ok;

  emitSafely(deps, {
    type: "deck-done", at: deps.now(), deckId: request.deckId, ok, failed,
  });

  return { ok, failed, outcomes: produced, aborted };
}
