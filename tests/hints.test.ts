/**
 * The visual-hint vocabulary (SPEC §7.1, CLAUDE.md §4).
 *
 * `HINT_DESCRIPTIONS` sits in an awkward spot: it is a hint→string table, and §4 forbids "a parallel
 * hardcoded table". It earns its place by describing something the registry does not carry (the *content
 * shape* a hint implies, for the model) rather than something it does (hint→layout, which lives in
 * `layoutsForIntent`). This suite defends that boundary, because the way this file goes wrong is by
 * drifting into the second job.
 *
 * The load-time coverage check is what makes the pairing safe: a layout may declare an intent no hint
 * describes, and the symptom would be silent — the outline model never learns the hint exists, so the
 * layout is simply never selected. No error, no missing slide, just a layout that quietly never appears.
 * `hintCoverageProblems` catches it, and this suite proves the check actually fires.
 */

import { describe, expect, it } from "vitest";
import type { VisualHint } from "@/lib/domain/deck";
import { LAYOUTS, layoutsForIntent } from "@/lib/layouts/registry";
import {
  HINT_DESCRIPTIONS, assertHintCoverage, hintCoverageProblems, hintOrder, hintVocabulary,
  isVisualHint,
} from "@/lib/generation/hints";

describe("coverage against the registry — the load-time invariant", () => {
  it("passes for the real registry", () => {
    expect(hintCoverageProblems()).toEqual([]);
    expect(() => assertHintCoverage()).not.toThrow();
  });

  it("describes every intent every seed layout declares", () => {
    // The direction that matters: an undescribed intent means the model never requests that layout.
    for (const layout of LAYOUTS) {
      for (const intent of layout.intents) {
        expect(HINT_DESCRIPTIONS, `layout "${layout.id}" intent "${intent}"`)
          .toHaveProperty(intent);
      }
    }
  });

  it("DETECTS a layout whose intent has no description", () => {
    // Proving the check fires. A coverage check that cannot fail is decoration.
    const problems = hintCoverageProblems([
      { id: "chart", intents: ["chart" as VisualHint] },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("chart");
    expect(problems[0]).toContain("HINT_DESCRIPTIONS");
  });

  it("reports every offending layout at once, not just the first", () => {
    const problems = hintCoverageProblems([
      { id: "a", intents: ["chart" as VisualHint] },
      { id: "b", intents: ["timeline" as VisualHint, "list"] },
    ]);
    expect(problems).toHaveLength(2);
  });

  it("has at least one layout for every described hint", () => {
    // The reverse direction, and a softer requirement: a hint with no layout still maps (the fallback
    // rule catches it), so this is a quality check rather than a correctness one. Asserted because a
    // hint the model can choose but nothing renders specially is a silently wasted vocabulary entry.
    const orphans = hintOrder().filter((hint) => layoutsForIntent(hint).length === 0);
    expect(orphans, `hints no layout claims: ${orphans.join(", ")}`).toEqual([]);
  });
});

describe("the §4 boundary — this table must not become a hint→layout map", () => {
  it("names no layout id, in any description", () => {
    // The drift this guards: "list: use the bullets layout". That would be the parallel table §4
    // forbids, and it would go stale the moment a brand customizes or a layout is renamed.
    const ids = LAYOUTS.map((l) => l.id);
    for (const [hint, description] of Object.entries(HINT_DESCRIPTIONS)) {
      for (const id of ids) {
        expect(description.toLowerCase(), `hint "${hint}" mentions layout "${id}"`)
          .not.toContain(id.replace(/_/g, " "));
        expect(description.toLowerCase()).not.toContain(id);
      }
    }
  });

  it("names no layout displayName either", () => {
    for (const [hint, description] of Object.entries(HINT_DESCRIPTIONS)) {
      for (const layout of LAYOUTS) {
        expect(description.toLowerCase(), `hint "${hint}" mentions "${layout.displayName}"`)
          .not.toContain(layout.displayName.toLowerCase());
      }
    }
  });

  it("describes WHEN to choose, not WHAT IT LOOKS LIKE", () => {
    // Appearance words would be visual vocabulary (§7) and would also be a lie whenever a brand's
    // template renders that layout differently — the model cannot know how a brand paints a hint.
    const appearance = [
      "bullet", "bulleted", "centred", "centered", "left-aligned", "right-aligned", "full-bleed",
      "column", "card", "large", "bold", "italic", "font", "colour", "color", "background",
      "top of the slide", "bottom of the slide",
    ];
    for (const [hint, description] of Object.entries(HINT_DESCRIPTIONS)) {
      const lower = description.toLowerCase();
      for (const word of appearance) {
        expect(lower, `hint "${hint}" uses the appearance word "${word}"`).not.toContain(word);
      }
    }
  });
});

describe("the vocabulary block sent to the model", () => {
  it("lists every hint with its description, one per line", () => {
    const lines = hintVocabulary().split("\n");
    expect(lines).toHaveLength(Object.keys(HINT_DESCRIPTIONS).length);
    for (const hint of hintOrder()) {
      expect(hintVocabulary()).toContain(`- ${hint}: ${HINT_DESCRIPTIONS[hint]}`);
    }
  });

  it("is byte-identical across calls, so DEBUG_PROMPTS logs are diffable", () => {
    expect(hintVocabulary()).toBe(hintVocabulary());
  });

  it("runs opening → body → closing rather than alphabetically", () => {
    // The declared order is itself a hint about deck shape. Sorting it would lose that for free.
    const order = hintOrder();
    expect(order[0]).toBe("opening");
    expect(order.indexOf("closing")).toBeGreaterThan(order.indexOf("list"));
    expect(order).not.toEqual([...order].sort());
  });

  it("has a non-trivial description for every hint", () => {
    for (const [hint, description] of Object.entries(HINT_DESCRIPTIONS)) {
      expect(description.length, hint).toBeGreaterThan(30);
      expect(description.trim(), hint).toMatch(/\.$/);
    }
  });
});

describe("isVisualHint", () => {
  it.each(Object.keys(HINT_DESCRIPTIONS))("accepts %s", (hint) => {
    expect(isVisualHint(hint)).toBe(true);
  });

  it.each([["chart"], [""], [42], [null], [undefined], [{}], [["list"]]])(
    "rejects %p", (value) => {
      expect(isVisualHint(value)).toBe(false);
    });

  it("is not fooled by an Object.prototype key", () => {
    // Found by writing this test: the guard used `value in HINT_DESCRIPTIONS`, and `in` walks the
    // prototype chain, so `"toString"` validated as a hint. A model answering `visualHint:
    // "constructor"` would then reach `HINT_DESCRIPTIONS[hint]` and get a *function*, which the outline
    // path would carry into a prompt. Now `Object.hasOwn`.
    expect(isVisualHint("toString")).toBe(false);
    expect(isVisualHint("constructor")).toBe(false);
    expect(isVisualHint("__proto__")).toBe(false);
  });
});
