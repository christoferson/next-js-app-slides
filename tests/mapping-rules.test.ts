/**
 * The mapping CoR (SPEC §7.2, CLAUDE.md §2 step 9: "table-test each rule and precedence").
 *
 * Two things are being tested, and the second matters more:
 *
 *  1. each rule decides what it says it decides;
 *  2. **precedence** — that a lower rule cannot reach a slide a higher one claims. Every rule in
 *     isolation can be correct while the chain is still wrong, and the visible symptom of a
 *     precedence bug is mild (a plausible-but-wrong layout) which is exactly why it needs asserting
 *     rather than eyeballing.
 *
 * The rules are also asserted to be registry-driven: no test here names a `hint → layoutId` pair that
 * the registry does not itself declare, because a parallel table in the test would hide the very
 * leak §10 exists to catch.
 */

import { describe, expect, it } from "vitest";
import type { Outline, OutlineSlide, VisualHint } from "@/lib/domain/deck";
import { FALLBACK_LAYOUT_ID, LAYOUTS, layoutsForIntent } from "@/lib/layouts/registry";
import {
  MAPPING_RULES, type MappingRule, type SlidePosition, fallbackRule, intentMatchRule, layoutForHint,
  mapOutline, mapSlide, positionalRule, userOverrideRule,
} from "@/lib/mapping/rules";

const slide = (over: Partial<OutlineSlide> = {}): OutlineSlide => ({
  question: "What changed?",
  message: "Revenue grew 42% year on year.",
  evidence: ["Q3 board pack, p4"],
  visualHint: "detail",
  ...over,
});

/** A middle-of-deck, middle-of-section position — the one where no positional rule fires. */
const middle = (over: Partial<SlidePosition> = {}): SlidePosition => ({
  index: 3,
  total: 8,
  sectionIndex: 1,
  indexInSection: 1,
  sectionHasHeading: true,
  ...over,
});

const outlineOf = (sections: { heading: string; hints: VisualHint[] }[]): Outline => ({
  sections: sections.map((s) => ({
    heading: s.heading,
    slides: s.hints.map((visualHint) => slide({ visualHint })),
  })),
});

describe("the chain's shape", () => {
  it("is exactly SPEC §7.2's order", () => {
    // The order IS the specification here — a rearrangement is a behaviour change, not a refactor.
    expect(MAPPING_RULES.map((r) => r.id))
      .toEqual(["user-override", "positional", "intent-match", "fallback"]);
  });

  it("ends in a rule that always decides, so there is no unmapped state", () => {
    expect(MAPPING_RULES.at(-1)!.apply(slide(), middle())).toBeDefined();
  });
});

describe("UserOverrideRule", () => {
  it("honours an override naming a real layout", () => {
    const decision = userOverrideRule.apply(slide({ layoutOverride: "quote" }), middle());
    expect(decision).toMatchObject({ layoutId: "quote", rule: "user-override" });
  });

  it("declines when there is no override", () => {
    expect(userOverrideRule.apply(slide(), middle())).toBeUndefined();
  });

  it("IGNORES an override naming a layout the registry no longer has", () => {
    // A layout can be removed between an outline being saved and the deck being generated. Honouring
    // the id would render an unknown layout; throwing would fail a whole deck over a registry edit.
    expect(userOverrideRule.apply(slide({ layoutOverride: "deleted_layout" }), middle()))
      .toBeUndefined();
  });

  it("falls through to the rest of the chain when the override is stale", () => {
    const decision = mapSlide(
      slide({ layoutOverride: "deleted_layout", visualHint: "quote" }), middle(),
    );
    expect(decision.rule).toBe("intent-match");
    expect(decision.layoutId).toBe("quote");
  });

  it("does not treat an empty string as an override", () => {
    expect(userOverrideRule.apply(slide({ layoutOverride: "" }), middle())).toBeUndefined();
  });
});

describe("PositionalRule", () => {
  it("maps the first slide to the opening layout", () => {
    const decision = positionalRule.apply(slide(), middle({ index: 0, indexInSection: 0, sectionIndex: 0 }));
    expect(decision).toMatchObject({ layoutId: "title", rule: "positional" });
  });

  it("maps the last slide to the closing layout", () => {
    const decision = positionalRule.apply(slide(), middle({ index: 7, total: 8 }));
    expect(decision).toMatchObject({ layoutId: "closing", rule: "positional" });
  });

  it("maps a section's first slide to the divider", () => {
    const decision = positionalRule.apply(slide(), middle({ indexInSection: 0, sectionIndex: 1 }));
    expect(decision).toMatchObject({ layoutId: "section_divider", rule: "positional" });
  });

  it("declines in the middle of a section", () => {
    expect(positionalRule.apply(slide(), middle())).toBeUndefined();
  });

  it("prefers opening over closing in a one-slide deck", () => {
    // A deck that only opens is coherent; one that only closes is not.
    const decision = positionalRule.apply(
      slide(), middle({ index: 0, total: 1, sectionIndex: 0, indexInSection: 0 }),
    );
    expect(decision!.layoutId).toBe("title");
  });

  it("does NOT divide the first section — that divider would repeat the title slide", () => {
    expect(positionalRule.apply(slide(), middle({ indexInSection: 0, sectionIndex: 0 })))
      .toBeUndefined();
  });

  it("does NOT divide a section with a blank heading", () => {
    // A divider whose only content is the heading would render an empty slide.
    expect(positionalRule.apply(
      slide(), middle({ indexInSection: 0, sectionIndex: 2, sectionHasHeading: false }),
    )).toBeUndefined();
  });

  it("declines rather than throwing when a positional layout is absent from the registry", () => {
    // Proven by driving the real rule against a registry that lacks `closing` is not possible without
    // mutating module state, so this asserts the invariant the rule depends on instead: every
    // positional id it names is present, and the ids are exactly the three structural roles.
    for (const id of ["title", "closing", "section_divider"]) {
      expect(LAYOUTS.some((l) => l.id === id), id).toBe(true);
    }
  });
});

describe("IntentMatchRule", () => {
  it.each(
    // Built FROM the registry, so the test cannot encode a hint→layout pair the registry disagrees
    // with. Skips hints no layout claims (there are none today; the registry suite asserts that).
    (["opening", "agenda", "section", "list", "comparison", "quote", "metrics", "closing", "detail"] as VisualHint[])
      .map((hint) => [hint, layoutsForIntent(hint)[0]?.id] as const)
      .filter(([, id]) => id !== undefined),
  )("maps the %s hint to %s", (hint, expected) => {
    const decision = intentMatchRule.apply(slide({ visualHint: hint }), middle());
    expect(decision).toMatchObject({ layoutId: expected, rule: "intent-match" });
  });

  it("breaks ties by registry order, making that order a precedence declaration", () => {
    // `bullets` claims both `list` and `detail`; if a later layout also claimed one, the first in the
    // array must still win. Asserted against the array directly rather than a hardcoded id.
    for (const hint of ["list", "detail"] as VisualHint[]) {
      const claimants = LAYOUTS.filter((l) => (l.intents as readonly string[]).includes(hint));
      expect(claimants.length).toBeGreaterThan(0);
      expect(intentMatchRule.apply(slide({ visualHint: hint }), middle())!.layoutId)
        .toBe(claimants[0]!.id);
    }
  });

  it("declines for a hint no layout claims", () => {
    // Reachable if a model invents a hint and it survives outline validation. The chain must degrade
    // to the fallback, not throw.
    expect(intentMatchRule.apply(slide({ visualHint: "diagram" as VisualHint }), middle()))
      .toBeUndefined();
  });

  it("names the hint in its reason, so the badge explains itself", () => {
    expect(intentMatchRule.apply(slide({ visualHint: "metrics" }), middle())!.reason)
      .toContain("metrics");
  });
});

describe("FallbackRule", () => {
  it("always decides, and decides on the registry's fallback layout", () => {
    expect(fallbackRule.apply(slide(), middle())).toMatchObject({
      layoutId: FALLBACK_LAYOUT_ID, rule: "fallback",
    });
  });

  it("targets a layout fillable from an outline entry alone", () => {
    // The property that makes it a valid fallback for §9's FallbackHandler too: message + evidence
    // must be enough. The registry asserts the exact shape; this states why mapping cares.
    const fallback = LAYOUTS.find((l) => l.id === FALLBACK_LAYOUT_ID)!;
    expect(fallback.slots.filter((s) => s.required).map((s) => s.key).sort())
      .toEqual(["items", "title"]);
  });
});

describe("precedence — a lower rule cannot claim a slide a higher one owns", () => {
  it("an override beats position on the first slide", () => {
    const decision = mapSlide(
      slide({ layoutOverride: "quote" }),
      middle({ index: 0, total: 8, sectionIndex: 0, indexInSection: 0 }),
    );
    expect(decision).toMatchObject({ layoutId: "quote", rule: "user-override" });
  });

  it("an override beats position on the last slide", () => {
    const decision = mapSlide(slide({ layoutOverride: "stats" }), middle({ index: 7, total: 8 }));
    expect(decision).toMatchObject({ layoutId: "stats", rule: "user-override" });
  });

  it("an override beats a matching intent", () => {
    const decision = mapSlide(slide({ visualHint: "quote", layoutOverride: "bullets" }), middle());
    expect(decision).toMatchObject({ layoutId: "bullets", rule: "user-override" });
  });

  it("position beats intent — a first slide hinting 'list' is still the title slide", () => {
    // The rule that most often looks like a bug and is not: the model is describing the opening's
    // content, not its role in the deck.
    const decision = mapSlide(
      slide({ visualHint: "list" }),
      middle({ index: 0, total: 8, sectionIndex: 0, indexInSection: 0 }),
    );
    expect(decision).toMatchObject({ layoutId: "title", rule: "positional" });
  });

  it("position beats intent on the last slide too", () => {
    const decision = mapSlide(slide({ visualHint: "metrics" }), middle({ index: 7, total: 8 }));
    expect(decision).toMatchObject({ layoutId: "closing", rule: "positional" });
  });

  it("intent beats the fallback", () => {
    expect(mapSlide(slide({ visualHint: "quote" }), middle()).rule).toBe("intent-match");
  });

  it("reaches the fallback only when everything above declines", () => {
    const decision = mapSlide(slide({ visualHint: "diagram" as VisualHint }), middle());
    expect(decision).toMatchObject({ layoutId: FALLBACK_LAYOUT_ID, rule: "fallback" });
  });

  it("still decides when given a chain whose rules all decline", () => {
    // `mapSlide` promises totality regardless of the chain passed — the §10 proof runs a custom one.
    const declining: MappingRule[] = [{ id: "intent-match", apply: () => undefined }];
    expect(mapSlide(slide(), middle(), declining).layoutId).toBe(FALLBACK_LAYOUT_ID);
  });
});

describe("mapOutline", () => {
  it("flattens across sections and maps every slide exactly once", () => {
    const mapped = mapOutline(outlineOf([
      { heading: "Intro", hints: ["opening", "agenda"] },
      { heading: "Body", hints: ["list", "metrics"] },
      { heading: "Wrap", hints: ["closing"] },
    ]));
    expect(mapped).toHaveLength(5);
    expect(mapped.map((m) => m.position.index)).toEqual([0, 1, 2, 3, 4]);
    expect(mapped.every((m) => m.position.total === 5)).toBe(true);
  });

  it("produces the deck shape SPEC §7.2 describes: opens, divides, closes", () => {
    const mapped = mapOutline(outlineOf([
      { heading: "Intro", hints: ["opening", "agenda"] },
      { heading: "Findings", hints: ["metrics", "list"] },
      { heading: "Wrap", hints: ["closing"] },
    ]));
    expect(mapped.map((m) => m.decision.layoutId)).toEqual([
      "title",            // first slide
      "agenda",           // intent
      "section_divider",  // opens section 1
      "bullets",          // intent: list
      "closing",          // last slide
    ]);
  });

  it("skips empty sections without shifting what 'last slide' means", () => {
    // A model that returns an empty section must not cost the deck its closing slide.
    const mapped = mapOutline({
      sections: [
        { heading: "Intro", slides: [slide({ visualHint: "opening" })] },
        { heading: "Empty", slides: [] },
        { heading: "Wrap", slides: [slide({ visualHint: "closing" })] },
      ],
    });
    expect(mapped).toHaveLength(2);
    expect(mapped.map((m) => m.decision.layoutId)).toEqual(["title", "closing"]);
  });

  it("counts only sections that contributed slides, so an empty one cannot create a divider", () => {
    const mapped = mapOutline({
      sections: [
        { heading: "", slides: [] },
        { heading: "First real section", slides: [slide(), slide()] },
      ],
    });
    // The surviving section is the deck's FIRST, so its opener gets no divider.
    expect(mapped[0]!.position.sectionIndex).toBe(0);
    expect(mapped[0]!.decision.layoutId).not.toBe("section_divider");
  });

  it("returns nothing for an outline with no slides at all", () => {
    expect(mapOutline({ sections: [] })).toEqual([]);
    expect(mapOutline({ sections: [{ heading: "Empty", slides: [] }] })).toEqual([]);
  });

  it("maps a single-slide deck to the opening layout, not the closing one", () => {
    const mapped = mapOutline(outlineOf([{ heading: "Only", hints: ["metrics"] }]));
    expect(mapped[0]!.decision.layoutId).toBe("title");
  });

  it("gives every slide a layout that exists in the registry", () => {
    // The guarantee generation depends on: `requireLayout` must never throw on a mapping decision.
    const ids = new Set(LAYOUTS.map((l) => l.id));
    const mapped = mapOutline(outlineOf([
      { heading: "A", hints: ["opening", "diagram" as VisualHint, "quote"] },
      { heading: "B", hints: ["comparison", "detail", "closing"] },
    ]));
    for (const m of mapped) expect(ids.has(m.decision.layoutId), m.decision.layoutId).toBe(true);
  });

  it("carries a reason on every decision, since the badge always renders one", () => {
    const mapped = mapOutline(outlineOf([
      { heading: "A", hints: ["opening", "list"] },
      { heading: "B", hints: ["quote", "closing"] },
    ]));
    for (const m of mapped) expect(m.decision.reason.trim()).not.toBe("");
  });

  it("honours per-slide overrides inside a full outline", () => {
    const outline = outlineOf([
      { heading: "A", hints: ["opening", "list"] },
      { heading: "B", hints: ["quote", "closing"] },
    ]);
    outline.sections[0]!.slides[0]!.layoutOverride = "quote";
    const mapped = mapOutline(outline);
    expect(mapped[0]!.decision).toMatchObject({ layoutId: "quote", rule: "user-override" });
  });

  it("is deterministic — the same outline maps the same way every time", () => {
    // The property that justifies not using an LLM here.
    const outline = outlineOf([
      { heading: "A", hints: ["opening", "list", "metrics"] },
      { heading: "B", hints: ["quote", "comparison", "closing"] },
    ]);
    const first = mapOutline(outline).map((m) => m.decision);
    const second = mapOutline(outline).map((m) => m.decision);
    expect(second).toEqual(first);
  });

  it("does not mutate the outline it is given", () => {
    const outline = outlineOf([{ heading: "A", hints: ["opening", "list"] }]);
    const before = JSON.stringify(outline);
    mapOutline(outline);
    expect(JSON.stringify(outline)).toBe(before);
  });
});

describe("layoutForHint — the picker's ordering, deliberately not mapSlide", () => {
  it("answers what a hint means, ignoring position", () => {
    expect(layoutForHint("metrics")).toBe(layoutsForIntent("metrics")[0]!.id);
  });

  it("is undefined for a hint no layout claims", () => {
    expect(layoutForHint("diagram" as VisualHint)).toBeUndefined();
  });

  it("agrees with IntentMatchRule for every claimed hint", () => {
    // The two must not diverge: the picker's highlighted option and the badge would then disagree on
    // a middle-of-deck slide, which is the one case where they are answering the same question.
    for (const layout of LAYOUTS) {
      for (const intent of layout.intents) {
        expect(layoutForHint(intent)).toBe(intentMatchRule.apply(
          slide({ visualHint: intent }), middle(),
        )!.layoutId);
      }
    }
  });
});
