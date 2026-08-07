/**
 * `OutlineService` — generate, regenerate, and edit the deck plan (SPEC §7.1).
 *
 * ## What this layer owns
 *
 * `generateOutline` is a pure(ish) function of a briefing and a tone: one model call, validate, one
 * repair, or a readable error. It knows nothing about decks. This service is where the outline becomes
 * *part of a deck*:
 *
 *   - the briefing is read from the deck and the tone from the deck's brand, so an outline is always
 *     generated against the brand the deck will actually render with;
 *   - the result is persisted in the same call that produced it, because an outline the user has to
 *     re-request after a page reload has cost a model call for nothing;
 *   - section regeneration is spliced into the stored outline in ONE write (`generateOutlineSection`
 *     returns just a section, deliberately — see its doc).
 *
 * ## Errors pass through, they are not re-wrapped
 *
 * `generateOutline` throws `GenerationFailed` on total failure and never fabricates a plan; the
 * carry-forward note in `VERIFICATION.md` is explicit that this service must not paper over that with a
 * synthetic outline. A `ModelThrottled`/`ModelTimeout` from the adapter is likewise left alone — it is a
 * *retryable* error with a different status (503/504 vs 502), and collapsing it into `GenerationFailed`
 * would strip the retry affordance the client keys off `AppError.retryable`.
 *
 * ## Why editing lives here rather than in `DeckService`
 *
 * Outline edits (reorder a slide, move it between sections, set a `layoutOverride`) are *outline*
 * operations that happen to be stored on the deck. Putting them here keeps `DeckService` about slides
 * and keeps the layout-override validation next to the mapping preview that explains it.
 */

import type { Briefing, Outline, OutlineSection, OutlineSlide } from "@/lib/domain/deck";
import type { BrandTone } from "@/lib/brand/types";
import type { LLMPort } from "@/lib/ports/llm-port";
import { DeckNotReady, InvalidBrandConfig, InvalidRequest } from "@/lib/errors/errors";
import { clampTemperature, requireModel } from "@/lib/models/registry";
import {
  type OutlineAdvisory, describeOutlineIssues, outlineAdvisories, parseEditedOutline,
} from "@/lib/generation/outline-schema";
import { generateOutline, generateOutlineSection } from "@/lib/generation/outline-pipeline";
import type { BrandService } from "@/lib/services/brand-service";
import type { DeckService } from "@/lib/services/deck-service";
import type { LayoutMappingService } from "@/lib/services/layout-mapping-service";

export interface OutlineServiceDeps {
  decks: DeckService;
  brands: BrandService;
  mapping: LayoutMappingService;
  /**
   * Lazy, matching `Container.llm`. Constructing the Bedrock client resolves credentials, and §1.3
   * requires the app to boot and serve `/api/registry/*` with none configured — so a service that is
   * merely *constructed* must not have caused that yet.
   */
  llm: () => LLMPort;
  /** From config: `OUTLINE_MODEL_ID` falling back to `DEFAULT_LLM_MODEL_ID` (SPEC §8). */
  modelId: string;
  /** §7's `DEBUG_PROMPTS` hook, from `createPromptLogger`. Passed through to both pipelines. */
  onPrompt?: (label: string, prompt: string) => void;
}

export interface OutlineResultView {
  outline: Outline;
  /** Non-blocking quality notes for the editor's advisory strip (§12). */
  advisories: OutlineAdvisory[];
  /** True when the first response needed the repair pass — kept so the UI can be honest about it. */
  repaired: boolean;
}

export class OutlineService {
  constructor(private readonly deps: OutlineServiceDeps) {}

  /**
   * Generate the whole outline for a deck and persist it.
   *
   * `temperature` is clamped through the model registry rather than trusted: it arrives from a UI
   * slider, and `clampTemperature` also returns `undefined` for a model that does not support the
   * parameter, so the adapter omits the key instead of sending one the family would reject.
   */
  async generate(
    userId: string,
    deckId: string,
    options: { instruction?: string; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<OutlineResultView> {
    const { briefing, tone } = await this.context(userId, deckId);

    const result = await generateOutline(
      {
        briefing,
        tone,
        ...(options.instruction !== undefined ? { instruction: options.instruction } : {}),
      },
      this.pipelineDeps(options),
    );

    await this.deps.decks.saveOutline(userId, deckId, result.outline);
    return result;
  }

  /**
   * Regenerate ONE section in place (SPEC §7.1's `sectionIndex`).
   *
   * The stored outline is re-read rather than taken from the request: the editor may have been open for
   * a while, and generating a replacement section against a stale copy of its neighbours is how a
   * regenerated section ends up repeating a slide the user already deleted.
   */
  async regenerateSection(
    userId: string,
    deckId: string,
    sectionIndex: number,
    options: { instruction?: string; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<OutlineResultView> {
    const { briefing, tone, outline } = await this.requireOutline(userId, deckId);

    const { section, repaired } = await generateOutlineSection(
      {
        briefing,
        tone,
        outline,
        sectionIndex,
        ...(options.instruction !== undefined ? { instruction: options.instruction } : {}),
      },
      this.pipelineDeps(options),
    );

    const sections = [...outline.sections];
    sections[sectionIndex] = section;
    return this.persist(userId, deckId, { sections }, briefing, repaired);
  }

  /* ─────────────────────────────── editing ─────────────────────────────── */

  /**
   * Save a user-edited outline (SPEC §7.1: edit a message, reorder, set a `layoutOverride`).
   *
   * ## `unknown`, not `Outline`
   *
   * This document arrives from a request body, so a typed parameter here would be a claim the route had
   * validated it — and no route can: `parseEditedOutline` is the authority, and putting a copy of the
   * outline's shape in `lib/http` is §4's parallel table in its most damaging form (the client is told a
   * layout pin was saved that the mapping chain will ignore). Taking `unknown` and parsing HERE means
   * every caller — route, facade, script, a future importer — gets the same guarantee for free.
   *
   * Rejected with `InvalidRequest`'s field-level issues rather than `GenerationFailed`: this is a person's
   * edit, and the editor needs to know which slide is wrong. That is the same reasoning
   * `InvalidSlideContent` records for the slide editor — a model's malformed output is repaired, a
   * person's is reported.
   *
   * ## Why every `layoutOverride` is checked against the registry
   *
   * The mapping chain deliberately *ignores* an override naming an unknown layout (a layout can be removed
   * between save and generate, and neither crashing nor rendering an unknown id is acceptable), which
   * means a typo would otherwise be silently dropped with no explanation. Checking at the write is the
   * only place it can be reported.
   */
  async save(userId: string, deckId: string, input: unknown): Promise<OutlineResultView> {
    const { briefing } = await this.context(userId, deckId);

    const parsed = parseEditedOutline(input);
    if (!parsed.ok) throw InvalidRequest(describeOutlineIssues(parsed.issues));
    const outline = parsed.outline;

    for (const section of outline.sections) {
      for (const slide of section.slides) {
        if (slide.layoutOverride !== undefined) {
          this.deps.mapping.assertValidOverride(slide.layoutOverride);
        }
      }
    }
    return this.persist(userId, deckId, outline, briefing, false);
  }

  /**
   * Pin (or clear) one slide's layout. A targeted write rather than "send the whole outline back",
   * because the layout switcher is a single click and round-tripping the entire document to serve it
   * makes every concurrent edit a lost-update race.
   */
  async setLayoutOverride(
    userId: string, deckId: string, sectionIndex: number, slideIndex: number, layoutId: string | null,
  ): Promise<OutlineResultView> {
    const { briefing, outline } = await this.requireOutline(userId, deckId);
    const slide = outline.sections[sectionIndex]?.slides[slideIndex];
    if (!slide) throw outOfRange(sectionIndex, slideIndex);

    if (layoutId !== null) this.deps.mapping.assertValidOverride(layoutId);

    const updated = mapSlideAt(outline, sectionIndex, slideIndex, (s) =>
      layoutId === null ? stripOverride(s) : { ...s, layoutOverride: layoutId });

    return this.persist(userId, deckId, updated, briefing, false);
  }

  /**
   * The outline editor's read: the stored plan plus its advisories plus the mapping preview.
   *
   * One call rather than three because the three must describe the SAME outline. Fetching the plan and
   * the mapping separately lets a concurrent regenerate land between them, and the badges would then
   * explain slides that are no longer on screen.
   */
  async view(userId: string, deckId: string): Promise<OutlineResultView & {
    preview: ReturnType<LayoutMappingService["preview"]>;
  }> {
    const { briefing, outline } = await this.requireOutline(userId, deckId);
    return {
      outline,
      advisories: outlineAdvisories(outline, briefing.targetSlideCount),
      repaired: false,
      preview: this.deps.mapping.preview(outline),
    };
  }

  /* ─────────────────────────────── internals ─────────────────────────────── */

  /**
   * Persist an outline and return the view of it. Advisories are recomputed from the SAVED document
   * rather than carried from the generator, so a user edit that fixes the slide count clears its own
   * advisory — the alternative is a stale amber note on content that no longer has the problem.
   */
  private async persist(
    userId: string, deckId: string, outline: Outline, briefing: Briefing, repaired: boolean,
  ): Promise<OutlineResultView> {
    await this.deps.decks.saveOutline(userId, deckId, outline);
    return {
      outline,
      advisories: outlineAdvisories(outline, briefing.targetSlideCount),
      repaired,
    };
  }

  /**
   * Briefing + tone for a deck. Both are required to generate, and both come from stored state:
   * the briefing from the deck, the tone from the deck's brand.
   *
   * A missing briefing is `DeckNotReady`, not `GenerationFailed`: nothing upstream was called, so a 502
   * would tell the user to wait for a service that is working fine (see that constructor's note).
   */
  private async context(userId: string, deckId: string): Promise<{ briefing: Briefing; tone: BrandTone }> {
    const meta = await this.deps.decks.getMeta(userId, deckId);
    if (!meta.briefing) {
      throw DeckNotReady("Fill in the briefing before generating an outline.", { deckId });
    }
    const brand = await this.deps.brands.get(userId, meta.brandId);
    return { briefing: meta.briefing, tone: brand.tone };
  }

  private async requireOutline(
    userId: string, deckId: string,
  ): Promise<{ briefing: Briefing; tone: BrandTone; outline: Outline }> {
    const meta = await this.deps.decks.getMeta(userId, deckId);
    if (!meta.outline) {
      throw DeckNotReady("Generate an outline before editing it.", { deckId });
    }
    const { briefing, tone } = await this.context(userId, deckId);
    return { briefing, tone, outline: meta.outline };
  }

  /**
   * `OutlineDeps` for the pipeline.
   *
   * `requireModel` throws a plain `Error` for an unregistered id — deliberately, because that is *our*
   * configuration mistake (a `DEFAULT_LLM_MODEL_ID` typo), and letting it surface as an `Internal` 500
   * with the valid ids in the log is more useful than a 400 blaming the user's request. An UNSET id is
   * the separate `ModelNotConfigured` 503, since a deployment that was never configured is a different
   * problem from one configured wrongly, and only the first has a one-line fix.
   */
  private pipelineDeps(options: { temperature?: number; signal?: AbortSignal }) {
    const model = requireModel(this.deps.modelId);
    const temperature = clampTemperature(model, options.temperature);
    return {
      llm: this.deps.llm(),
      modelId: model.id,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(this.deps.onPrompt !== undefined ? { onPrompt: this.deps.onPrompt } : {}),
    };
  }
}

/* ─────────────────────────── pure helpers ─────────────────────────── */

const outOfRange = (sectionIndex: number, slideIndex: number) =>
  InvalidBrandConfig([`slide ${sectionIndex}.${slideIndex}: no longer exists — reload the outline`]);

/** `layoutOverride` removed rather than set to `undefined`: the field is optional, and an explicit
 * `undefined` survives a JSON round-trip as a present-but-null key in some serializers. */
const stripOverride = (slide: OutlineSlide): OutlineSlide => {
  const { layoutOverride: _dropped, ...rest } = slide;
  return rest;
};

const mapSlideAt = (
  outline: Outline, sectionIndex: number, slideIndex: number, fn: (slide: OutlineSlide) => OutlineSlide,
): Outline => ({
  sections: outline.sections.map((section, si): OutlineSection =>
    si !== sectionIndex
      ? section
      : { ...section, slides: section.slides.map((slide, li) => (li === slideIndex ? fn(slide) : slide)) }),
});
