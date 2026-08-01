/**
 * §2 step 12 — `OutlineService` against memory repos + a scripted `LLMPort`, wired through the container.
 *
 * `tests/outline-generation.test.ts` already covers the pipeline (parse, the one repair pass, the
 * no-fallback rule). What this suite asserts is what becoming *part of a deck* adds:
 *
 *   - the briefing comes from the deck and the tone from the deck's BRAND, so an outline is always
 *     generated against the brand the deck will render with;
 *   - a generated outline is persisted in the same call, because an outline the user has to re-request
 *     after a reload has cost a model call for nothing;
 *   - section regeneration re-reads the stored document and splices in ONE write;
 *   - errors pass through with their own codes — a missing briefing is 409 `DeckNotReady`, never a 502.
 */

import { describe, expect, it } from "vitest";
import type { Briefing, Outline } from "@/lib/domain/deck";
import { AppError, ModelThrottled } from "@/lib/errors/errors";
import { brandInput, harness, type Harness } from "@/tests/service-harness";

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
  targetSlideCount: 4,
};

/**
 * A deck with a brand and a briefing — the state `generate` requires.
 *
 * `briefing: null` rather than an optional parameter: passing an explicit `undefined` to a parameter
 * with a default silently gets the default back, so the no-briefing test would have asserted against a
 * deck that *had* one.
 */
async function readyDeck(h: Harness, briefing: Briefing | null = BRIEFING) {
  const brand = await h.services.brands.create(h.userId, brandInput());
  const deck = await h.services.decks.create(h.userId, {
    title: "Q3 Review",
    brandId: brand.id,
    ...(briefing !== null ? { briefing } : {}),
  });
  return { brand, deck };
}

/** Four slides across two headed sections, hinted so no advisory fires. */
const FOUR_SLIDES: Outline = {
  sections: [
    {
      heading: "Where we are",
      slides: [
        { question: "Why are we here?", message: "Billing broke repeatedly.", evidence: [], visualHint: "opening" },
        { question: "What broke?", message: "Nineteen incidents in Q3.", evidence: ["19 incidents"], visualHint: "list" },
      ],
    },
    {
      heading: "What we'll do",
      slides: [
        { question: "What's the plan?", message: "Three fixes, in order.", evidence: [], visualHint: "list" },
        { question: "What next?", message: "Approve the budget.", evidence: [], visualHint: "closing" },
      ],
    },
  ],
};

const response = (outline: Outline): string => JSON.stringify(outline);

const SECTION_RESPONSE = JSON.stringify({
  heading: "Where we are",
  slides: [
    { question: "Rewritten?", message: "A punchier claim.", evidence: [], visualHint: "list" },
  ],
});

describe("OutlineService — generate and persist", () => {
  it("persists the outline in the same call that produced it", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    h.llm.push({ text: response(FOUR_SLIDES) });

    const result = await h.services.outline.generate(h.userId, deck.id);

    expect(result.repaired).toBe(false);
    expect(result.advisories).toEqual([]);
    // The point of persisting here: a reload must not cost a second model call.
    const stored = await h.services.decks.getMeta(h.userId, deck.id);
    expect(stored.outline).toEqual(result.outline);
    expect(h.llm.remaining()).toBe(0);
  });

  it("uses the DECK's brand tone and the configured outline model", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput({
      tone: { voice: "technical", traits: ["precise"], bannedWords: ["synergy"] },
    } as never));
    const deck = await h.services.decks.create(h.userId, {
      title: "Q3", brandId: brand.id, briefing: BRIEFING,
    });
    h.llm.push({ text: response(FOUR_SLIDES) });

    await h.services.outline.generate(h.userId, deck.id);

    const [request] = h.llm.calls;
    expect(request?.modelId).toBe(h.container.config.outlineModelId);
    // The tone reached the prompt — via the brand, not a parameter. A service that took the tone from
    // the request would generate against a brand the deck does not use.
    expect(request?.prompt).toContain("synergy");
    // And §7 still holds on this path: no visual vocabulary, whatever the brand's colours are.
    expect(`${request?.system ?? ""}${request?.prompt ?? ""}`).not.toMatch(/#?FF00AA/i);
  });

  it("reports a repair without hiding it", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    // First response unparseable, second clean — the one repair pass.
    h.llm.push({ text: "I'd be happy to help! What角度 would you like?" }, { text: response(FOUR_SLIDES) });

    const result = await h.services.outline.generate(h.userId, deck.id);

    expect(result.repaired).toBe(true);           // surfaced so the UI can be honest about it
    expect(h.llm.calls).toHaveLength(2);
    await expect(h.services.decks.getMeta(h.userId, deck.id))
      .resolves.toMatchObject({ outline: result.outline });
  });

  it("surfaces advisories from the SAVED document, not the generator's copy", async () => {
    const h = harness();
    // Target 4, model returns 1 — well outside the ±2 tolerance.
    const { deck } = await readyDeck(h);
    const single: Outline = {
      sections: [{
        heading: "Only",
        slides: [{ question: "Q?", message: "M.", evidence: [], visualHint: "list" }],
      }],
    };
    h.llm.push({ text: response(single) });

    const generated = await h.services.outline.generate(h.userId, deck.id);
    expect(generated.advisories.map((a) => a.kind)).toContain("count-off-target");

    // Now the user fixes it by hand. The advisory must clear itself — a stale amber note on content
    // that no longer has the problem is exactly what `persist` recomputes to avoid.
    const fixed = await h.services.outline.save(h.userId, deck.id, FOUR_SLIDES);
    expect(fixed.advisories).toEqual([]);
  });

  it("passes a total model failure through as GenerationFailed, fabricating nothing", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    h.llm.push({ text: "no json here" }, { text: "still no json" });

    const err = await rejectsWith("GenerationFailed", () => h.services.outline.generate(h.userId, deck.id));
    expect(err.status).toBe(502);
    // No synthetic outline was written — the carry-forward note in VERIFICATION.md is explicit that this
    // service must not paper over a failure with a fabricated plan. `toMatchObject({outline: undefined})`
    // would NOT catch a write here (it treats an undefined expectation as "don't care"), so the absence
    // is asserted on the key itself.
    const stored = await h.services.decks.getMeta(h.userId, deck.id);
    expect(stored.outline).toBeUndefined();
  });

  it("leaves a retryable model error retryable", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    h.llm.push({ throws: ModelThrottled() });

    const err = await rejectsWith("ModelThrottled", () => h.services.outline.generate(h.userId, deck.id));
    // Collapsing this into GenerationFailed would strip the retry affordance the client keys off
    // `AppError.retryable`, and change a 503 into a 502.
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
  });
});

describe("OutlineService — preconditions are 409, not 502", () => {
  it("names the briefing step when there is no briefing", async () => {
    const h = harness();
    const { deck } = await readyDeck(h, null);

    const err = await rejectsWith("DeckNotReady", () => h.services.outline.generate(h.userId, deck.id));
    expect(err.status).toBe(409);
    // "Which of the three wizard steps" is the entire useful content of the error.
    expect(err.readable).toMatch(/briefing/i);
    // Nothing upstream was called — a 502 would tell the user to wait for a service that is working.
    expect(h.llm.calls).toHaveLength(0);
  });

  it("names the outline step when there is no outline yet", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);

    for (const call of [
      () => h.services.outline.view(h.userId, deck.id),
      () => h.services.outline.regenerateSection(h.userId, deck.id, 0),
      () => h.services.outline.setLayoutOverride(h.userId, deck.id, 0, 0, "quote"),
    ]) {
      const err = await rejectsWith("DeckNotReady", call);
      expect(err.readable).toMatch(/outline/i);
    }
    expect(h.llm.calls).toHaveLength(0);
  });

  it("404s another user's deck rather than leaking it", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await rejectsWith("DeckNotFound", () => h.services.outline.generate("user-b", deck.id));
  });
});

describe("OutlineService — section regeneration", () => {
  it("splices the new section in, leaving its neighbours untouched", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await h.services.outline.save(h.userId, deck.id, FOUR_SLIDES);
    h.llm.push({ text: SECTION_RESPONSE });

    const result = await h.services.outline.regenerateSection(h.userId, deck.id, 0);

    expect(result.outline.sections).toHaveLength(2);
    expect(result.outline.sections[0]?.slides[0]?.question).toBe("Rewritten?");
    // Section 1 is byte-identical — a regenerate that rebuilt the whole document would drop user edits.
    expect(result.outline.sections[1]).toEqual(FOUR_SLIDES.sections[1]);
    await expect(h.services.decks.getMeta(h.userId, deck.id))
      .resolves.toMatchObject({ outline: result.outline });
  });

  it("regenerates against the STORED outline, not a stale copy", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await h.services.outline.save(h.userId, deck.id, FOUR_SLIDES);

    // A concurrent edit deletes a slide from section 1 while the editor is open.
    const trimmed: Outline = {
      sections: [
        FOUR_SLIDES.sections[0]!,
        { ...FOUR_SLIDES.sections[1]!, slides: [FOUR_SLIDES.sections[1]!.slides[0]!] },
      ],
    };
    await h.services.outline.save(h.userId, deck.id, trimmed);

    h.llm.push({ text: SECTION_RESPONSE });
    const result = await h.services.outline.regenerateSection(h.userId, deck.id, 0);

    // The surviving section reflects the LATEST write. Generating against a stale copy is how a
    // regenerated section ends up repeating a slide the user already deleted.
    expect(result.outline.sections[1]?.slides).toHaveLength(1);
    // The prompt saw the current neighbours too.
    expect(h.llm.calls[0]?.prompt).not.toContain("Approve the budget");
  });

  it("rejects a section index that no longer exists", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await h.services.outline.save(h.userId, deck.id, FOUR_SLIDES);

    // Not a model failure — a bad request, and distinctly worded so the log doesn't confuse the two.
    const err = await rejectsWith("GenerationFailed", () =>
      h.services.outline.regenerateSection(h.userId, deck.id, 9));
    expect(err.readable).toMatch(/no longer exists/i);
    expect(h.llm.calls).toHaveLength(0);
  });
});

describe("OutlineService — editing", () => {
  it("validates every layoutOverride on save, writing nothing on a typo", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await h.services.outline.save(h.userId, deck.id, FOUR_SLIDES);

    const withTypo: Outline = {
      sections: [
        {
          ...FOUR_SLIDES.sections[0]!,
          slides: [
            FOUR_SLIDES.sections[0]!.slides[0]!,
            { ...FOUR_SLIDES.sections[0]!.slides[1]!, layoutOverride: "bulletts" },
          ],
        },
        FOUR_SLIDES.sections[1]!,
      ],
    };

    const err = await rejectsWith("UnknownLayout", () =>
      h.services.outline.save(h.userId, deck.id, withTypo));
    expect(err.status).toBe(400);
    // The mapping chain would have ignored the typo silently; nothing was persisted either.
    const stored = await h.services.decks.getMeta(h.userId, deck.id);
    expect(stored.outline).toEqual(FOUR_SLIDES);
  });

  it("accepts a valid override and reflects it in the preview", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await h.services.outline.save(h.userId, deck.id, FOUR_SLIDES);

    await h.services.outline.setLayoutOverride(h.userId, deck.id, 0, 1, "quote");

    const view = await h.services.outline.view(h.userId, deck.id);
    expect(view.outline.sections[0]?.slides[1]?.layoutOverride).toBe("quote");
    // One call, one document: the plan, its advisories, and the mapping all describe the SAME outline.
    expect(view.preview[1]?.layoutId).toBe("quote");
    expect(view.preview[1]?.overridden).toBe(true);
    expect(view.preview).toHaveLength(4);
  });

  it("removes the key entirely when an override is cleared", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await h.services.outline.save(h.userId, deck.id, FOUR_SLIDES);
    await h.services.outline.setLayoutOverride(h.userId, deck.id, 0, 1, "quote");

    const cleared = await h.services.outline.setLayoutOverride(h.userId, deck.id, 0, 1, null);

    const slide = cleared.outline.sections[0]?.slides[1] as Record<string, unknown>;
    // Deleted, not set to `undefined`: an explicit `undefined` survives a JSON round-trip as a
    // present-but-null key in some serializers, which would read as an override of `null`.
    expect(Object.hasOwn(slide, "layoutOverride")).toBe(false);

    // `setLayoutOverride` returns the plan, not the preview — the mapping is a `view` concern.
    const view = await h.services.outline.view(h.userId, deck.id);
    expect(view.preview[1]?.overridden).toBe(false);
  });

  it("rejects an override on a slide that is gone", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await h.services.outline.save(h.userId, deck.id, FOUR_SLIDES);

    const err = await rejectsWith("InvalidBrandConfig", () =>
      h.services.outline.setLayoutOverride(h.userId, deck.id, 0, 9, "quote"));
    // Names the coordinates so the editor can say WHICH row went stale, then tells the user to reload.
    expect(JSON.stringify(err.detail)).toContain("0.9");
  });

  it("does not call the model for any edit", async () => {
    const h = harness();
    const { deck } = await readyDeck(h);
    await h.services.outline.save(h.userId, deck.id, FOUR_SLIDES);
    await h.services.outline.setLayoutOverride(h.userId, deck.id, 0, 0, "agenda");
    await h.services.outline.view(h.userId, deck.id);

    // Every unscripted call throws, so this is already enforced — asserted because an edit path that
    // quietly regenerated would be a per-keystroke Bedrock bill.
    expect(h.llm.calls).toHaveLength(0);
  });
});
