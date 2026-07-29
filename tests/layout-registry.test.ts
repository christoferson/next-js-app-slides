/**
 * Registry invariants (CLAUDE.md §4) and the seed set (SPEC §6).
 *
 * `registryProblems` is exercised two ways: against the real registry, which must be clean, and against
 * hand-built broken layouts, which must each produce the specific problem. The second half matters more
 * — a checker that reports nothing is indistinguishable from a valid registry until the day it isn't.
 */

import { describe, expect, it } from "vitest";
import {
  FALLBACK_LAYOUT_ID, LAYOUTS, allLayouts, assertRegistryInvariants, fallbackLayout, findLayout,
  layoutProblems, layoutSummaries, layoutsForIntent, registryLookup, registryProblems, requireLayout,
} from "@/lib/layouts/registry";
import type { SlideLayout, SlotSpec } from "@/lib/layouts/types";
import type { SlotZone } from "@/lib/brand/types";

const SEED_IDS = [
  "title", "agenda", "section_divider", "bullets", "two_column", "quote", "stats", "closing",
];

/* ── a minimal valid layout to mutate, so each case tests ONE broken thing ── */

const zone = (slotKey: string, over: Partial<SlotZone> = {}): SlotZone => ({
  slotKey, x: 10, y: 10, w: 50, h: 20, align: "left", valign: "top", ...over,
});

const spec = (over: Partial<SlotSpec> = {}): SlotSpec => ({
  key: "title", type: "text", required: true, typeRole: "title", maxChars: 60,
  description: "A title.", ...over,
});

const valid = (over: Partial<SlideLayout> = {}): SlideLayout => ({
  id: "probe",
  displayName: "Probe",
  description: "A probe layout.",
  intents: ["detail"],
  slots: [spec()],
  defaultZones: [zone("title")],
  FallbackRenderer: () => null,
  toPptx: () => {},
  ...over,
});

/**
 * Cases below check ONE layout in isolation, so they use `layoutProblems` — `registryProblems` would
 * also report the absent fallback layout, which is not the probe's fault.
 */
const problemsFor = (layout: SlideLayout): string[] => layoutProblems(layout);

describe("the real registry", () => {
  it("satisfies every invariant", () => {
    expect(registryProblems()).toEqual([]);
  });

  it("does not throw at load", () => {
    expect(() => assertRegistryInvariants()).not.toThrow();
  });

  it("contains exactly the SPEC §6 seed set, in deck order", () => {
    expect(LAYOUTS.map((l) => l.id)).toEqual(SEED_IDS);
  });

  it("covers every VisualHint, so mapping can never fall through for a valid outline", () => {
    // The union in lib/domain/deck.ts. Written out rather than derived — a type can't be enumerated at
    // runtime, and hardcoding it here is what makes adding a hint with no layout a test failure.
    const hints = [
      "opening", "agenda", "section", "list", "comparison", "quote", "metrics", "closing", "detail",
    ];
    for (const hint of hints) {
      expect(layoutsForIntent(hint).length, `no layout declares intent "${hint}"`).toBeGreaterThan(0);
    }
  });
});

describe("lookups", () => {
  it("finds every seed layout by id", () => {
    for (const id of SEED_IDS) expect(findLayout(id)?.id).toBe(id);
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(findLayout("nope")).toBeUndefined();
  });

  it("requireLayout throws a message naming the known layouts", () => {
    expect(() => requireLayout("nope")).toThrow(/Unknown layout "nope"/);
    expect(() => requireLayout("nope")).toThrow(/bullets/);
  });

  it("allLayouts is the registry", () => {
    expect(allLayouts()).toBe(LAYOUTS);
  });

  it("layoutsForIntent reads the registry's own intents", () => {
    expect(layoutsForIntent("metrics").map((l) => l.id)).toEqual(["stats"]);
    expect(layoutsForIntent("nonsense")).toEqual([]);
  });
});

describe("the fallback layout", () => {
  it("exists and requires exactly title + items", () => {
    const layout = fallbackLayout();
    expect(layout.id).toBe(FALLBACK_LAYOUT_ID);
    expect(layout.slots.filter((s) => s.required).map((s) => s.key).sort()).toEqual(["items", "title"]);
  });

  it("is flagged if it grows a third required slot", () => {
    // The guarantee: FallbackHandler can only supply message + evidence, so any other required slot
    // would render blank on exactly the slides where something already went wrong.
    const broken = valid({
      id: FALLBACK_LAYOUT_ID,
      slots: [
        spec({ key: "title" }),
        spec({ key: "items", type: "list", maxItems: 6, itemMaxChars: 80 }),
        spec({ key: "takeaway" }),
      ],
      defaultZones: [zone("title"), zone("items"), zone("takeaway")],
    });
    // A registry-wide rule, so it goes through `registryProblems`.
    expect(registryProblems([broken]).join("\n")).toMatch(/must require exactly items \+ title/);
  });
});

describe("registryProblems catches authoring mistakes", () => {
  it("accepts the probe baseline", () => {
    expect(problemsFor(valid())).toEqual([]);
  });

  it("a required slot with no defaultZones entry — THE §4 check", () => {
    const broken = valid({ defaultZones: [] });
    expect(problemsFor(broken).join("\n")).toMatch(/required slot "title" has no entry in defaultZones/);
  });

  it("allows an OPTIONAL slot with no zone", () => {
    const layout = valid({
      slots: [spec(), spec({ key: "extra", required: false })],
      defaultZones: [zone("title")],
    });
    expect(problemsFor(layout)).toEqual([]);
  });

  it("a zone for a slot that does not exist", () => {
    const broken = valid({ defaultZones: [zone("title"), zone("ghost")] });
    expect(problemsFor(broken).join("\n")).toMatch(/positions "ghost", which is not one of its slots/);
  });

  it("two zones for the same slot", () => {
    const broken = valid({ defaultZones: [zone("title"), zone("title", { y: 50 })] });
    expect(problemsFor(broken).join("\n")).toMatch(/two defaultZones entries for slot "title"/);
  });

  it("duplicate layout ids", () => {
    expect(registryProblems([valid(), valid()]).join("\n")).toMatch(/duplicate id/);
  });

  it("a non-snake_case layout id", () => {
    expect(problemsFor(valid({ id: "TwoColumn" })).join("\n")).toMatch(/lower_snake_case/);
  });

  it("duplicate slot keys", () => {
    const broken = valid({ slots: [spec(), spec()], defaultZones: [zone("title")] });
    expect(problemsFor(broken).join("\n")).toMatch(/duplicate slot key/);
  });

  it("an empty slot description — the model's only guidance", () => {
    const broken = valid({ slots: [spec({ description: "  " })] });
    expect(problemsFor(broken).join("\n")).toMatch(/description is empty/);
  });

  it("no intents, which would make the layout unreachable by mapping", () => {
    expect(problemsFor(valid({ intents: [] })).join("\n")).toMatch(/declares no intents/);
  });

  it("a non-positive maxChars", () => {
    expect(problemsFor(valid({ slots: [spec({ maxChars: 0 })] })).join("\n"))
      .toMatch(/maxChars must be a positive integer/);
  });

  it("a list slot missing maxItems or itemMaxChars", () => {
    const broken = valid({ slots: [spec({ type: "list" })] });
    const text = problemsFor(broken).join("\n");
    expect(text).toMatch(/must declare a positive integer maxItems/);
    expect(text).toMatch(/must declare a positive integer itemMaxChars/);
  });

  it("a text slot carrying list-only budgets", () => {
    const broken = valid({ slots: [spec({ maxItems: 3, itemMaxChars: 10 })] });
    const text = problemsFor(broken).join("\n");
    expect(text).toMatch(/maxItems is meaningless on a text slot/);
    expect(text).toMatch(/itemMaxChars is meaningless on a text slot/);
  });

  it.each([
    ["negative x", { x: -1 }],
    ["negative y", { y: -0.5 }],
    ["zero width", { w: 0 }],
    ["zero height", { h: 0 }],
    ["past the right edge", { x: 60, w: 50 }],
    ["past the bottom edge", { y: 90, h: 20 }],
  ])("an out-of-bounds default zone: %s", (_label, over) => {
    // §1.1/C4 — pptxgenjs clamps nothing, so this would place text off the slide silently.
    const broken = valid({ defaultZones: [zone("title", over)] });
    expect(problemsFor(broken).join("\n")).toMatch(/is outside the slide/);
  });

  it("allows a full-bleed zone at exactly the edges", () => {
    const layout = valid({ defaultZones: [zone("title", { x: 0, y: 0, w: 100, h: 100 })] });
    expect(problemsFor(layout)).toEqual([]);
  });

  it("assertRegistryInvariants throws listing every problem at once", () => {
    const broken = valid({ intents: [], defaultZones: [] });
    expect(() => assertRegistryInvariants([broken])).toThrow(/declares no intents/);
    expect(() => assertRegistryInvariants([broken])).toThrow(/has no entry in defaultZones/);
  });

  it("a registry with no fallback layout at all", () => {
    // The probe set has no `bullets`, so every failure path would have nowhere to land.
    expect(registryProblems([valid()]).join("\n"))
      .toMatch(/FALLBACK_LAYOUT_ID "bullets" is not in the registry/);
  });
});

describe("registryLookup — the brand-schema adapter", () => {
  it("reports slot keys and required keys for a real layout", () => {
    const found = registryLookup.layout("bullets");
    expect(found?.slotKeys).toEqual(["title", "items", "takeaway"]);
    expect(found?.requiredSlotKeys).toEqual(["title", "items"]);
  });

  it("returns undefined for an unknown layout, so brand validation reports it as an issue", () => {
    expect(registryLookup.layout("nope")).toBeUndefined();
  });

  it("agrees with the registry for every seed layout", () => {
    for (const layout of LAYOUTS) {
      const found = registryLookup.layout(layout.id);
      expect(found?.slotKeys).toEqual(layout.slots.map((s) => s.key));
      expect(found?.requiredSlotKeys).toEqual(
        layout.slots.filter((s) => s.required).map((s) => s.key),
      );
    }
  });
});

describe("layoutSummaries — the /api/registry/layouts payload", () => {
  it("is JSON-serializable: no functions survive", () => {
    const summaries = layoutSummaries();
    const round = JSON.parse(JSON.stringify(summaries));
    expect(round).toEqual(summaries);
  });

  it("carries no renderer, so the client bundle needs nothing server-side", () => {
    for (const summary of layoutSummaries()) {
      expect(summary).not.toHaveProperty("FallbackRenderer");
      expect(summary).not.toHaveProperty("toPptx");
    }
  });

  it("seeds the brand editor with zones for every layout", () => {
    for (const summary of layoutSummaries()) {
      expect(summary.defaultZones.length).toBeGreaterThan(0);
    }
  });
});
