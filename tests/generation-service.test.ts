/**
 * §2 step 12 — `GenerationService` against memory repos + a scripted `LLMPort`, wired through the
 * container (§6.3).
 *
 * `tests/generation-matrix.test.ts` already drives §9's eight-row matrix through the handler chain, and
 * the pipeline's fixed per-slide sequence is covered where it lives. What this suite asserts is what
 * *storage* adds — the three things the service layers on (jobs, `persist`, per-slide identity) and the
 * two consequences that only exist once slides are actually written:
 *
 *   - **persist happens BEFORE `slide-done`.** A `slide-done` for a slide that was never stored is a lie
 *     the client cannot detect, and it is the entire reason `persist` sits inside the sequence rather
 *     than after it.
 *   - **an abort leaves exactly the completed slides**, because `clearSlides` runs up front rather than
 *     at the end (§9's abort row).
 *
 * `generationConcurrency: 1` for all but one test: the scripted queue is claimed per model call, so
 * running slides in parallel makes a per-slide script harder to reason about. The concurrency path gets
 * its own test, which asserts only the ordering guarantee.
 */

import { describe, expect, it } from "vitest";
import type { Briefing, Outline, Slide } from "@/lib/domain/deck";
import type { SlideErrorEvent, StreamEvent } from "@/lib/stream/events";
import { AppError, ModelThrottled } from "@/lib/errors/errors";
import { requireLayout } from "@/lib/layouts/registry";
import { toFatalEvent } from "@/lib/services/generation-service";
import {
  brandInput, harness, recorder, slideResponseFor, typesOf, type Harness,
} from "@/tests/service-harness";

async function rejectsWith(code: string, run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (err) {
    expect(err, `expected an AppError, got ${String(err)}`).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`expected ${code}, but the call resolved`);
}

const BRIEFING: Briefing = {
  topic: "Billing reliability",
  audience: "The exec team",
  objective: "Approve the remediation budget",
  targetSlideCount: 3,
};

/**
 * Three slides across two headed sections.
 *
 * The mapping chain gives this `title` → `section_divider` → `closing` (position beats intent at the
 * ends, and slide 1 opens the second section), which is why the canned responses below are derived
 * per-layout rather than written out once — three hand-written `bullets` fixtures would produce two
 * fallbacks and the counts would read as a bug in the service.
 */
const OUTLINE: Outline = {
  sections: [
    {
      heading: "Where we are",
      slides: [
        { question: "Why are we here?", message: "Billing broke repeatedly.", evidence: ["19 incidents"], visualHint: "opening" },
      ],
    },
    {
      heading: "What we'll do",
      slides: [
        { question: "What's the plan?", message: "Three fixes, in order.", evidence: ["Fix A"], visualHint: "list" },
        { question: "What next?", message: "Approve the budget.", evidence: [], visualHint: "closing" },
      ],
    },
  ],
};

/** The layouts `OUTLINE` maps to, read from the chain rather than restated here (§4). */
const plannedLayouts = (h: Harness): string[] =>
  h.services.mapping.map(OUTLINE).map((m) => m.decision.layoutId);

/**
 * A deck with a brand, a briefing, and an outline — the state `generateDeck` requires.
 *
 * `null` rather than an omitted argument for each: passing an explicit `undefined` to a parameter with a
 * default silently gets the default back, so a "missing briefing" test would run against a deck that
 * has one.
 */
async function readyDeck(
  h: Harness, outline: Outline | null = OUTLINE, briefing: Briefing | null = BRIEFING,
) {
  const brand = await h.services.brands.create(h.userId, brandInput());
  const deck = await h.services.decks.create(h.userId, {
    title: "Q3 Review",
    brandId: brand.id,
    ...(briefing !== null ? { briefing } : {}),
  });
  if (outline !== null) await h.container.decks.updateMeta(h.userId, deck.id, { outline });
  return { brand, deck };
}

/** One clean response per planned slide, each valid for the layout that slide will be given. */
function scriptCleanDeck(h: Harness, label = "Value"): void {
  for (const layoutId of plannedLayouts(h)) {
    h.llm.push({ text: slideResponseFor(requireLayout(layoutId), label) });
  }
}

const slidesOf = (h: Harness, deckId: string): Promise<Slide[]> =>
  h.services.decks.listSlides(h.userId, deckId);

const eventsFor = (events: readonly StreamEvent[], type: StreamEvent["type"]) =>
  events.filter((e) => e.type === type);

describe("GenerationService — the happy path", () => {
  it("generates, persists, and streams one terminal event per slide", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    const { emit, events } = recorder();

    const result = await h.services.generation.generateDeck(h.userId, deck.id, { emit });

    expect(result).toMatchObject({ ok: 3, failed: 0, aborted: false });

    // Exactly one terminal event per slide, plus the deck's bookends. Deltas filtered out — their count
    // is a property of the fake's chunking, not of this service.
    expect(typesOf(events).filter((t) => t !== "slide-delta")).toEqual([
      "deck-start",
      "slide-start", "slide-done",
      "slide-start", "slide-done",
      "slide-start", "slide-done",
      "deck-done",
    ]);
    expect(eventsFor(events, "deck-start")[0]).toMatchObject({ total: 3, deckId: deck.id });
    expect(eventsFor(events, "deck-done")[0]).toMatchObject({ ok: 3, failed: 0, deckId: deck.id });
    // Deltas were forwarded, so the client sees text arriving rather than a spinner.
    expect(eventsFor(events, "slide-delta").length).toBeGreaterThan(0);

    const stored = await slidesOf(h, deck.id);
    expect(stored).toHaveLength(3);
    expect(stored.map((s) => s.order)).toEqual([0, 1, 2]);
    // The mapped layout reaches storage — the layout each slide was generated FOR is the one it renders.
    expect(stored.map((s) => s.layoutId)).toEqual(plannedLayouts(h));
    expect(stored.every((s) => s.flags.length === 0)).toBe(true);
    expect(stored.every((s) => s.issue === undefined)).toBe(true);
    expect(h.llm.remaining()).toBe(0);
  });

  it("keeps the outline entry on each slide so a later regenerate has its intent", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);

    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });

    const stored = await slidesOf(h, deck.id);
    // Stored per-slide rather than re-read from the outline at regenerate time — the user may have
    // edited or replaced the outline by then.
    expect(stored[0]?.source).toEqual(OUTLINE.sections[0]?.slides[0]);
    expect(stored[2]?.source).toEqual(OUTLINE.sections[1]?.slides[1]);
  });

  it("attaches the section heading a slide sits under, indexed over non-empty sections", async () => {
    const h = harness();
    const withEmpty: Outline = {
      sections: [
        { heading: "Dropped", slides: [] },
        OUTLINE.sections[0]!,
        OUTLINE.sections[1]!,
      ],
    };
    const { deck } = await readyDeck(h, withEmpty);
    scriptCleanDeck(h);

    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });

    // `mapOutline` skips empty sections when numbering, so the headings list must too. Indexing over ALL
    // sections would label every slide after the empty one with its neighbour's heading.
    expect(h.llm.calls[1]?.prompt).toContain("What we'll do");
    for (const call of h.llm.calls) expect(call.prompt).not.toContain("Dropped");
  });

  it("uses the configured generation model and keeps prompts free of visual vocabulary (§7)", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);

    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });

    expect(h.llm.calls).toHaveLength(3);
    for (const call of h.llm.calls) {
      expect(call.modelId).toBe(h.container.config.defaultLlmModelId);
      // The brand's tone reached the prompt (asserted in the outline suite); its colours must not,
      // whatever path they arrive by. `tests/prompt-purity.test.ts` is the exhaustive gate — this is the
      // same assertion at the seam where the brand is actually resolved from storage.
      const text = `${call.system ?? ""}${call.prompt}`;
      expect(text).not.toMatch(/#[0-9a-fA-F]{6}/);
      expect(text).not.toMatch(/FF00AA/i);
      expect(text).not.toMatch(/georgia/i);
    }
  });

  it("forwards an instruction to every slide", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);

    await h.services.generation.generateDeck(h.userId, deck.id, {
      emit: recorder().emit, instruction: "punchier",
    });

    expect(h.llm.calls.every((c) => c.prompt.includes("punchier"))).toBe(true);
  });

  it("preserves deck order when slides run concurrently", async () => {
    const h = harness({ generationConcurrency: 3 });
    const { deck } = await readyDeck(h);
    // Each slide claims its script when it starts, and slides start in job order, so the queue still
    // lines up with the plan even with three workers in flight.
    scriptCleanDeck(h);

    const result = await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });

    // `outcomes` is written by index, not by completion — so a caller persists in deck order without
    // sorting, and the stored `order` values cannot depend on which slide finished first.
    expect(result.outcomes.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(result.ok).toBe(3);
    expect((await slidesOf(h, deck.id)).map((s) => s.order)).toEqual([0, 1, 2]);
  });
});

describe("GenerationService — persist is inside the per-slide sequence", () => {
  it("stores the slide BEFORE announcing slide-done", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);

    // Interleaving, not just presence: the write and the announcement go into one log so the ORDER is
    // what's asserted. If `persist` moved after `emit`, a client acting on `slide-done` could read a
    // deck that doesn't contain the slide it was just told about.
    const log: string[] = [];
    const realPut = h.container.decks.putSlide.bind(h.container.decks);
    h.container.decks.putSlide = async (userId, deckId, slide) => {
      log.push(`persist:${slide.id}`);
      return realPut(userId, deckId, slide);
    };
    const emit = (event: StreamEvent): void => {
      if (event.type === "slide-done" || event.type === "slide-error") {
        log.push(`${event.type}:${event.slideId}`);
      }
    };

    await h.services.generation.generateDeck(h.userId, deck.id, { emit });

    const ids = (await slidesOf(h, deck.id)).map((s) => s.id);
    expect(ids).toHaveLength(3);
    expect(log).toEqual(ids.flatMap((id) => [`persist:${id}`, `slide-done:${id}`]));
  });

  it("reports a slide whose write fails as `internal` and carries on with the rest", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    const { emit, events } = recorder();

    // Fail the SECOND write only. A failed persist means the slide does not exist, so there is no honest
    // outcome to return — the pipeline turns it into that slide's error and the deck continues (§9).
    const realPut = h.container.decks.putSlide.bind(h.container.decks);
    let writes = 0;
    h.container.decks.putSlide = async (userId, deckId, slide) => {
      writes += 1;
      if (writes === 2) throw new Error("ENOSPC: no space left on device");
      return realPut(userId, deckId, slide);
    };

    const result = await h.services.generation.generateDeck(h.userId, deck.id, { emit });

    const errors = eventsFor(events, "slide-error") as SlideErrorEvent[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ reason: "internal", index: 1 });
    // Readable, not a raw error string — §13 requires in-stream errors to be user-facing.
    expect(errors[0]?.message).not.toContain("ENOSPC");
    expect(errors[0]?.message).toMatch(/try regenerating/i);

    // The other two slides are stored, and the counts describe only what was produced.
    expect(await slidesOf(h, deck.id)).toHaveLength(2);
    expect(result).toMatchObject({ ok: 2, failed: 0 });
    expect(eventsFor(events, "deck-done")[0]).toMatchObject({ ok: 2, failed: 0 });
  });

  it("counts a fallback slide as failed even though content exists", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    const [first, , third] = plannedLayouts(h);
    // Slide 1: unparseable, then an unparseable repair → fallback. Its neighbours are clean.
    h.llm.push({ text: slideResponseFor(requireLayout(first!)) });
    h.llm.push({ text: "I'd be happy to help!" }, { text: "still not JSON" });
    h.llm.push({ text: slideResponseFor(requireLayout(third!)) });
    const { emit, events } = recorder();

    const result = await h.services.generation.generateDeck(h.userId, deck.id, { emit });

    // `failed` answers "how many slides need your attention", and a fallback slide does.
    expect(result).toMatchObject({ ok: 2, failed: 1 });
    expect(eventsFor(events, "deck-done")[0]).toMatchObject({ ok: 2, failed: 1 });

    const stored = await slidesOf(h, deck.id);
    expect(stored).toHaveLength(3);            // never a blank slide, never a missing one (§0.4)
    const degraded = stored[1]!;
    expect(degraded.flags).toContain("fallback");
    expect(degraded.issue?.reason).toBe("repair-failed");
    // The fallback SWITCHES layout, and the stored layout is the one that was actually filled. Storing
    // the layout it was asked for would render slots that don't match the slide's zones.
    expect(degraded.layoutId).toBe("bullets");
    expect(degraded.slots.items).toBeDefined();
    // Built from the outline entry, not from anything the model returned.
    expect(degraded.slots.title).toBe(OUTLINE.sections[1]?.slides[0]?.question);
  });

  it("keeps the rest of the deck going when one slide's model call fails", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    const [first, , third] = plannedLayouts(h);
    h.llm.push({ text: slideResponseFor(requireLayout(first!)) });
    // One script, not two: a `model-error` skips the repair pass (a second identical call would hit the
    // same throttle), so this slide makes exactly one model call before falling back.
    h.llm.push({ throws: ModelThrottled() });
    h.llm.push({ text: slideResponseFor(requireLayout(third!)) });
    const { emit, events } = recorder();

    const result = await h.services.generation.generateDeck(h.userId, deck.id, { emit });

    // §9's throttle row: that slide errors readably, the others continue, the counts stay accurate.
    expect(result).toMatchObject({ ok: 2, failed: 1 });
    const errors = eventsFor(events, "slide-error") as SlideErrorEvent[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ reason: "model-error", index: 1 });
    const stored = await slidesOf(h, deck.id);
    expect(stored).toHaveLength(3);
    expect(stored[1]?.flags).toContain("fallback");
  });
});

describe("GenerationService — regenerating the whole deck", () => {
  it("clears the previous slides instead of appending", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });
    const firstIds = (await slidesOf(h, deck.id)).map((s) => s.id);

    scriptCleanDeck(h, "Second");
    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });

    const second = await slidesOf(h, deck.id);
    expect(second).toHaveLength(3);                          // 3, not 6
    expect(second.map((s) => s.id)).not.toEqual(firstIds);   // genuinely regenerated
    expect(second.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it("clears BEFORE generating, so an abort leaves exactly the completed slides", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });

    const controller = new AbortController();
    const { emit, events } = recorder();
    // Abort once the first slide is done — mid-deck, which is §9's abort row.
    const abortingEmit = (event: StreamEvent): void => {
      emit(event);
      if (event.type === "slide-done" || event.type === "slide-error") controller.abort();
    };
    scriptCleanDeck(h, "Second");

    const result = await h.services.generation.generateDeck(h.userId, deck.id, {
      emit: abortingEmit, signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    // One slide, and it is a NEW one: clearing at the end would instead leave a mix of old and new that
    // nobody — user or code — can tell apart.
    const stored = await slidesOf(h, deck.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.order).toBe(0);
    expect(stored[0]?.slots.title).toContain("Second");
    // Slides never attempted are in NEITHER count — absent, not failed.
    expect(result).toMatchObject({ ok: 1, failed: 0 });
    expect(eventsFor(events, "slide-start")).toHaveLength(1);
  });
});

describe("GenerationService — regenerating one slide (§7.4)", () => {
  it("replaces content in place, keeping id, order and createdAt", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });
    const target = (await slidesOf(h, deck.id))[1]!;

    const at = h.clock.tick();
    h.llm.push({ text: slideResponseFor(requireLayout(target.layoutId), "Punchier") });

    const outcome = await h.services.generation.regenerateSlide(h.userId, deck.id, target.id, {
      emit: recorder().emit, instruction: "punchier",
    });

    expect(outcome).toMatchObject({ slideId: target.id, index: 0, degraded: false });
    const after = await h.services.decks.getSlide(h.userId, deck.id, target.id);
    // A new id would break every reference the open workspace holds — selection, scroll position, and
    // the SSE frames already delivered.
    expect(after.id).toBe(target.id);
    expect(after.order).toBe(target.order);
    expect(after.createdAt).toBe(target.createdAt);
    expect(after.updatedAt).toBe(at);
    expect(after.slots).not.toEqual(target.slots);
    // Its neighbours are untouched and the deck is still dense.
    expect((await slidesOf(h, deck.id)).map((s) => s.order)).toEqual([0, 1, 2]);
    expect(h.llm.calls.at(-1)?.prompt).toContain("punchier");
  });

  it("does NOT re-run the mapping chain, so a manual layout switch survives", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });

    // The user deliberately switches slide 0 away from what mapping chose.
    const target = (await slidesOf(h, deck.id))[0]!;
    expect(target.layoutId).toBe("title");
    await h.services.decks.updateSlide(h.userId, deck.id, target.id, {
      layoutId: "quote",
      slots: { quote: "A claim worth quoting", attribution: "The CFO" },
    });

    h.llm.push({ text: slideResponseFor(requireLayout("quote")) });
    await h.services.generation.regenerateSlide(h.userId, deck.id, target.id, { emit: recorder().emit });

    // Re-mapping here would silently undo the switch on every regenerate — and slide 0 would be pulled
    // back to `title` by the positional rule every single time.
    const after = await h.services.decks.getSlide(h.userId, deck.id, target.id);
    expect(after.layoutId).toBe("quote");
    expect(after.slots.quote).toBeDefined();
  });

  it("tells the model the deck's real length, not 1", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });
    const target = (await slidesOf(h, deck.id))[1]!;

    h.llm.push({ text: slideResponseFor(requireLayout(target.layoutId)) });
    await h.services.generation.regenerateSlide(h.userId, deck.id, target.id, { emit: recorder().emit });

    // `total: 1` would make the slide read as both the opening and the close, and skew scope guidance.
    expect(h.llm.calls.at(-1)?.prompt).toContain("Slide 1 of 3");
  });

  it("refuses a hand-added slide, which has no outline entry to regenerate from", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    const manual = await h.services.decks.addSlide(h.userId, deck.id, {
      layoutId: "bullets", slots: { title: "Typed by hand", items: ["A point"] },
    });

    const err = await rejectsWith("DeckNotReady", () =>
      h.services.generation.regenerateSlide(h.userId, deck.id, manual.id, { emit: recorder().emit }));
    // The prompt is built from question/message/evidence, and the fallback needs the same material — so
    // there is nothing to regenerate *from*, and the honest answer is to say so rather than invent one.
    expect(err.status).toBe(409);
    expect(err.readable).toMatch(/edit it directly/i);
    expect(h.llm.calls).toHaveLength(0);
    // And the slide the user typed is still exactly as they left it.
    await expect(h.services.decks.getSlide(h.userId, deck.id, manual.id)).resolves.toEqual(manual);
  });

  it("404s a slide that isn't in the deck", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await rejectsWith("SlideNotFound", () =>
      h.services.generation.regenerateSlide(h.userId, deck.id, "ghost", { emit: recorder().emit }));
    expect(h.llm.calls).toHaveLength(0);
  });
});

describe("GenerationService — preconditions are 409, not 502", () => {
  it("names the briefing step, then the outline step", async () => {
    const h = harness();

    const noBriefing = await readyDeck(h, null, null);
    const briefingErr = await rejectsWith("DeckNotReady", () =>
      h.services.generation.generateDeck(h.userId, noBriefing.deck.id, { emit: recorder().emit }));
    expect(briefingErr.status).toBe(409);
    expect(briefingErr.readable).toMatch(/briefing/i);

    const noOutline = await readyDeck(h, null);
    const outlineErr = await rejectsWith("DeckNotReady", () =>
      h.services.generation.generateDeck(h.userId, noOutline.deck.id, { emit: recorder().emit }));
    expect(outlineErr.readable).toMatch(/outline/i);

    // Nothing upstream was called for either — a 502 would blame a service that is working fine, and
    // tell the user to wait instead of naming the wizard step they still have to do.
    expect(h.llm.calls).toHaveLength(0);
  });

  it("refuses an outline whose sections are all empty, leaving existing slides alone", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    await h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit });

    await h.container.decks.updateMeta(h.userId, deck.id, {
      outline: { sections: [{ heading: "Empty", slides: [] }] },
    });

    const err = await rejectsWith("DeckNotReady", () =>
      h.services.generation.generateDeck(h.userId, deck.id, { emit: recorder().emit }));
    expect(err.readable).toMatch(/no slides/i);
    // The emptiness check runs BEFORE `clearSlides`, so a bad outline cannot destroy a good deck.
    expect(await slidesOf(h, deck.id)).toHaveLength(3);
  });

  it("404s another user's deck", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);

    await rejectsWith("DeckNotFound", () =>
      h.services.generation.generateDeck("user-b", deck.id, { emit: recorder().emit }));
    // Not even a model call: user scoping is checked on the read that starts the job.
    expect(h.llm.calls).toHaveLength(0);
    expect(await slidesOf(h, deck.id)).toEqual([]);
  });
});

describe("toFatalEvent", () => {
  it("renders a readable message and carries the supplied timestamp", () => {
    expect(toFatalEvent(ModelThrottled(), 1_700_000_000_000)).toEqual({
      type: "fatal",
      at: 1_700_000_000_000,
      message: ModelThrottled().readable,
    });
  });

  it("collapses an unknown throw rather than leaking it into the stream", () => {
    const event = toFatalEvent(new Error("ECONNRESET at /var/task/index.js:42"), 1);
    expect(event.type).toBe("fatal");
    // §13: in-stream errors are user-facing. A raw SDK string or a server path must never reach one.
    expect((event as { message: string }).message).not.toContain("/var/task");
    expect((event as { message: string }).message).not.toContain("ECONNRESET");
  });
});
