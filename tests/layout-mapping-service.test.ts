/**
 * §2 step 12 — `LayoutMappingService`.
 *
 * `tests/mapping-rules.test.ts` already table-tests the chain itself (every rule, every precedence
 * case). This suite covers only the three things the service adds on top, each of which would otherwise
 * be duplicated by every caller:
 *
 *  1. the preview rows the outline editor renders — and specifically that they come from the SAME chain
 *     generation will run, since a preview that disagrees with the outcome is a badge that lies;
 *  2. override validation at the write, which is the only place a typo can be reported at all
 *     (`UserOverrideRule` deliberately ignores an unknown override);
 *  3. the picker's ordering, including the one place it is *meant* to disagree with the preview.
 *
 * No harness or container: the service has no dependencies at all, deliberately — that is what makes
 * "why did my slide become a divider?" reproducible without storage state.
 */

import { describe, expect, it } from "vitest";
import type { Outline, VisualHint } from "@/lib/domain/deck";
import { AppError } from "@/lib/errors/errors";
import { LAYOUTS, findLayout, layoutsForIntent } from "@/lib/layouts/registry";
import { LayoutMappingService } from "@/lib/services/layout-mapping-service";

const service = new LayoutMappingService();

const slide = (visualHint: VisualHint, question: string, layoutOverride?: string) => ({
  question,
  message: `${question} — the claim.`,
  evidence: [],
  visualHint,
  ...(layoutOverride !== undefined ? { layoutOverride } : {}),
});

/** Two headed sections, so the section-divider and section-heading paths are both reachable. */
const outline = (): Outline => ({
  sections: [
    {
      heading: "Where we are",
      slides: [slide("opening", "Why are we here?"), slide("list", "What broke?")],
    },
    {
      heading: "What we'll do",
      slides: [slide("list", "What's the plan?"), slide("closing", "What happens next?")],
    },
  ],
});

describe("LayoutMappingService — preview", () => {
  it("produces one row per slide, in deck order, agreeing with map()", async () => {
    const rows = service.preview(outline());
    const mapped = service.map(outline());

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    // The badge and the outcome must come from one chain — this is the assertion that keeps them honest.
    expect(rows.map((r) => r.layoutId)).toEqual(mapped.map((m) => m.decision.layoutId));
    expect(rows.map((r) => r.rule)).toEqual(mapped.map((m) => m.decision.rule));
  });

  it("carries the section heading the row displays, not just its index", async () => {
    const rows = service.preview(outline());
    // `MappedSlide.position` has a section *index*; the heading is what the user reads, so the service
    // attaches it. Attaching it per-caller is how two callers end up disagreeing about section 0.
    expect(rows.map((r) => r.sectionHeading))
      .toEqual(["Where we are", "Where we are", "What we'll do", "What we'll do"]);
  });

  it("omits a blank heading rather than rendering an empty label", async () => {
    const rows = service.preview({
      sections: [{ heading: "   ", slides: [slide("list", "What broke?")] }],
    });
    expect(rows[0]?.sectionHeading).toBeUndefined();
  });

  it("skips empty sections when numbering headings, matching the chain", async () => {
    // An empty section is dropped by `mapOutline`. If `preview` built its heading list from ALL
    // sections, every row after the empty one would be labelled with its neighbour's heading.
    const rows = service.preview({
      sections: [
        { heading: "Dropped", slides: [] },
        { heading: "Real", slides: [slide("list", "What broke?")] },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sectionHeading).toBe("Real");
  });

  it("resolves the display name from the registry and marks user overrides", async () => {
    const rows = service.preview({
      sections: [{
        heading: "Where we are",
        slides: [slide("list", "First?"), slide("list", "Pinned?", "quote"), slide("list", "Last?")],
      }],
    });

    expect(rows[1]?.layoutId).toBe("quote");
    expect(rows[1]?.overridden).toBe(true);
    expect(rows[1]?.reason).toBe("You chose this layout");
    expect(rows[1]?.layoutDisplayName).toBe(findLayout("quote")!.displayName);
    // Only the pinned row is marked — otherwise the "reset to automatic" affordance appears everywhere.
    expect(rows.map((r) => r.overridden)).toEqual([false, true, false]);
  });

  it("carries a reason for every row, since the badge is the whole feature", async () => {
    for (const row of service.preview(outline())) {
      expect(row.reason.length, `row ${row.index} has no reason`).toBeGreaterThan(0);
      expect(row.layoutDisplayName).not.toBe("");
    }
  });

  it("degrades to the raw id rather than failing the whole editor load", async () => {
    // A decision naming a layout the registry doesn't have would be OUR bug, and the chain cannot
    // produce one — so the branch is reached by stubbing `map`, which is the only honest way to test a
    // guard against an invariant violation. It matters because `preview` is a READ: failing an entire
    // editor load over one unresolvable row is worse than a row that names what it couldn't resolve.
    const stubbed = new LayoutMappingService();
    stubbed.map = () => [{
      slide: slide("list", "Q?"),
      position: { index: 0, total: 1, sectionIndex: 0, indexInSection: 0, sectionHasHeading: false },
      decision: { layoutId: "removed_layout", rule: "intent-match", reason: "Matches something" },
    }];

    const rows = stubbed.preview({ sections: [{ heading: "", slides: [slide("list", "Q?")] }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layoutDisplayName).toBe("removed_layout");
  });
});

describe("LayoutMappingService — override validation", () => {
  it("throws UnknownLayout with the known ids for a typo", () => {
    let caught: unknown;
    try {
      service.assertValidOverride("bulletts");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe("UnknownLayout");
    expect(err.status).toBe(400);
    // The known list goes to the log, not the user — but it must be there, or "that layout isn't
    // available" is unactionable for whoever has to debug it.
    expect((err.detail as { known: string[] }).known).toEqual(LAYOUTS.map((l) => l.id));
  });

  it("accepts every registered id", () => {
    for (const layout of LAYOUTS) {
      expect(() => service.assertValidOverride(layout.id)).not.toThrow();
    }
  });

  it("rejects a prototype key, which a bare registry index would resolve", () => {
    // `findLayout` is Map-backed, so this is already safe — asserted because an id arrives from a
    // request body, and a future object-literal lookup would silently reintroduce the hole.
    for (const key of ["toString", "constructor", "__proto__"]) {
      expect(() => service.assertValidOverride(key)).toThrow(AppError);
    }
  });

  it("is what makes a typo reportable at all", () => {
    // The chain IGNORES an unknown override by design (a layout can be removed between save and
    // generate). So without this check the user pins `bulletts`, sees no error, and gets `bullets`.
    const rows = service.preview({
      sections: [{ heading: "", slides: [slide("list", "Q?", "bulletts")] }],
    });
    expect(rows[0]?.overridden).toBe(false);
    expect(rows[0]?.layoutId).not.toBe("bulletts");
  });
});

describe("LayoutMappingService — picker options", () => {
  it("offers every layout, intent-match first, recommendation at the head", () => {
    const options = service.layoutOptionsFor({ visualHint: "quote" });

    expect(options.map((o) => o.id).sort()).toEqual(LAYOUTS.map((l) => l.id).sort());
    expect(options[0]?.recommended).toBe(true);
    expect(options.filter((o) => o.recommended)).toHaveLength(1);

    // Intent claimants sit ahead of everything else, so the useful choices are not below the fold.
    const matching = new Set(layoutsForIntent("quote").map((l) => l.id));
    const firstNonMatch = options.findIndex((o) => !matching.has(o.id));
    expect(options.slice(0, firstNonMatch).every((o) => matching.has(o.id))).toBe(true);
  });

  it("keeps registry order within a rank, so the picker and the chain agree on ties", () => {
    const options = service.layoutOptionsFor({ visualHint: "detail" });
    const rest = options.filter((o) => !layoutsForIntent("detail").some((l) => l.id === o.id));
    const registryOrder = LAYOUTS.map((l) => l.id).filter((id) => rest.some((o) => o.id === id));
    // `LAYOUTS` order is a precedence declaration (see `rules.ts`) — a sort that reshuffled equals
    // would make the highlighted option disagree with which layout actually wins a tie.
    expect(rest.map((o) => o.id)).toEqual(registryOrder);
  });

  it("recommends by INTENT even where position would win — deliberately", () => {
    // The picker answers "what does this hint mean", not "what will this slide be". On slide 0 the
    // positional rule takes `title`, but the recommendation stays intent-based; running the whole chain
    // here would make the highlighted option disagree with the badge. Documented in `rules.ts`.
    const recommended = service.layoutOptionsFor({ visualHint: "metrics" }).find((o) => o.recommended);
    const preview = service.preview({
      sections: [{ heading: "", slides: [slide("metrics", "How big?")] }],
    });

    expect(recommended?.id).toBe("stats");
    expect(preview[0]?.layoutId).toBe("title");     // position wins for the real decision
    expect(preview[0]?.rule).toBe("positional");
  });

  it("carries the description the picker renders", () => {
    for (const option of service.layoutOptionsFor({ visualHint: "list" })) {
      expect(option.description.length, `${option.id} has no description`).toBeGreaterThan(0);
      expect(option.displayName).toBe(findLayout(option.id)!.displayName);
    }
  });
});
