/**
 * Every layout's declared `maxChars` vs the capacity its OWN `defaultZones` + type scale provide.
 *
 * This is the test that makes §1.1/C1 an invariant instead of a note. `fit:'shrink'` never shrinks, so
 * a budget larger than its box does not degrade gracefully — the text spills across neighbouring zones
 * or is silently clipped, and the exported deck is the artifact the audience sees. Nothing else in the
 * codebase would catch a budget that outgrew its zone: the schema would accept the text, the normalizer
 * would pass it through unflagged, and the slide would simply be wrong.
 *
 * The capacity model is an estimate (see `capacity.ts` — ⚠️ VERIFY on per-face advance), so the
 * assertion is that budgets fit *with headroom* rather than exactly. `HEADROOM` is the margin every
 * budget must leave; it exists because 0.5em is a mean advance and a wide face or all-caps text will
 * consume more.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileTheme } from "@/lib/brand/theme";
import { makeBrand } from "./fixtures";
import { estimateCapacity, estimateListCapacity } from "@/lib/layouts/capacity";
import { LAYOUTS } from "@/lib/layouts/registry";
import type { SlideLayout, SlotSpec } from "@/lib/layouts/types";
import { zoneFor } from "@/lib/layouts/render-mode";
import { SPEAKER_NOTES_MAX_CHARS } from "@/lib/layouts/validate";

/**
 * A budget may use at most this fraction of its estimated capacity.
 *
 * 0.85 rather than 1.0 because the estimate is a mean: a wide face (Verdana), all-caps, or unusually
 * wide glyphs consume more than 0.5em. It is deliberately NOT loose enough to hide a real mistake — a
 * budget at twice its zone's capacity fails at any headroom we would plausibly pick.
 */
const HEADROOM = 0.85;

/**
 * One face for both roles, and no templates: capacities here must describe the *registry's*
 * `defaultZones` at the standard type scale, not a customized brand's.
 */
const tokens = compileTheme(makeBrand({
  fonts: { heading: "georgia", body: "georgia" },
  templates: {},
}));

/**
 * Layouts whose list slots render as SIDE-BY-SIDE boxes rather than a stacked list.
 *
 * `stats` is the only one: `cardColumns` splits each band into up to three equal columns and puts one
 * item in each, so its items neither share a column's width nor stack within its height. Modelling it as
 * a stacked list gets both wrong — it would divide the height by the item count (understating capacity
 * threefold) while crediting the full band width (overstating it). The value is the column count.
 *
 * Declared here rather than inferred because there is no honest way to derive it: how a layout arranges
 * a list is a fact about its render code. Keeping it as a small explicit table means a new layout that
 * does the same thing must say so, and one that doesn't gets the stacked-list model by default.
 */
const COLUMNAR_LISTS: Record<string, Record<string, number>> = {
  stats: { values: 3, labels: 3, notes: 3 },
};

const columnsFor = (layout: SlideLayout, key: string): number =>
  COLUMNAR_LISTS[layout.id]?.[key] ?? 1;

interface Checked {
  layout: string;
  slot: string;
  budget: number;
  capacity: number;
}

const checks: Checked[] = [];

describe.each(LAYOUTS.map((l) => [l.id, l] as const))("%s budgets fit their zones", (_id, layout) => {
  for (const spec of layout.slots) {
    const zone = zoneFor(layout.defaultZones, spec.key);

    it(`${spec.key}: has a zone or is optional`, () => {
      // Required slots are covered by the registry invariant; this states the other half — an optional
      // slot with no zone is legal, but then its budget is unverifiable and must be acknowledged.
      if (spec.required) expect(zone, `${layout.id}.${spec.key} needs a zone`).toBeDefined();
    });

    if (!zone) continue;

    const columns = columnsFor(layout, spec.key);
    // GUTTER in stats.tsx. Only applies to columnar lists, where `columns > 1`.
    const box = { ...zone, w: (zone.w - 2.5 * (columns - 1)) / columns };
    const fontSize = tokens.type[spec.typeRole];

    if (spec.type === "list") {
      it(`${spec.key}: itemMaxChars × maxItems fits the list zone`, () => {
        const maxItems = spec.maxItems!;
        const itemMax = spec.itemMaxChars!;
        // A columnar list puts ONE item per box, so each item gets that box's full height.
        const perBox = columns > 1 ? 1 : maxItems;
        const { itemChars } = columns > 1
          ? { itemChars: estimateCapacity(box, fontSize).chars }
          : estimateListCapacity(box, fontSize, perBox);

        checks.push({ layout: layout.id, slot: spec.key, budget: itemMax, capacity: itemChars });
        expect(
          itemMax,
          `${layout.id}.${spec.key}: itemMaxChars ${itemMax} exceeds ${HEADROOM * 100}% of the `
          + `~${itemChars} chars available per item at ${fontSize}pt in a `
          + `${box.w.toFixed(1)}%×${zone.h}% box`
          + (columns > 1 ? ` (${columns} side-by-side columns)` : ` (${maxItems}-item stacked list)`)
          + ". Lower the budget, enlarge the zone, or reduce maxItems.",
        ).toBeLessThanOrEqual(Math.floor(itemChars * HEADROOM));
      });

      it(`${spec.key}: maxChars is consistent with itemMaxChars × maxItems`, () => {
        // `maxChars` on a list slot is the whole-list budget; it must not be *smaller* than one item's,
        // or the two budgets would contradict each other, nor wildly larger than the sum.
        expect(spec.maxChars).toBeGreaterThanOrEqual(spec.itemMaxChars!);
        expect(spec.maxChars).toBeLessThanOrEqual(spec.itemMaxChars! * spec.maxItems!);
      });
      continue;
    }

    it(`${spec.key}: maxChars fits the text zone`, () => {
      const { chars, charsPerLine, lines } = estimateCapacity(box, fontSize);

      checks.push({ layout: layout.id, slot: spec.key, budget: spec.maxChars, capacity: chars });
      expect(
        spec.maxChars,
        `${layout.id}.${spec.key}: maxChars ${spec.maxChars} exceeds ${HEADROOM * 100}% of the ~${chars} `
        + `chars (${charsPerLine}/line × ${lines} lines) its zone holds at ${fontSize}pt. Lower the `
        + "budget or enlarge the zone.",
      ).toBeLessThanOrEqual(Math.floor(chars * HEADROOM));
    });
  }
});

describe("budget hygiene across the registry", () => {
  it("every layout declares speaker-notes-compatible budgets", () => {
    // Notes are capped globally, not per layout (SPEC §6). Stated here so the constant has a test.
    expect(SPEAKER_NOTES_MAX_CHARS).toBe(600);
  });

  it("no prose slot's budget is absurdly small", () => {
    /*
     * A prose budget under ~12 characters would truncate almost any real phrase, giving a `trimmed`
     * badge on essentially every slide and making the flag meaningless.
     *
     * `stats.values` is exempt and stays exempt: 7 characters is the point of the slot, which holds
     * "42%" or "$1.2M". The exemption is by slot key rather than by size so that a *new* slot with an
     * unusably small budget still fails — the check would otherwise be trivially satisfiable.
     */
    const FIGURES_ONLY = new Set(["stats.values"]);

    for (const layout of LAYOUTS) {
      for (const spec of layout.slots) {
        if (FIGURES_ONLY.has(`${layout.id}.${spec.key}`)) continue;
        const smallest = spec.type === "list" ? spec.itemMaxChars! : spec.maxChars;
        expect(smallest, `${layout.id}.${spec.key}`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it("a display/title slot never out-budgets a body slot of the same width", () => {
    /*
     * Type-scale sanity: at a larger point size the same box holds less text, so a headline budget
     * above a body budget is a sign one of them was chosen rather than computed.
     *
     * Restricted to slots of comparable width, which is what makes the comparison meaningful. In
     * `two_column` the title spans 84% while each column's items span 38%, so the title legitimately
     * budgets more characters (55) than an item (45) despite rendering larger — an unconditional
     * comparison flags that as a bug when it is simply a wider box.
     */
    const WIDTH_TOLERANCE = 1.25;

    for (const layout of LAYOUTS) {
      const big = layout.slots.filter((s) => s.typeRole === "display" || s.typeRole === "title");
      const body = layout.slots.filter((s) => s.typeRole === "body");

      for (const b of big) {
        const bigZone = zoneFor(layout.defaultZones, b.key);
        if (!bigZone) continue;

        for (const s of body) {
          const bodyZone = zoneFor(layout.defaultZones, s.key);
          if (!bodyZone) continue;
          if (bigZone.w > bodyZone.w * WIDTH_TOLERANCE) continue;

          expect(
            perItemBudget(b),
            `${layout.id}: "${b.key}" (${b.typeRole}, ${bigZone.w}% wide) budgets more characters than `
            + `"${s.key}" (body, ${bodyZone.w}% wide) despite rendering at a larger point size.`,
          ).toBeLessThanOrEqual(perItemBudget(s));
        }
      }
    }
  });

  it("writes the measured budget/capacity table for the record (VERIFICATION.md §2 step 8)", () => {
    /*
     * An artifact rather than a `console.log`, which vitest swallows by default. The numbers behind the
     * ⚠️ VERIFY on per-face advance (`capacity.ts`) belong in a file that can be diffed and cited,
     * because the day the advance IS measured per face, this table is what says which budgets move.
     */
    const rows = checks
      .map((c) => ({ ...c, ratio: c.budget / c.capacity }))
      .sort((a, b) => b.ratio - a.ratio);

    expect(rows.length, "no budgets were measured — the per-slot cases did not run").toBeGreaterThan(0);

    const table = [
      `# Layout budget vs zone capacity (limit ${HEADROOM * 100}% of estimated capacity)`,
      "#",
      "# Generated by tests/layout-budgets.test.ts. Capacity is estimated at 0.5em mean advance",
      "# (capacity.ts — ⚠️ VERIFY: not measured per font face). Sorted by tightest fit first.",
      "",
      "slot\tbudget\tcapacity\tused",
      ...rows.map((r) => `${r.layout}.${r.slot}\t${r.budget}\t${r.capacity}\t${(r.ratio * 100).toFixed(0)}%`),
    ].join("\n");

    const dir = new URL("./__artifacts__/", import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL("layout-budgets.tsv", dir), `${table}\n`);
  });
});

const perItemBudget = (spec: SlotSpec): number =>
  spec.type === "list" ? spec.itemMaxChars ?? spec.maxChars : spec.maxChars;
