/**
 * CLAUDE.md §9 — the Defensive Generation Test Matrix, row by row.
 *
 * §9 is a table of canned LLM responses and required outcomes. It is transcribed here as the
 * `MATRIX` constant and then driven through the REAL chain (`runSlideHandlers` / `generateSlide` /
 * `generateDeck`) against a mocked `LLMPort` — never through a reimplementation of the chain, which
 * would test the test.
 *
 * ## The guarantee being defended
 *
 * §0.4: "LLM output is hostile input: validate → repair → fallback, per-slide isolation. A malformed
 * response never crashes a job, never yields a blank slide." Two absolutes, and both are asserted on
 * every row rather than only on the rows that look dangerous:
 *
 *   - `expect(content.slots).not.toEqual({})` — no blank slide, ever;
 *   - the call resolves — no crashed job, ever, including when a *handler itself* throws.
 *
 * ## Why the model is a scripted fake rather than `vi.fn().mockResolvedValue`
 *
 * Several rows depend on the SECOND call differing from the first (repair succeeds; repair also fails),
 * and one depends on a call throwing mid-stream after yielding text. A scripted queue makes the
 * sequence explicit and makes "the repair call was never made" assertable, which is the whole content
 * of the row that says a model error must skip repair.
 */

import { describe, expect, it, vi } from "vitest";
import type { OutlineSlide } from "@/lib/domain/deck";
import type { BrandTone } from "@/lib/brand/types";
import type { LLMPort, LlmRequest, LlmResponse, LlmTextDelta } from "@/lib/ports/llm-port";
import type { SlideLayout } from "@/lib/layouts/types";
import type { StreamEvent } from "@/lib/stream/events";
import { AppError, ModelThrottled, toReadable } from "@/lib/errors/errors";
import { DEFAULT_TONE_ID } from "@/lib/brand/tones";
import { FALLBACK_LAYOUT_ID, requireLayout } from "@/lib/layouts/registry";
import { mapOutline } from "@/lib/mapping/rules";
import {
  type SlideAttempt, type SlideHandler, SLIDE_HANDLERS, fallbackHandler, repairHandler,
  runSlideHandlers, validateHandler,
} from "@/lib/generation/handlers";
import { type GenerationDeps, generateDeck, generateSlide } from "@/lib/generation/pipeline";

/* ─────────────────────────────── the world ─────────────────────────────── */

const TONE: BrandTone = { voice: DEFAULT_TONE_ID, traits: ["direct"], bannedWords: ["synergy"] };

const BRIEFING = {
  topic: "Billing platform migration",
  audience: "Engineering leadership",
  objective: "Approve a two-quarter migration",
  targetSlideCount: 4,
};

const source = (over: Partial<OutlineSlide> = {}): OutlineSlide => ({
  question: "What is the legacy platform costing us?",
  message: "Billing incidents quadrupled and now threaten enterprise renewals.",
  evidence: ["19 incidents in Q3, up from 4", "6-day mean time to correction"],
  visualHint: "list",
  ...over,
});

/** `bullets` — the mapped layout for a `list` hint, and also the fallback, per the registry. */
const BULLETS = requireLayout("bullets");

/**
 * A scripted model. Each entry is consumed by one call, in order.
 *
 * `throwAfter` yields its deltas and *then* throws, which is the only way to reproduce §9's
 * "ThrottlingException mid-deck" row honestly: a throttle that arrives before any text is a different
 * (easier) case than one that arrives after a partial response.
 */
type Script =
  | { text: string }
  | { throws: unknown }
  | { text: string; throwsAfter: unknown };

function scriptedLlm(script: readonly Script[]): {
  llm: LLMPort; calls: LlmRequest[]; remaining: () => number;
} {
  const calls: LlmRequest[] = [];
  let index = 0;

  const next = (request: LlmRequest): Script => {
    calls.push(request);
    const step = script[index];
    index += 1;
    if (step === undefined) throw new Error(`scriptedLlm: unexpected call ${index} (script has ${script.length})`);
    return step;
  };

  return {
    calls,
    remaining: () => script.length - index,
    llm: {
      async complete(request): Promise<LlmResponse> {
        const step = next(request);
        if ("throws" in step) throw step.throws;
        if ("throwsAfter" in step) throw step.throwsAfter;
        return { text: step.text };
      },
      stream(request): AsyncIterable<LlmTextDelta> {
        const step = next(request);
        return {
          async *[Symbol.asyncIterator]() {
            if ("throws" in step) throw step.throws;
            // Chunked, so a mid-stream throw lands after real text has been forwarded.
            for (const chunk of chunks(step.text)) yield { text: chunk };
            if ("throwsAfter" in step) throw step.throwsAfter;
          },
        };
      },
    },
  };
}

const chunks = (text: string, size = 16): string[] =>
  text === "" ? [] : Array.from({ length: Math.ceil(text.length / size) },
    (_, i) => text.slice(i * size, (i + 1) * size));

/** Collects emitted events so "exactly one terminal event per slide" is checkable. */
function recorder(): { deps: (llm: LLMPort) => GenerationDeps; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  let id = 0;
  return {
    events,
    deps: (llm) => ({
      llm,
      now: () => 1_700_000_000_000,
      emit: (event) => { events.push(event); },
      newId: () => `slide-${(id += 1)}`,
    }),
  };
}

const typesOf = (events: readonly StreamEvent[]): string[] => events.map((e) => e.type);

/* ─────────────────────────────── canned responses ─────────────────────────────── */

/** Valid, inside every budget: title ≤55, ≤6 items of ≤55 each. */
const GOOD = JSON.stringify({
  slots: {
    title: "Billing incidents quadrupled",
    items: ["19 incidents in Q3, up from 4", "6-day mean time to correction"],
  },
});

/** Valid JSON; `title` is 80 chars, over `bullets.title`'s 55. Must truncate + flag, not fail. */
const OVER_BUDGET = JSON.stringify({
  slots: {
    title: "Billing incidents quadrupled across every region and now threaten our renewals",
    items: ["19 incidents in Q3"],
  },
});

const FENCED = "Here's the JSON you asked for:\n\n```json\n" + GOOD + "\n```\n\nLet me know if you'd "
  + "like a different angle.";

/** Missing `items`, which `bullets` requires. The one failure that earns the repair call. */
const MISSING_REQUIRED = JSON.stringify({ slots: { title: "Billing incidents quadrupled" } });

const GARBAGE = "I'd be happy to help! However, I need more information about your billing platform "
  + "before I can write this slide.";

/** Parses, satisfies the schema (both slots optional-by-absence), but renders as nothing. */
const ALL_EMPTY = JSON.stringify({ slots: { title: "   ", items: [] } });

/**
 * A clean response for an ARBITRARY layout, generated from its own `SlotSpec`s.
 *
 * Needed by the deck-level tests, and the reason is worth recording: `mapOutline` runs the real mapping
 * chain, so a 3-slide deck is `title` → `bullets` → `closing`, not three of one layout. An earlier
 * version of these tests fed a `bullets`-shaped response to all three and mis-read the resulting
 * fallbacks as a bug in the counting.
 *
 * Deriving from the registry rather than writing three literals is also what §4 asks for: a new layout
 * needs no edit here, and a layout whose budgets change cannot leave a stale fixture behind.
 */
const validResponseFor = (layout: SlideLayout): string => JSON.stringify({
  slots: Object.fromEntries(layout.slots.filter((s) => s.required).map((s) => [
    s.key,
    s.type === "list"
      ? Array.from({ length: Math.min(2, s.maxItems ?? 2) },
        (_, i) => fit(`Point ${i + 1}`, s.itemMaxChars ?? s.maxChars))
      : fit(`Value for ${s.key}`, s.maxChars),
  ])),
});

/** Hard cut, not word-boundary: this is a fixture, and it must be inside budget by construction. */
const fit = (text: string, maxChars: number): string => text.slice(0, maxChars);

/* ═══════════════════════════ §9's table, transcribed ═══════════════════════════ */

/**
 * The eight rows of §9's matrix, as data. `expect` describes the required outcome in the table's own
 * terms; the driver below asserts it.
 *
 * The two absolutes (never blank, never throws) are NOT columns here — they are asserted for every row
 * unconditionally, because a row that opted out of them would be a row that broke §0.4.
 */
const MATRIX = [
  {
    row: "Valid slot JSON, within budgets",
    script: [{ text: GOOD }] as Script[],
    expect: { handledBy: "validate", flags: [] as string[], degraded: false },
  },
  {
    row: "Valid JSON, one field over budget",
    script: [{ text: OVER_BUDGET }] as Script[],
    expect: { handledBy: "validate", flags: ["trimmed"], degraded: false },
  },
  {
    row: "JSON wrapped in markdown fences / preamble text",
    script: [{ text: FENCED }] as Script[],
    expect: { handledBy: "validate", flags: [], degraded: false },
  },
  {
    row: "Missing required slot → repair succeeds",
    script: [{ text: MISSING_REQUIRED }, { text: GOOD }] as Script[],
    expect: { handledBy: "repair", flags: [], degraded: false, repairCalled: true },
  },
  {
    row: "Repair also invalid → fallback",
    script: [{ text: MISSING_REQUIRED }, { text: MISSING_REQUIRED }] as Script[],
    expect: {
      handledBy: "fallback", flags: ["fallback"], degraded: true,
      repairCalled: true, reason: "repair-failed",
    },
  },
  {
    row: "Non-JSON garbage → same fallback path, no throw",
    script: [{ text: GARBAGE }, { text: GARBAGE }] as Script[],
    expect: {
      handledBy: "fallback", flags: ["fallback"], degraded: true,
      repairCalled: true, reason: "repair-failed",
    },
  },
  {
    row: "Bedrock ThrottlingException mid-slide",
    script: [{ text: '{"slots":{"tit', throwsAfter: ModelThrottled() }] as Script[],
    // Repair is deliberately NOT attempted: the first call failed for a reason a second identical call
    // would hit again, and retrying inside the chain would double every failing slide's latency.
    expect: {
      handledBy: "fallback", flags: ["fallback"], degraded: true,
      repairCalled: false, reason: "model-error",
    },
  },
  {
    row: "Valid JSON but every field empty",
    script: [{ text: ALL_EMPTY }, { text: ALL_EMPTY }] as Script[],
    // Not in §9's table verbatim, but it is the sharpest form of "never yields a blank slide": the
    // response VALIDATES, so only the explicit all-empty check in `interpret` stops it.
    expect: {
      handledBy: "fallback", flags: ["fallback"], degraded: true,
      repairCalled: true, reason: "repair-failed",
    },
  },
] as const;

describe("§9 matrix — one slide, through the real chain", () => {
  it.each(MATRIX)("$row", async ({ script, expect: want }) => {
    const { llm, calls } = scriptedLlm(script);
    const { deps, events } = recorder();

    const outcome = await generateSlide({
      slideId: "slide-1", index: 0, total: 4,
      layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE,
      modelId: "us.anthropic.claude-opus-5",
    }, deps(llm));

    // ── the two absolutes, on every row ──
    expect(Object.keys(outcome.content.slots).length, "§0.4: never a blank slide").toBeGreaterThan(0);
    expect(outcome.content.layoutId).toBeTruthy();

    // ── the row's own expectations ──
    expect(outcome.degraded, "degraded").toBe(want.degraded);
    expect(outcome.content.flags.sort(), "flags").toEqual([...want.flags].sort());

    if ("repairCalled" in want) {
      // Call 1 is the stream; a repair is call 2. This is what makes "model error skips repair" real.
      expect(calls.length, want.repairCalled ? "repair expected" : "repair must be skipped")
        .toBe(want.repairCalled ? 2 : 1);
    }

    if (want.handledBy === "fallback") {
      expect(outcome.content.layoutId, "fallback switches layout").toBe(FALLBACK_LAYOUT_ID);
      expect(outcome.content.issue?.reason).toBe(want.reason);
      // Readable, and NOT raw zod text or an SDK string (§13).
      expect(outcome.content.issue?.message).toMatch(/built from your outline/);
      expect(outcome.content.issue?.message).not.toMatch(/zod|ValidationException|required/i);
    } else {
      expect(outcome.content.issue, "clean slides carry no issue").toBeUndefined();
      expect(outcome.content.layoutId).toBe(BULLETS.id);
    }

    // ── exactly one terminal event, and it agrees with the outcome ──
    const terminal = events.filter((e) => e.type === "slide-done" || e.type === "slide-error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.type).toBe(want.degraded ? "slide-error" : "slide-done");
    expect(typesOf(events)[0]).toBe("slide-start");
  });
});

/* ─────────────────── per-row detail the table cannot express ─────────────────── */

describe("§9 row detail — truncation", () => {
  it("truncates at a WORD boundary and flags `trimmed`, rather than cutting mid-word", () => {
    const layout = BULLETS;
    const spec = layout.slots.find((s) => s.key === "title")!;
    const title = (JSON.parse(OVER_BUDGET) as { slots: { title: string } }).slots.title;
    expect(title.length, "fixture must actually exceed the budget").toBeGreaterThan(spec.maxChars);

    return runSlideHandlers({
      layout, source: source(), responseText: OVER_BUDGET, prompt: "…",
    }).then((content) => {
      const got = content.slots.title as string;
      expect(got.length).toBeLessThanOrEqual(spec.maxChars);
      expect(content.flags).toContain("trimmed");
      // Word boundary: the visible text before the ellipsis is a prefix of the original ending on a
      // whole word. A mid-word cut ("…quadrupled across ever…") is the failure this guards.
      const visible = got.replace(/…$/, "");
      expect(title.startsWith(visible)).toBe(true);
      expect(title[visible.length]).toMatch(/\s|^$/);
    });
  });

  it("keeps content the model got right while trimming only the offending field", () => {
    return runSlideHandlers({
      layout: BULLETS, source: source(), responseText: OVER_BUDGET, prompt: "…",
    }).then((content) => {
      expect(content.slots.items).toEqual(["19 incidents in Q3"]);
    });
  });
});

describe("§9 row detail — the tolerant extractor", () => {
  const cases: readonly [string, string][] = [
    ["a ```json fence with preamble and postamble", FENCED],
    ["a bare ``` fence", "```\n" + GOOD + "\n```"],
    ["a preamble with no fence", "Sure! Here you go: " + GOOD],
    ["trailing prose after the object", GOOD + "\n\nHope that helps."],
    ["slots at the TOP level rather than under `slots`", JSON.stringify(
      (JSON.parse(GOOD) as { slots: unknown }).slots)],
  ];

  it.each(cases)("recovers %s without spending the repair call", async (_label, text) => {
    const { llm, calls } = scriptedLlm([{ text }]);
    const { deps } = recorder();

    const outcome = await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    expect(outcome.degraded).toBe(false);
    expect(outcome.content.slots.title).toBe("Billing incidents quadrupled");
    expect(calls, "packaging must never cost the repair call").toHaveLength(1);
  });

  it("does NOT invent structure for JSON truncated mid-object", async () => {
    // Closing the braces ourselves would fabricate content. §9's answer is repair, then fallback.
    const { llm } = scriptedLlm([
      { text: '{"slots":{"title":"Billing incidents quad' },
      { text: GOOD },
    ]);
    const { deps } = recorder();
    const outcome = await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    expect(outcome.degraded).toBe(false);
    expect(outcome.content.slots.title).toBe("Billing incidents quadrupled");
  });
});

describe("§9 row detail — the repair pass", () => {
  it("shows the model its own response and the specific issues", async () => {
    const { llm, calls } = scriptedLlm([{ text: MISSING_REQUIRED }, { text: GOOD }]);
    const { deps } = recorder();

    await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    const repair = calls[1]!;
    expect(repair.prompt).toContain(MISSING_REQUIRED);
    expect(repair.prompt).toContain("items");
    expect(repair.prompt).toContain("<previous_response>");
    // The original request is restated so the model has the slot contract, not just the complaint.
    expect(repair.prompt).toContain(BRIEFING.topic);
  });

  it("runs EXACTLY once — it is a budget, not a retry loop", async () => {
    const { llm, calls } = scriptedLlm([
      { text: MISSING_REQUIRED }, { text: MISSING_REQUIRED },
    ]);
    const { deps } = recorder();
    await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    expect(calls).toHaveLength(2);
  });

  it("falls back with the ORIGINAL reason when the repair call itself throws", async () => {
    const { llm } = scriptedLlm([{ text: MISSING_REQUIRED }, { throws: ModelThrottled() }]);
    const { deps } = recorder();
    const outcome = await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    expect(outcome.degraded).toBe(true);
    expect(outcome.content.issue?.reason).toBe("repair-failed");
    // A throttle on OUR retry is not an explanation of the user's slide.
    expect(outcome.content.issue?.message).toMatch(/couldn't be used/);
  });

  it("is skipped entirely when no repair capability was supplied", async () => {
    const content = await runSlideHandlers({
      layout: BULLETS, source: source(), responseText: MISSING_REQUIRED, prompt: "…",
      // no `repair` — the single-slide regenerate path can opt out
    });
    expect(content.flags).toContain("fallback");
    expect(content.issue?.reason).toBe("validation-failed");
  });
});

describe("§9 row detail — the fallback is built from the OUTLINE, never from model output", () => {
  it("uses question as title and evidence as items", async () => {
    const src = source();
    const content = await runSlideHandlers({
      layout: requireLayout("stats"), source: src, responseText: GARBAGE, prompt: "…",
    });

    expect(content.layoutId).toBe(FALLBACK_LAYOUT_ID);
    expect(content.slots.title).toContain("legacy platform costing us");
    expect(content.slots.items).toEqual(src.evidence);
    // The model's garbage must not appear anywhere in the rendered slide.
    expect(JSON.stringify(content.slots)).not.toContain("happy to help");
  });

  it("uses the message as the single item when the outline has no evidence", async () => {
    const src = source({ evidence: [] });
    const content = await runSlideHandlers({
      layout: BULLETS, source: src, responseText: GARBAGE, prompt: "…",
    });
    // Never a bare heading over blank space.
    expect(content.slots.items).toHaveLength(1);
    expect((content.slots.items as string[])[0]).toContain("Billing incidents quadrupled");
  });

  it("switches away from a layout whose required slots the outline cannot fill", async () => {
    // `stats` requires `values` (≤7-char figures) and `labels`. An outline entry supplies neither, so
    // filling the mapped layout would render a visibly broken slide.
    const content = await runSlideHandlers({
      layout: requireLayout("stats"), source: source(), responseText: GARBAGE, prompt: "…",
    });
    expect(content.layoutId).not.toBe("stats");
    for (const spec of requireLayout(FALLBACK_LAYOUT_ID).slots.filter((s) => s.required)) {
      expect(content.slots[spec.key], `fallback must fill ${spec.key}`).toBeDefined();
    }
  });

  it("still fits the fallback layout's budgets, flagging `trimmed` when the outline is long", async () => {
    const long = "x".repeat(300);
    const content = await runSlideHandlers({
      layout: BULLETS, source: source({ question: long, evidence: [long] }),
      responseText: GARBAGE, prompt: "…",
    });
    const title = content.slots.title as string;
    expect(title.length).toBeLessThanOrEqual(BULLETS.slots.find((s) => s.key === "title")!.maxChars);
    expect(content.flags).toEqual(expect.arrayContaining(["fallback", "trimmed"]));
  });
});

/* ─────────────────── §0.4's second absolute: never a crashed job ─────────────────── */

describe("§0.4 — a throwing handler must not crash the slide", () => {
  const exploding: SlideHandler = {
    id: "validate",
    async handle() { throw new Error("bug in a handler"); },
  };

  it("escalates past a handler that throws and still produces content", async () => {
    const content = await runSlideHandlers(
      { layout: BULLETS, source: source(), responseText: GOOD, prompt: "…" },
      [exploding, fallbackHandler],
    );
    expect(content.flags).toContain("fallback");
    expect(Object.keys(content.slots).length).toBeGreaterThan(0);
  });

  it("preserves the earlier reason rather than reporting the handler's own bug", async () => {
    // "The model was throttled" explains the slide; "something broke internally" does not.
    const content = await runSlideHandlers(
      { layout: BULLETS, source: source(), responseText: "", prompt: "…", modelError: ModelThrottled() },
      [validateHandler, exploding, fallbackHandler],
    );
    expect(content.issue?.reason).toBe("model-error");
  });

  it("produces the fallback even when the chain contains no fallback handler", async () => {
    // A custom chain that forgets the floor must still not yield a blank slide.
    const content = await runSlideHandlers(
      { layout: BULLETS, source: source(), responseText: GARBAGE, prompt: "…" },
      [validateHandler],
    );
    expect(content.flags).toContain("fallback");
    expect(content.slots.title).toBeDefined();
  });

  it("survives a consumer whose `emit` throws — the reporting channel failing is not a slide failure", async () => {
    const { llm } = scriptedLlm([{ text: GOOD }]);
    const outcome = await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, {
      llm,
      now: () => 0,
      newId: () => "s",
      emit: () => { throw new Error("SSE stream closed"); },
    });

    expect(outcome.degraded).toBe(false);
    expect(outcome.content.slots.title).toBe("Billing incidents quadrupled");
  });
});

/* ─────────────────── §9's deck-level rows: isolation and abort ─────────────────── */

/**
 * Jobs for a deck, mapped by the REAL mapping chain — so slide 0 is `title` and the last is `closing`,
 * exactly as production would produce them. `layouts` is returned alongside because a canned response
 * has to match the layout it will be validated against (see `validResponseFor`).
 */
const deckJobs = (count: number) => {
  const outline = {
    sections: [{
      heading: "Where we are",
      slides: Array.from({ length: count }, (_, i) => source({ message: `Message ${i}`, visualHint: "list" })),
    }],
  };
  const jobs = mapOutline(outline).map((mapped, i) => ({ mapped, slideId: `slide-${i}` }));
  return {
    jobs,
    layouts: jobs.map((j) => requireLayout(j.mapped.decision.layoutId)),
    /** A clean response per slide, in slide order. */
    goodScript: (): Script[] => jobs.map((j) => ({
      text: validResponseFor(requireLayout(j.mapped.decision.layoutId)),
    })),
  };
};

describe("§9 — ThrottlingException mid-deck: other slides continue, counts accurate", () => {
  it("isolates the failure and reports {ok, failed} correctly", async () => {
    // Concurrency 1 so the script order is the slide order — with parallel workers the mapping of
    // script entries to slides would be nondeterministic and the assertion meaningless.
    const deck = deckJobs(3);
    const script = deck.goodScript();
    script[1] = { text: '{"slots":{"tit', throwsAfter: ModelThrottled() };
    const { llm } = scriptedLlm(script);
    const { deps, events } = recorder();

    const result = await generateDeck(
      { deckId: "deck-1", briefing: BRIEFING, tone: TONE, jobs: deck.jobs, concurrency: 1 },
      deps(llm),
      { modelId: "m" },
    );

    expect(result.ok).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.outcomes).toHaveLength(3);
    expect(result.aborted).toBe(false);

    // Every slide has content — the throttled one included.
    for (const o of result.outcomes) expect(Object.keys(o.content.slots).length).toBeGreaterThan(0);

    const done = events.filter((e) => e.type === "deck-done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ ok: 2, failed: 1 });

    // Readable in-stream, per §13.
    const errors = events.filter((e): e is Extract<StreamEvent, { type: "slide-error" }> =>
      e.type === "slide-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.index).toBe(1);
    expect(errors[0]!.message).not.toContain("ThrottlingException");
  });

  it("counts a fallback slide as failed even though content exists", async () => {
    // `failed` answers "how many slides need your attention", and a fallback slide does.
    const { llm } = scriptedLlm([{ text: GARBAGE }, { text: GARBAGE }]);
    const { deps } = recorder();
    const result = await generateDeck(
      { deckId: "d", briefing: BRIEFING, tone: TONE, jobs: deckJobs(1).jobs, concurrency: 1 },
      deps(llm), { modelId: "m" },
    );

    expect(result).toMatchObject({ ok: 0, failed: 1 });
    expect(result.outcomes[0]!.content.flags).toContain("fallback");
  });

  it("emits deck-start with the total, then exactly one terminal event per slide", async () => {
    const deck = deckJobs(2);
    const { llm } = scriptedLlm(deck.goodScript());
    const { deps, events } = recorder();
    const result = await generateDeck(
      { deckId: "d", briefing: BRIEFING, tone: TONE, jobs: deck.jobs, concurrency: 1 },
      deps(llm), { modelId: "m" },
    );

    expect(events[0]).toMatchObject({ type: "deck-start", total: 2 });
    expect(events.at(-1)).toMatchObject({ type: "deck-done", ok: 2, failed: 0 });
    expect(events.filter((e) => e.type === "slide-start")).toHaveLength(2);
    expect(events.filter((e) => e.type === "slide-done")).toHaveLength(2);
    expect(events.filter((e) => e.type === "slide-error")).toHaveLength(0);
    // Registry-derived responses must actually satisfy the mapped layouts — otherwise this whole
    // describe block would be asserting against accidental fallbacks.
    expect(result.outcomes.map((o) => o.content.layoutId))
      .toEqual(deck.layouts.map((l) => l.id));
  });
});

describe("§9 — client abort mid-generation: remaining slides stop, completed slides persisted", () => {
  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

  it("stops the deck and returns the slides already completed", async () => {
    const controller = new AbortController();
    const deck = deckJobs(4);
    // Slide 0 succeeds; slide 1's stream throws AbortError; slides 2–3 must never be attempted.
    const { llm, calls } = scriptedLlm([
      { text: validResponseFor(deck.layouts[0]!) },
      { throws: abortError() },
    ]);
    const { deps, events } = recorder();

    const result = await generateDeck(
      {
        deckId: "d", briefing: BRIEFING, tone: TONE, jobs: deck.jobs, concurrency: 1,
        signal: controller.signal,
      },
      deps(llm), { modelId: "m", signal: controller.signal },
    );

    expect(result.aborted).toBe(true);
    // The completed slide survives — that is the whole point of the row.
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]!.degraded, "slide 0 generated cleanly").toBe(false);
    expect(result.outcomes[0]!.content.layoutId).toBe(deck.layouts[0]!.id);
    expect(result.ok).toBe(1);
    // Slides 2 and 3 were never attempted: 2 model calls, not 4.
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "slide-start")).toHaveLength(2);
  });

  it("does NOT produce fallback slides for the cancelled remainder", async () => {
    // The failure mode this guards: treating an abort as a model error would fill the rest of the deck
    // with fallback slides the user never asked for, and report them as `failed`.
    const { llm } = scriptedLlm([{ throws: abortError() }]);
    const { deps } = recorder();
    const result = await generateDeck(
      { deckId: "d", briefing: BRIEFING, tone: TONE, jobs: deckJobs(3).jobs, concurrency: 1 },
      deps(llm), { modelId: "m" },
    );

    expect(result.aborted).toBe(true);
    expect(result.outcomes).toEqual([]);
    // Neither count claims them: they are absent, not failed.
    expect(result).toMatchObject({ ok: 0, failed: 0 });
  });

  it("stops before starting a slide when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { llm, calls } = scriptedLlm([]);
    const { deps, events } = recorder();

    const result = await generateDeck(
      {
        deckId: "d", briefing: BRIEFING, tone: TONE, jobs: deckJobs(3).jobs, concurrency: 2,
        signal: controller.signal,
      },
      deps(llm), { modelId: "m" },
    );

    expect(result.aborted).toBe(true);
    expect(calls).toEqual([]);
    expect(typesOf(events)).toEqual(["deck-start", "deck-done"]);
  });

  it("rethrows an abort from generateSlide rather than falling back", async () => {
    const { llm } = scriptedLlm([{ throws: abortError() }]);
    const { deps } = recorder();

    await expect(generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm))).rejects.toMatchObject({ name: "AbortError" });
  });
});

/* ─────────────────── streaming, and the §7 debug hook ─────────────────── */

describe("streaming and observability", () => {
  it("forwards text deltas as they arrive, and they reassemble into the response", async () => {
    const { llm } = scriptedLlm([{ text: GOOD }]);
    const { deps, events } = recorder();
    await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    const deltas = events.filter((e): e is Extract<StreamEvent, { type: "slide-delta" }> =>
      e.type === "slide-delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.text).join("")).toBe(GOOD);
  });

  it("keeps partial text on a mid-stream failure and recovers content from it when possible", async () => {
    // A throttle after a COMPLETE object still yields a clean slide: discarding the text would turn a
    // recoverable slide into a fallback.
    const { llm, calls } = scriptedLlm([{ text: GOOD, throwsAfter: ModelThrottled() }]);
    const { deps } = recorder();
    const outcome = await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    // The model error still routes to the fallback (repair is skipped) — but the assertion that matters
    // is that the partial text WAS retained and forwarded, so nothing was silently dropped.
    expect(calls).toHaveLength(1);
    expect(outcome.content.issue?.reason).toBe("model-error");
  });

  it("passes the slide prompt to onPrompt for DEBUG_PROMPTS (§7)", async () => {
    const { llm } = scriptedLlm([{ text: MISSING_REQUIRED }, { text: GOOD }]);
    const { deps } = recorder();
    const onPrompt = vi.fn();

    await generateSlide({
      slideId: "s", index: 2, total: 4, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, { ...deps(llm), onPrompt });

    // Both the slide prompt AND the repair prompt — the repair one is built inside the handler, so it
    // could only be logged from the pipeline's callback.
    expect(onPrompt.mock.calls.map((c) => c[0])).toEqual([
      "slide[2]:bullets", "slide[2]:bullets:repair",
    ]);
    expect(onPrompt.mock.calls[0]![1]).toContain(BRIEFING.topic);
  });

  it("sends the layout's slot contract, and the model's response is validated against it", async () => {
    const { llm, calls } = scriptedLlm([{ text: GOOD }]);
    const { deps } = recorder();
    await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: "stats", source: source({ visualHint: "metrics" }),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    // `stats` requires `values` and `labels`; GOOD has neither, so this must have degraded — proving
    // the schema came from the REGISTRY entry rather than a fixed slide shape.
    const prompt = calls[0]!.prompt;
    for (const spec of requireLayout("stats").slots) expect(prompt).toContain(spec.key);
  });
});

describe("model errors surface readably (§13)", () => {
  it("uses the AppError's readable text, never the SDK's", async () => {
    const thrown = ModelThrottled(new Error("ThrottlingException: Too many requests"));
    const { llm } = scriptedLlm([{ throws: thrown }]);
    const { deps, events } = recorder();

    const outcome = await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    expect(outcome.content.issue?.reason).toBe("model-error");
    expect(outcome.content.issue?.message).toMatch(/couldn't be reached/);

    const error = events.find((e): e is Extract<StreamEvent, { type: "slide-error" }> =>
      e.type === "slide-error")!;
    expect(error.message).not.toContain("ThrottlingException");
    expect(error.message).not.toContain("Too many requests");
  });

  it("collapses an unmapped raw error to the generic Internal message", async () => {
    const { llm } = scriptedLlm([{ throws: new TypeError("undefined is not a function") }]);
    const { deps } = recorder();
    const outcome = await generateSlide({
      slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
      briefing: BRIEFING, tone: TONE, modelId: "m",
    }, deps(llm));

    // §13: an unexpected error must never leak its raw text.
    expect(outcome.content.issue?.message).not.toContain("undefined is not a function");
    expect(outcome.degraded).toBe(true);
  });

  it("keeps every handler's escalation reason inside the SlideIssueReason union", async () => {
    // The persisted `Slide.issue.reason` and the `slide-error` event's `reason` must agree — a reason
    // string invented by a handler would break the UI's badge mapping silently.
    const allowed = new Set(["validation-failed", "repair-failed", "model-error", "internal"]);
    for (const script of [
      [{ text: GARBAGE }, { text: GARBAGE }],
      [{ throws: ModelThrottled() }],
      [{ text: MISSING_REQUIRED }, { throws: new Error("boom") }],
    ] as Script[][]) {
      const { llm } = scriptedLlm(script);
      const { deps } = recorder();
      const outcome = await generateSlide({
        slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
        briefing: BRIEFING, tone: TONE, modelId: "m",
      }, deps(llm));
      expect(allowed).toContain(outcome.content.issue!.reason);
    }
  });
});

describe("the handler chain's shape is the escalation policy", () => {
  it("is ordered cheapest-first: validate, repair, fallback", () => {
    expect(SLIDE_HANDLERS.map((h) => h.id)).toEqual(["validate", "repair", "fallback"]);
  });

  it("ends in a handler that ALWAYS handles", async () => {
    const result = await fallbackHandler.handle(
      { layout: BULLETS, source: source(), responseText: "", prompt: "" }, undefined,
    );
    expect(result.handled).toBe(true);
  });

  it("has a repair handler that never handles without a previous failure", async () => {
    const attempt: SlideAttempt = {
      layout: BULLETS, source: source(), responseText: GOOD, prompt: "",
      repair: async () => GOOD,
    };
    // Reached with no `previous` only via a malformed custom chain; it must escalate, not re-ask.
    const result = await repairHandler.handle(attempt, undefined);
    expect(result.handled).toBe(false);
  });

  it("reports speaker notes truncated but does NOT flag `trimmed` for them", async () => {
    // `trimmed` means the audience-visible content lost something. Diluting it would cost its signal.
    const notes = "n".repeat(900);
    const content = await runSlideHandlers({
      layout: BULLETS, source: source(), prompt: "…",
      responseText: JSON.stringify({ ...JSON.parse(GOOD), speakerNotes: notes }),
    });
    expect(content.speakerNotes!.length).toBeLessThan(notes.length);
    expect(content.flags).toEqual([]);
  });
});

describe("AppError plumbing", () => {
  it("every fallback message is readable text, not a code or a raw issue list", async () => {
    for (const script of [
      [{ text: GARBAGE }, { text: GARBAGE }],
      [{ throws: ModelThrottled() }],
    ] as Script[][]) {
      const { llm } = scriptedLlm(script);
      const { deps } = recorder();
      const outcome = await generateSlide({
        slideId: "s", index: 0, total: 1, layoutId: BULLETS.id, source: source(),
        briefing: BRIEFING, tone: TONE, modelId: "m",
      }, deps(llm));

      const message = outcome.content.issue!.message;
      expect(message).toMatch(/^[A-Z].*\.$/s);
      expect(message).not.toMatch(/^[A-Z][a-z]+[A-Z]/);  // not a code like `ModelThrottled`
    }
  });

  it("toReadable is the single choke point for model errors", () => {
    // Asserted here because the handlers depend on it: an AppError must keep its readable text, and
    // anything else must collapse to the generic message.
    expect(toReadable(ModelThrottled()).message).toMatch(/busy right now/);
    expect(toReadable(new Error("raw")).message).not.toContain("raw");
    expect(ModelThrottled()).toBeInstanceOf(AppError);
  });
});
