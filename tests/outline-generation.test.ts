/**
 * Outline validation and generation (SPEC §7.1, CLAUDE.md §9's outline row).
 *
 * §9's outline requirements, verbatim: *"Outline equivalents: invalid outline JSON → one repair → readable
 * error (no crash); slide-count wildly off target → regenerate guidance surfaced."*
 *
 * Both halves are load-bearing, and the second is the interesting one: a count that misses the target is
 * **advisory**, not a validation failure. So this file asserts a distinction rather than a behaviour —
 * which inputs are rejected (and get the repair call), versus which are accepted and merely annotated.
 * Getting that line wrong in either direction is a real product bug:
 *
 *   - too strict → a perfectly good 9-slide outline against a target of 12 burns the repair call and may
 *     then hard-error on something the user never minded;
 *   - too loose → an outline with no slides in it reaches the generation pipeline and produces nothing.
 *
 * ## The other asymmetry: no fallback
 *
 * The slide chain ends in a fallback because a weak slide beats no deck. The outline chain ends in a
 * **readable error**, because a fabricated plan ("Introduction / Body / Conclusion") is worse than an
 * error — the user would spend a whole generation pass discovering it. That is asserted directly, since
 * "add a fallback here too, for symmetry" is exactly the change that would break it.
 */

import { describe, expect, it, vi } from "vitest";
import type { Briefing, Outline } from "@/lib/domain/deck";
import type { BrandTone } from "@/lib/brand/types";
import type { LLMPort, LlmRequest, LlmResponse, LlmTextDelta } from "@/lib/ports/llm-port";
import { AppError, ModelThrottled } from "@/lib/errors/errors";
import { DEFAULT_TONE_ID } from "@/lib/brand/tones";
import { HINT_DESCRIPTIONS } from "@/lib/generation/hints";
import {
  OUTLINE_LIMITS, countSlides, describeOutlineIssues, outlineAdvisories, parseOutline,
  parseOutlineSection,
} from "@/lib/generation/outline-schema";
import { OUTLINE_COUNT_TOLERANCE } from "@/lib/generation/prompts";
import { generateOutline, generateOutlineSection } from "@/lib/generation/outline-pipeline";

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const TONE: BrandTone = { voice: DEFAULT_TONE_ID, traits: ["direct"], bannedWords: ["synergy"] };

const BRIEFING: Briefing = {
  topic: "Billing platform migration",
  audience: "Engineering leadership",
  objective: "Approve a two-quarter migration",
  targetSlideCount: 4,
};

const slide = (over: Record<string, unknown> = {}) => ({
  question: "What is the legacy platform costing us?",
  message: "Billing incidents quadrupled and now threaten enterprise renewals.",
  evidence: ["19 incidents in Q3"],
  visualHint: "list",
  ...over,
});

/** A raw response body with `count` slides spread over one section. */
const rawOutline = (count: number, over: Record<string, unknown> = {}) => ({
  sections: [{
    heading: "Where we are",
    slides: Array.from({ length: count }, (_, i) => slide({ message: `Message ${i + 1}.` })),
  }],
  ...over,
});

/** A parsed, valid `Outline` — for the advisory tests, which operate on valid input by definition. */
const outlineOf = (hints: readonly string[]): Outline => ({
  sections: [{
    heading: "Where we are",
    slides: hints.map((visualHint, i) => ({
      question: `Q${i}?`, message: `M${i}.`, evidence: [], visualHint: visualHint as never,
    })),
  }],
});

const ok = <T>(r: { ok: true; outline: T } | { ok: false; issues: unknown[] }): T => {
  if (!r.ok) throw new Error(`expected ok, got issues: ${JSON.stringify(r.issues)}`);
  return r.outline;
};

/* ─────────────────────────────── the scripted model ─────────────────────────────── */

type Script = { text: string } | { throws: unknown };

function scriptedLlm(script: readonly Script[]): { llm: LLMPort; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  let index = 0;
  return {
    calls,
    llm: {
      async complete(request): Promise<LlmResponse> {
        calls.push(request);
        const step = script[index];
        index += 1;
        if (step === undefined) throw new Error(`unexpected call ${index}`);
        if ("throws" in step) throw step.throws;
        return { text: step.text };
      },
      // Never used: the outline is a single non-streaming call, and asserting that is the point.
      stream(): AsyncIterable<LlmTextDelta> {
        throw new Error("the outline path must not stream");
      },
    },
  };
}

const DEPS = (llm: LLMPort) => ({ llm, modelId: "us.anthropic.claude-opus-5" });

/* ═══════════════════════════ tier 1: what makes an outline USABLE ═══════════════════════════ */

describe("parseOutline accepts what a compliant model produces", () => {
  it("parses a well-formed outline", () => {
    const outline = ok(parseOutline(rawOutline(4)));
    expect(countSlides(outline)).toBe(4);
    expect(outline.sections[0]!.heading).toBe("Where we are");
    expect(outline.sections[0]!.slides[0]!.visualHint).toBe("list");
  });

  it("trims whitespace on every text field", () => {
    const outline = ok(parseOutline({
      sections: [{
        heading: "  Where we are  ",
        slides: [slide({ question: "  Q?  ", message: "  M.  ", evidence: ["  E  "] })],
      }],
    }));
    expect(outline.sections[0]!.heading).toBe("Where we are");
    expect(outline.sections[0]!.slides[0]!.question).toBe("Q?");
    expect(outline.sections[0]!.slides[0]!.evidence).toEqual(["E"]);
  });

  it("accepts a blank section heading", () => {
    // `PositionalRule` declines to divide an unheaded section, so an untitled one renders correctly.
    // Requiring a heading would fail an otherwise fine outline.
    const outline = ok(parseOutline({ sections: [{ heading: "", slides: [slide()] }] }));
    expect(outline.sections[0]!.heading).toBe("");
  });

  it("defaults a missing heading to empty rather than failing", () => {
    const outline = ok(parseOutline({ sections: [{ slides: [slide()] }] }));
    expect(outline.sections[0]!.heading).toBe("");
  });

  it("accepts multiple sections and preserves their order", () => {
    const outline = ok(parseOutline({
      sections: [
        { heading: "First", slides: [slide()] },
        { heading: "Second", slides: [slide(), slide()] },
      ],
    }));
    expect(outline.sections.map((s) => s.heading)).toEqual(["First", "Second"]);
    expect(countSlides(outline)).toBe(3);
  });
});

describe("parseOutline is TOLERANT of packaging, so repair is not spent on it", () => {
  it("coerces a single evidence string into an array", () => {
    // A model asked for `string[]` occasionally sends one string. Packaging, not a content failure.
    const outline = ok(parseOutline({
      sections: [{ heading: "H", slides: [slide({ evidence: "Just the one support" })] }],
    }));
    expect(outline.sections[0]!.slides[0]!.evidence).toEqual(["Just the one support"]);
  });

  it.each([undefined, null, ""])("treats evidence %p as none", (evidence) => {
    const outline = ok(parseOutline({
      sections: [{ heading: "H", slides: [slide({ evidence })] }],
    }));
    expect(outline.sections[0]!.slides[0]!.evidence).toEqual([]);
  });

  it("drops blank evidence entries", () => {
    const outline = ok(parseOutline({
      sections: [{ heading: "H", slides: [slide({ evidence: ["Real", "  ", ""] })] }],
    }));
    expect(outline.sections[0]!.slides[0]!.evidence).toEqual(["Real"]);
  });

  it("caps evidence at the limit rather than rejecting an over-eager model", () => {
    const outline = ok(parseOutline({
      sections: [{ heading: "H", slides: [slide({ evidence: ["a", "b", "c", "d", "e", "f"] })] }],
    }));
    expect(outline.sections[0]!.slides[0]!.evidence)
      .toHaveLength(OUTLINE_LIMITS.maxEvidenceItems);
  });

  it("falls back to `detail` for an invented visualHint", () => {
    // Failing the whole outline — every section, every slide — because one slide said "chart" would be
    // wildly disproportionate. `detail` is the general-purpose shape and maps through the registry.
    for (const hint of ["chart", "diagram", "", 42, null, undefined]) {
      const outline = ok(parseOutline({
        sections: [{ heading: "H", slides: [slide({ visualHint: hint })] }],
      }));
      expect(outline.sections[0]!.slides[0]!.visualHint, String(hint)).toBe("detail");
    }
  });

  it.each(Object.keys(HINT_DESCRIPTIONS))("preserves the recognized hint %s", (hint) => {
    const outline = ok(parseOutline({
      sections: [{ heading: "H", slides: [slide({ visualHint: hint })] }],
    }));
    expect(outline.sections[0]!.slides[0]!.visualHint).toBe(hint);
  });

  it("drops an empty section rather than rejecting the outline", () => {
    const outline = ok(parseOutline({
      sections: [
        { heading: "Empty", slides: [] },
        { heading: "Real", slides: [slide()] },
      ],
    }));
    expect(outline.sections).toHaveLength(1);
    expect(outline.sections[0]!.heading).toBe("Real");
  });

  it("STRIPS layoutOverride, so a model cannot pin a layout", () => {
    // `UserOverrideRule` is the top of the mapping chain (SPEC §7.2). A model inventing this field would
    // silently outrank every other rule — a layout the user never chose, with no trace of why.
    const outline = ok(parseOutline({
      sections: [{ heading: "H", slides: [slide({ layoutOverride: "quote" })] }],
    }));
    expect(outline.sections[0]!.slides[0]).not.toHaveProperty("layoutOverride");
  });

  it("ignores unknown extra fields on a slide", () => {
    const outline = ok(parseOutline({
      sections: [{ heading: "H", slides: [slide({ speakerNotes: "…", confidence: 0.9 })] }],
    }));
    expect(Object.keys(outline.sections[0]!.slides[0]!).sort())
      .toEqual(["evidence", "message", "question", "visualHint"]);
  });
});

describe("parseOutline REJECTS what it cannot use — these earn the repair call", () => {
  const issues = (input: unknown): string[] => {
    const r = parseOutline(input);
    if (r.ok) throw new Error("expected a rejection");
    return describeOutlineIssues(r.issues);
  };

  it.each([
    ["not an object", "just prose"],
    ["an array", [{ heading: "H", slides: [] }]],
    ["null", null],
    ["no sections key", { slides: [slide()] }],
    ["sections not an array", { sections: "Where we are" }],
    ["an empty sections array", { sections: [] }],
    ["only empty sections", { sections: [{ heading: "H", slides: [] }] }],
    ["a slide with no question", { sections: [{ heading: "H", slides: [{ ...slide(), question: "" }] }] }],
    ["a slide with a blank question", { sections: [{ heading: "H", slides: [{ ...slide(), question: "   " }] }] }],
    ["a slide with no message", { sections: [{ heading: "H", slides: [{ ...slide(), message: undefined }] }] }],
    ["a slide that is not an object", { sections: [{ heading: "H", slides: ["a slide"] }] }],
    ["a section that is not an object", { sections: ["Where we are"] }],
  ])("rejects %s", (_label, input) => {
    expect(parseOutline(input).ok).toBe(false);
  });

  it("rejects a question over its character limit", () => {
    expect(parseOutline({
      sections: [{
        heading: "H",
        slides: [slide({ question: "q".repeat(OUTLINE_LIMITS.maxQuestionChars + 1) })],
      }],
    }).ok).toBe(false);
  });

  it("rejects more sections than the cap", () => {
    expect(parseOutline({
      sections: Array.from({ length: OUTLINE_LIMITS.maxSections + 1 },
        () => ({ heading: "H", slides: [slide()] })),
    }).ok).toBe(false);
  });

  it("rejects an outline over the total slide cap", () => {
    const perSection = OUTLINE_LIMITS.maxSlidesPerSection;
    const sections = Math.ceil((OUTLINE_LIMITS.maxSlidesTotal + 1) / perSection);
    expect(parseOutline({
      sections: Array.from({ length: sections }, () => ({
        heading: "H", slides: Array.from({ length: perSection }, () => slide()),
      })),
    }).ok).toBe(false);
  });

  it("accepts exactly the total slide cap", () => {
    // The boundary in the passing direction, so the cap is a cap and not an off-by-one rejection.
    const perSection = OUTLINE_LIMITS.maxSlidesPerSection;
    const full = Array.from({ length: OUTLINE_LIMITS.maxSlidesTotal / perSection }, () => ({
      heading: "H", slides: Array.from({ length: perSection }, () => slide()),
    }));
    const outline = ok(parseOutline({ sections: full }));
    expect(countSlides(outline)).toBe(OUTLINE_LIMITS.maxSlidesTotal);
  });

  it("names the offending FIELD in every issue, for the repair pass", () => {
    // The repair prompt is only useful if it says what to fix. Written for a model, never for a user.
    const described = issues({ sections: [{ heading: "H", slides: [{ ...slide(), question: "" }] }] });
    expect(described.join(" ")).toMatch(/question/);
    expect(described.every((d) => d.trim() !== "")).toBe(true);
  });

  it("reports EVERY issue, not just the first", () => {
    // One round trip should fix everything: reporting one problem per attempt would need N repair calls
    // where the budget is 1.
    const described = issues({
      sections: [{ heading: "H", slides: [{ question: "", message: "", evidence: [] }] }],
    });
    expect(described.length).toBeGreaterThan(1);
  });
});

describe("parseOutlineSection — the single-section regenerate path", () => {
  it("parses one section", () => {
    const r = parseOutlineSection({ heading: "Where we are", slides: [slide()] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.section.slides).toHaveLength(1);
  });

  it("rejects a section with no slides", () => {
    const r = parseOutlineSection({ heading: "H", slides: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(describeOutlineIssues(r.issues).join(" ")).toMatch(/no slides/);
  });

  it("rejects a whole-outline response sent to the section parser", () => {
    // A model that ignored "ONE section" must not have its outline silently accepted as a section.
    expect(parseOutlineSection(rawOutline(3)).ok).toBe(false);
  });
});

/* ═══════════════════════ tier 2: what makes an outline GOOD (advisory) ═══════════════════════ */

describe("§9 — 'slide-count wildly off target → regenerate guidance SURFACED'", () => {
  const kinds = (outline: Outline, target: number): string[] =>
    outlineAdvisories(outline, target).map((a) => a.kind);

  it("stays silent inside the ±2 tolerance the prompt actually asked for", () => {
    // The user must never be told the model missed a target it was never given.
    for (const count of [2, 3, 4, 5, 6]) {
      expect(kinds(outlineOf(Array(count).fill("list")), 4), `count ${count}`)
        .not.toContain("count-off-target");
    }
    expect(OUTLINE_COUNT_TOLERANCE).toBe(2);
  });

  it("advises when the count is outside the tolerance, in both directions", () => {
    expect(kinds(outlineOf(Array(1).fill("list")), 4)).toContain("count-off-target");
    expect(kinds(outlineOf(Array(7).fill("list")), 4)).toContain("count-off-target");
  });

  it("states BOTH numbers so the advisory is actionable", () => {
    const [advisory] = outlineAdvisories(outlineOf(Array(9).fill("list")), 4);
    expect(advisory!.message).toContain("9");
    expect(advisory!.message).toContain("4");
    expect(advisory!.message).toMatch(/Regenerate/);
  });

  it("does NOT reject an off-target outline — that is the whole point", () => {
    // §9 says surfaced, not rejected. Failing here would spend the repair call on an outline the user
    // may well prefer, and could then hard-error on something they never minded.
    expect(parseOutline(rawOutline(9)).ok).toBe(true);
  });
});

describe("advisories on the deck's boundaries are advisory, and here is why", () => {
  it("notes a first slide not framed as an opening", () => {
    const advisories = outlineAdvisories(outlineOf(["list", "list", "closing"]), 3);
    expect(advisories.map((a) => a.kind)).toContain("no-opening");
    // The wording is a suggestion, not a diagnosis: `PositionalRule` renders it as the title slide
    // regardless, so nothing about the deck is actually wrong.
    expect(advisories.find((a) => a.kind === "no-opening")!.message)
      .toMatch(/still render/);
  });

  it("notes a last slide not framed as a close", () => {
    const advisories = outlineAdvisories(outlineOf(["opening", "list", "list"]), 3);
    expect(advisories.map((a) => a.kind)).toContain("no-closing");
  });

  it("is silent when the boundaries are right", () => {
    expect(outlineAdvisories(outlineOf(["opening", "list", "closing"]), 3)
      .map((a) => a.kind)).toEqual([]);
  });

  it("does not report no-closing for a single-slide outline", () => {
    // One slide is both the opening and the close; flagging it would be noise.
    expect(outlineAdvisories(outlineOf(["opening"]), 1).map((a) => a.kind))
      .not.toContain("no-closing");
  });

  it("suggests splitting a large single section", () => {
    const advisories = outlineAdvisories(outlineOf(["opening", "list", "list", "list", "closing"]), 5);
    expect(advisories.map((a) => a.kind)).toContain("single-section");
  });

  it("does not nag about a small single section", () => {
    expect(outlineAdvisories(outlineOf(["opening", "closing"]), 2).map((a) => a.kind))
      .not.toContain("single-section");
  });

  it("every advisory message is user-readable prose, not a code", () => {
    // These go on screen next to a regenerate control (§12).
    const advisories = outlineAdvisories(outlineOf(["list", "list", "list", "list", "list", "list"]), 2);
    expect(advisories.length).toBeGreaterThan(1);
    for (const a of advisories) {
      expect(a.message).toMatch(/^[A-Z].*\.$/s);
      expect(a.message).not.toContain(a.kind);
    }
  });
});

/* ═══════════════════════ the pipeline: one call, one repair, readable error ═══════════════════════ */

describe("§9 — 'invalid outline JSON → one repair → readable error (no crash)'", () => {
  it("succeeds on the first call when the response is valid", async () => {
    const { llm, calls } = scriptedLlm([{ text: JSON.stringify(rawOutline(4)) }]);
    const result = await generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm));

    expect(countSlides(result.outline)).toBe(4);
    expect(result.repaired).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("recovers a fenced response without spending the repair call", async () => {
    const { llm, calls } = scriptedLlm([
      { text: "Here's the plan:\n```json\n" + JSON.stringify(rawOutline(4)) + "\n```\nHope that helps!" },
    ]);
    const result = await generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm));

    expect(countSlides(result.outline)).toBe(4);
    expect(calls, "packaging must not cost the repair call").toHaveLength(1);
  });

  it("repairs ONCE and succeeds", async () => {
    const { llm, calls } = scriptedLlm([
      { text: JSON.stringify({ sections: [{ heading: "H", slides: [{ question: "" }] }] }) },
      { text: JSON.stringify(rawOutline(4)) },
    ]);
    const result = await generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm));

    expect(result.repaired).toBe(true);
    expect(calls).toHaveLength(2);
    // The repair prompt shows the model its own output and the specific failures.
    expect(calls[1]!.prompt).toContain("<previous_response>");
    expect(calls[1]!.prompt).toMatch(/question/);
  });

  it("throws a READABLE error when the repair also fails — and does NOT fabricate a plan", async () => {
    // The asymmetry with the slide chain, asserted directly. A fabricated outline is worse than an
    // error: the user would spend a full generation pass discovering it.
    const { llm, calls } = scriptedLlm([{ text: "I need more detail." }, { text: "Still no." }]);

    await expect(generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm)))
      .rejects.toThrow(/couldn't produce a usable outline/i);
    expect(calls, "exactly two attempts — a budget, not a loop").toHaveLength(2);
  });

  it("the thrown error is an AppError carrying both issue sets for the log, not for the user", async () => {
    const { llm } = scriptedLlm([{ text: "nope" }, { text: "nope" }]);
    const err = await generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    const app = err as AppError;
    expect(app.code).toBe("GenerationFailed");
    // Readable: says what to do, and does not quote model output back at the user.
    expect(app.readable).toMatch(/Try again/);
    expect(app.readable).not.toContain("nope");
    expect(app.detail).toMatchObject({ attempts: 2 });
  });

  it("lets a model error propagate rather than dressing it as an outline failure", async () => {
    // A throttle is not "the AI couldn't produce a usable outline" — it is retryable, and the UI needs
    // to say so. Collapsing the two would tell the user to rewrite a briefing that was never the problem.
    const { llm, calls } = scriptedLlm([{ throws: ModelThrottled() }]);
    await expect(generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm)))
      .rejects.toMatchObject({ code: "ModelThrottled" });
    expect(calls, "no repair after a transport failure").toHaveLength(1);
  });

  it("never streams — the outline is one call, and nothing renders incrementally", async () => {
    const { llm } = scriptedLlm([{ text: JSON.stringify(rawOutline(4)) }]);
    // `scriptedLlm.stream` throws; reaching it would fail this test loudly.
    await expect(generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm))).resolves.toBeDefined();
  });

  it("returns advisories alongside a valid outline", async () => {
    const { llm } = scriptedLlm([{ text: JSON.stringify(rawOutline(9)) }]);
    const result = await generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm));

    expect(result.advisories.map((a) => a.kind)).toContain("count-off-target");
    expect(countSlides(result.outline), "the outline is still returned").toBe(9);
  });

  it("computes advisories against the repaired outline, not the rejected one", async () => {
    const { llm } = scriptedLlm([
      { text: "garbage" },
      { text: JSON.stringify(rawOutline(4, {})) },
    ]);
    const result = await generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm));
    expect(result.repaired).toBe(true);
    expect(result.advisories.map((a) => a.kind)).not.toContain("count-off-target");
  });

  it("passes the instruction through to the prompt", async () => {
    const { llm, calls } = scriptedLlm([{ text: JSON.stringify(rawOutline(4)) }]);
    await generateOutline(
      { briefing: BRIEFING, tone: TONE, instruction: "Lead with the renewal risk." }, DEPS(llm),
    );
    expect(calls[0]!.prompt).toContain("Lead with the renewal risk.");
  });

  it("logs prompts through onPrompt for DEBUG_PROMPTS (§7)", async () => {
    const { llm } = scriptedLlm([{ text: "garbage" }, { text: JSON.stringify(rawOutline(4)) }]);
    const onPrompt = vi.fn();
    await generateOutline({ briefing: BRIEFING, tone: TONE }, { ...DEPS(llm), onPrompt });

    expect(onPrompt.mock.calls.map((c) => c[0])).toEqual(["outline", "outline-repair"]);
  });

  it("requests enough tokens that a 60-slide plan cannot be cut mid-JSON", async () => {
    // A `max_tokens` cut-off mid-object is unrecoverable — the extractor will not close braces it did
    // not see. Being generous is cheap; being tight is a hard failure.
    const { llm, calls } = scriptedLlm([{ text: JSON.stringify(rawOutline(4)) }]);
    await generateOutline({ briefing: BRIEFING, tone: TONE }, DEPS(llm));
    expect(calls[0]!.maxTokens).toBeGreaterThanOrEqual(8000);
  });
});

describe("generateOutlineSection", () => {
  const OUTLINE = ok(parseOutline({
    sections: [
      { heading: "Where we are", slides: [slide(), slide()] },
      { heading: "What it takes", slides: [slide()] },
    ],
  }));

  it("regenerates one section and returns just that section", async () => {
    const { llm, calls } = scriptedLlm([
      { text: JSON.stringify({ heading: "Where we are, revisited", slides: [slide(), slide()] }) },
    ]);
    const { section, repaired } = await generateOutlineSection(
      { briefing: BRIEFING, tone: TONE, outline: OUTLINE, sectionIndex: 0 }, DEPS(llm),
    );

    expect(section.heading).toBe("Where we are, revisited");
    expect(section.slides).toHaveLength(2);
    expect(repaired).toBe(false);
    // The rest of the deck goes in as read-only context — the point of a section regenerate is that
    // the user liked everything else.
    expect(calls[0]!.prompt).toContain("What it takes");
  });

  it("repairs once, then errors readably", async () => {
    const { llm, calls } = scriptedLlm([{ text: "nope" }, { text: "still nope" }]);
    await expect(generateOutlineSection(
      { briefing: BRIEFING, tone: TONE, outline: OUTLINE, sectionIndex: 0 }, DEPS(llm),
    )).rejects.toThrow(/couldn't rewrite that section/i);
    expect(calls).toHaveLength(2);
  });

  it("rejects an out-of-range sectionIndex as a BAD REQUEST, before calling the model", async () => {
    // A distinct message so it is not mistaken for a model failure in the log — this is a stale client,
    // not a struggling model.
    const { llm, calls } = scriptedLlm([]);
    await expect(generateOutlineSection(
      { briefing: BRIEFING, tone: TONE, outline: OUTLINE, sectionIndex: 9 }, DEPS(llm),
    )).rejects.toThrow(/no longer exists/i);
    expect(calls).toEqual([]);
  });

  it("succeeds on a repair", async () => {
    const { llm } = scriptedLlm([
      { text: JSON.stringify({ heading: "H", slides: [] }) },
      { text: JSON.stringify({ heading: "H", slides: [slide()] }) },
    ]);
    const { repaired } = await generateOutlineSection(
      { briefing: BRIEFING, tone: TONE, outline: OUTLINE, sectionIndex: 1 }, DEPS(llm),
    );
    expect(repaired).toBe(true);
  });
});

describe("countSlides", () => {
  it("counts across sections", () => {
    expect(countSlides(ok(parseOutline({
      sections: [
        { heading: "A", slides: [slide(), slide()] },
        { heading: "B", slides: [slide()] },
      ],
    })))).toBe(3);
  });
});
