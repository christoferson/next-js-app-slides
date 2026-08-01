/**
 * `GenerationService` — outline → persisted slides, streamed (SPEC §7.3).
 *
 * ## The three things this layer adds to `pipeline.ts`
 *
 *  1. **Jobs.** The pipeline never decides a layout; it is handed `MappedSlide`s. This service runs the
 *     mapping chain over the stored outline, allocates a slide id per entry, and attaches the section
 *     heading each slide sits under.
 *  2. **`persist`.** SPEC §7.3 puts persistence inside the fixed per-slide sequence, and the pipeline
 *     exposes it as a callback precisely so it can stay free of any repository (see that file's header).
 *     This is the callback: `SlideOutcome` → a `Slide` record, written before `slide-done` is emitted.
 *  3. **Identity that the pipeline cannot know.** `order`, `createdAt`, and the outline `source` are
 *     per-slide facts held here — which is why `slidePlan` is a map rather than derived from
 *     `outcome.index`: on the regenerate path the index is 0 and the order is wherever the slide sits.
 *
 * ## What this layer deliberately does NOT do
 *
 * **No second try/catch around the deck.** Per-slide isolation already lives in `generateDeck`: a slide
 * that fails is reported in-stream with its own `reason` and the deck carries on. Wrapping the call in
 * another catch here would collapse those distinct reasons into one, which is exactly what §9's
 * "`deck-done {ok, failed}` accurate" row is checking against.
 *
 * **No fabricated content.** Everything degraded comes from the handler chain's fallback, built from the
 * outline entry. This service adds nothing of its own.
 *
 * ## Why generating clears the deck's slides first
 *
 * A regenerate-the-whole-deck against a deck that already has slides would otherwise append, doubling
 * it. Clearing up front (rather than after) means an abort mid-run leaves exactly the slides that were
 * produced — §9's "remaining slides stop; completed slides persisted" — instead of a mix of old and new
 * that no one can tell apart.
 */

import type { Briefing, Outline, OutlineSlide, Slide } from "@/lib/domain/deck";
import type { BrandTone } from "@/lib/brand/types";
import type { DeckRepository } from "@/lib/ports";
import type { LLMPort } from "@/lib/ports/llm-port";
import type { StreamEvent } from "@/lib/stream/events";
import { DeckNotReady, toReadable } from "@/lib/errors/errors";
import { clampTemperature, requireModel } from "@/lib/models/registry";
import {
  type DeckGenerationResult, type EmitFn, type SlideJob, type SlideOutcome,
  generateDeck, generateSlide,
} from "@/lib/generation/pipeline";
import type { BrandService } from "@/lib/services/brand-service";
import type { DeckService } from "@/lib/services/deck-service";
import type { LayoutMappingService } from "@/lib/services/layout-mapping-service";

export interface GenerationServiceDeps {
  /**
   * The repository directly, not `DeckService`. `persist` runs inside the per-slide sequence and writes
   * a record whose `flags`/`issue`/`order` are already decided by the pipeline — routing it through
   * `DeckService.addSlide` would re-run budget enforcement on content that was deliberately truncated
   * and flagged, and would reassign the order it was given.
   */
  slides: DeckRepository;
  decks: DeckService;
  brands: BrandService;
  mapping: LayoutMappingService;
  /** Lazy, matching `Container.llm` — see `OutlineService` for why construction must not be eager. */
  llm: () => LLMPort;
  modelId: string;
  concurrency: number;
  now: () => number;
  newId: () => string;
  /** §7's `DEBUG_PROMPTS` hook. Passed through so the pipeline's repair prompts are logged too. */
  onPrompt?: (label: string, prompt: string) => void;
}

export interface GenerateDeckOptions {
  emit: EmitFn;
  instruction?: string;
  includeSpeakerNotes?: boolean;
  density?: "concise" | "standard" | "detailed";
  temperature?: number;
  signal?: AbortSignal;
}

/** What one slide's persistence needs that the pipeline has no way to know. */
interface SlidePlan {
  order: number;
  source: OutlineSlide;
  createdAt: string;
}

export class GenerationService {
  constructor(private readonly deps: GenerationServiceDeps) {}

  /**
   * Generate every slide in the deck's outline.
   *
   * Returns the pipeline's `{ ok, failed, outcomes, aborted }` unchanged. The counts are the ones
   * already announced on `deck-done`, so a caller that logs them cannot disagree with what the client
   * was told.
   */
  async generateDeck(
    userId: string, deckId: string, options: GenerateDeckOptions,
  ): Promise<DeckGenerationResult> {
    const { briefing, tone, outline } = await this.context(userId, deckId);

    const at = this.stamp();
    const plans = new Map<string, SlidePlan>();
    const jobs: SlideJob[] = [];

    const headings = outline.sections.filter((s) => s.slides.length > 0).map((s) => s.heading);
    for (const mapped of this.deps.mapping.map(outline)) {
      const slideId = this.deps.newId();
      const heading = headings[mapped.position.sectionIndex];
      jobs.push({
        mapped,
        slideId,
        ...(heading !== undefined && heading.trim() !== "" ? { sectionHeading: heading } : {}),
      });
      plans.set(slideId, { order: mapped.position.index, source: mapped.slide, createdAt: at });
    }

    if (jobs.length === 0) {
      throw DeckNotReady("This outline has no slides. Regenerate it, or add slides directly.", { deckId });
    }

    await this.clearSlides(userId, deckId);

    const model = requireModel(this.deps.modelId);
    const temperature = clampTemperature(model, options.temperature);

    return generateDeck(
      {
        deckId,
        briefing,
        tone,
        jobs,
        concurrency: this.deps.concurrency,
        ...(options.instruction !== undefined ? { instruction: options.instruction } : {}),
        ...(options.includeSpeakerNotes !== undefined ? { includeSpeakerNotes: options.includeSpeakerNotes } : {}),
        ...(options.density !== undefined ? { density: options.density } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      this.pipelineDeps(userId, deckId, plans, options.emit),
      {
        modelId: model.id,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
  }

  /**
   * Regenerate ONE slide, optionally with an instruction ("punchier") — SPEC §7.4.
   *
   * The slide keeps its `id`, `order`, and `createdAt`: this is an in-place replacement, and a new id
   * would break every reference the open workspace holds (selection, scroll position, the SSE frames
   * already delivered).
   *
   * The layout is re-derived from the stored slide rather than re-mapped. The user may have switched it
   * deliberately, and re-running the mapping chain here would silently undo that on every regenerate.
   */
  async regenerateSlide(
    userId: string,
    deckId: string,
    slideId: string,
    options: GenerateDeckOptions,
  ): Promise<SlideOutcome> {
    const { briefing, tone } = await this.context(userId, deckId);
    const slide = await this.deps.decks.getSlide(userId, deckId, slideId);

    // Without the outline entry there is no content source: the prompt is built from question, message,
    // and evidence, and the fallback needs the same material. A slide added by hand has none.
    if (!slide.source) {
      throw DeckNotReady(
        "This slide wasn't generated from an outline, so there's nothing to regenerate from. Edit it directly.",
        { deckId, slideId },
      );
    }

    const model = requireModel(this.deps.modelId);
    const temperature = clampTemperature(model, options.temperature);
    const plans = new Map<string, SlidePlan>([
      [slideId, { order: slide.order, source: slide.source, createdAt: slide.createdAt }],
    ]);

    return generateSlide(
      {
        slideId,
        // Both halves of "slide 4 of 12" are the deck's, not this call's. `index: 0` with a real `total`
        // would tell the model every regenerated slide is the deck's opener — the same failure as
        // `total: 1`, in the other coordinate — so the slide's own position is what goes in.
        index: slide.order,
        total: await this.slideCount(userId, deckId),
        layoutId: slide.layoutId,
        source: slide.source,
        briefing,
        tone,
        modelId: model.id,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(options.instruction !== undefined ? { instruction: options.instruction } : {}),
        ...(options.includeSpeakerNotes !== undefined ? { includeSpeakerNotes: options.includeSpeakerNotes } : {}),
        ...(options.density !== undefined ? { density: options.density } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      this.pipelineDeps(userId, deckId, plans, options.emit),
    );
  }

  /* ─────────────────────────────── internals ─────────────────────────────── */

  private stamp(): string {
    return new Date(this.deps.now()).toISOString();
  }

  /**
   * `GenerationDeps`, with `persist` closed over this run's plans.
   *
   * A `slideId` with no plan is a bug rather than a recoverable state — the plans are built from the
   * same jobs the pipeline is handed. It throws, and the pipeline turns that into that slide's
   * `internal` error while the rest of the deck continues (see `generateSlide`'s doc on the two cases
   * it does not swallow).
   */
  private pipelineDeps(
    userId: string, deckId: string, plans: ReadonlyMap<string, SlidePlan>, emit: EmitFn,
  ) {
    return {
      llm: this.deps.llm(),
      now: this.deps.now,
      newId: this.deps.newId,
      emit,
      ...(this.deps.onPrompt !== undefined ? { onPrompt: this.deps.onPrompt } : {}),
      persist: async (outcome: SlideOutcome): Promise<void> => {
        const plan = plans.get(outcome.slideId);
        if (!plan) throw new Error(`No slide plan for "${outcome.slideId}" — generation wiring bug.`);
        await this.deps.slides.putSlide(userId, deckId, toSlide(outcome, plan, this.stamp()));
      },
    };
  }

  /**
   * Briefing, tone, and outline — all three required to generate, all three from stored state.
   *
   * Each absence gets its own message naming the step to do next, rather than one generic "deck isn't
   * ready": the wizard has three stages and "which one" is the entire useful content of the error.
   */
  private async context(
    userId: string, deckId: string,
  ): Promise<{ briefing: Briefing; tone: BrandTone; outline: Outline }> {
    const meta = await this.deps.decks.getMeta(userId, deckId);
    if (!meta.briefing) {
      throw DeckNotReady("Fill in the briefing before generating slides.", { deckId });
    }
    if (!meta.outline) {
      throw DeckNotReady("Generate an outline before generating slides.", { deckId });
    }
    const brand = await this.deps.brands.get(userId, meta.brandId);
    return { briefing: meta.briefing, tone: brand.tone, outline: meta.outline };
  }

  private async slideCount(userId: string, deckId: string): Promise<number> {
    const slides = await this.deps.slides.listSlides(userId, deckId);
    return Math.max(1, slides.length);
  }

  /**
   * Remove the deck's existing slides. Sequential rather than `Promise.all`: the file backend takes a
   * per-deck lock (§6.5), so a parallel delete would serialize on the lock anyway while making a
   * partial failure much harder to reason about.
   */
  private async clearSlides(userId: string, deckId: string): Promise<void> {
    for (const slide of await this.deps.slides.listSlides(userId, deckId)) {
      await this.deps.slides.deleteSlide(userId, deckId, slide.id);
    }
  }
}

/* ─────────────────────────── pure helpers ─────────────────────────── */

/**
 * `SlideOutcome` + plan → the stored record.
 *
 * `layoutId` comes from the CONTENT, not the job: the fallback handler switches to `bullets` when the
 * mapped layout could not be filled, and storing the layout it was *asked* for would render a slide
 * whose slots do not match its zones.
 */
function toSlide(outcome: SlideOutcome, plan: SlidePlan, updatedAt: string): Slide {
  const { content } = outcome;
  return {
    id: outcome.slideId,
    order: plan.order,
    layoutId: content.layoutId,
    slots: content.slots,
    ...(content.speakerNotes !== undefined ? { speakerNotes: content.speakerNotes } : {}),
    // Kept so a later regenerate has the slide's intent without re-reading the outline — which the user
    // may have edited or the deck may no longer have.
    source: plan.source,
    flags: content.flags,
    ...(content.issue !== undefined ? { issue: content.issue } : {}),
    createdAt: plan.createdAt,
    updatedAt,
  };
}

/**
 * Turn a thrown error into the one `fatal` frame a stream may end with (§13: readable in-stream).
 *
 * Here rather than in the route because the mapping from `AppError` to readable text is a service-layer
 * decision and the route is meant to be thin — and because both the deck and single-slide streams need
 * it, so a copy in each is a copy that will drift.
 */
export function toFatalEvent(err: unknown, at: number): StreamEvent {
  return { type: "fatal", at, message: toReadable(err).message };
}
