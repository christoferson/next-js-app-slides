/**
 * The layout registry — the array, and the invariants that protect it (CLAUDE.md §4, §10).
 *
 * ## The one-line contract
 *
 * Adding a layout is: one file in `defs/`, one import, one entry in `LAYOUTS`. Nothing else. Every
 * consumer — `/api/registry/layouts`, the brand editor's zone seeding, the mapping rules' intents,
 * prompt construction, slot validation, the workspace switcher, the exporter — reads from here, so
 * there is no second place to remember. §10 makes that provable: `git diff --stat` for a new layout
 * must show exactly the new file and this file.
 *
 * ## Why the checks run at module load
 *
 * `assertRegistryInvariants()` runs at import time and throws. That is deliberate, and it is the one
 * place in this codebase where a throw at load is the right call:
 *
 *   - The failures it catches are *authoring* mistakes in static data — a required slot with no zone, a
 *     duplicate id, a `SlotSpec` that declares `maxItems` on a text slot. They cannot be triggered by
 *     user input or by a model response, so failing fast can never take down a request that would
 *     otherwise have worked.
 *   - The consequence of not catching them is silent and much worse. A required slot missing from
 *     `defaultZones` doesn't error anywhere: `zoneFor` returns `undefined`, the painter skips the slot,
 *     and the deck exports with the content simply absent — on a slide the model filled in correctly.
 *     That is the blank-slide failure §13 forbids, arriving by the back door.
 *
 * A test asserting the same thing would catch it in CI, and `tests/layout-registry.test.ts` does. The
 * load-time check is what makes it impossible to *ship* past a red test, which is what §4 asks for.
 */

import type { SlotZone } from "@/lib/brand/types";
import type { LayoutLookup } from "@/lib/brand/brand-schema";
import type { SlideLayout, SlotSpec } from "@/lib/layouts/types";
import { requiredSlots } from "@/lib/layouts/types";

import { titleLayout } from "@/lib/layouts/defs/title";
import { agendaLayout } from "@/lib/layouts/defs/agenda";
import { sectionDividerLayout } from "@/lib/layouts/defs/section-divider";
import { bulletsLayout } from "@/lib/layouts/defs/bullets";
import { twoColumnLayout } from "@/lib/layouts/defs/two-column";
import { quoteLayout } from "@/lib/layouts/defs/quote";
import { statsLayout } from "@/lib/layouts/defs/stats";
import { closingLayout } from "@/lib/layouts/defs/closing";

/** The seed set (SPEC §6). One line per layout — that is the whole extension mechanism. */
export const LAYOUTS: readonly SlideLayout[] = [
  titleLayout,
  agendaLayout,
  sectionDividerLayout,
  bulletsLayout,
  twoColumnLayout,
  quoteLayout,
  statsLayout,
  closingLayout,
];

/**
 * The layout every failure path lands on (SPEC §6/§7.3).
 *
 * Named as a constant, and asserted below to exist and to be renderable from `title` + `items` alone,
 * because `FallbackHandler` depends on both: if this layout ever grew a third required slot, every
 * fallback slide would render incomplete precisely when something had already gone wrong.
 */
export const FALLBACK_LAYOUT_ID = "bullets";

const byId = new Map<string, SlideLayout>(LAYOUTS.map((l) => [l.id, l]));

/* ─────────────────────────────── lookups ─────────────────────────────── */

export const allLayouts = (): readonly SlideLayout[] => LAYOUTS;

export const findLayout = (layoutId: string): SlideLayout | undefined => byId.get(layoutId);

/** For call sites that cannot proceed without one — e.g. rendering a persisted slide. */
export function requireLayout(layoutId: string): SlideLayout {
  const layout = byId.get(layoutId);
  if (!layout) {
    // Readable, and deliberately does not echo the id back verbatim beyond quoting it — layoutIds are
    // registry keys validated at the schema edge, not free text.
    throw new Error(`Unknown layout "${layoutId}". Known layouts: ${[...byId.keys()].join(", ")}.`);
  }
  return layout;
}

export const fallbackLayout = (): SlideLayout => requireLayout(FALLBACK_LAYOUT_ID);

/** Layouts declaring a given `visualHint` — `IntentMatchRule`'s whole data source (SPEC §7.2). */
export const layoutsForIntent = (intent: string): readonly SlideLayout[] =>
  LAYOUTS.filter((l) => (l.intents as readonly string[]).includes(intent));

/**
 * The registry seen through `brand-schema.ts`'s injected port.
 *
 * That module cannot import this one (it would be circular, and it would pull React `FallbackRenderer`
 * values into brand validation) so it declares `LayoutLookup` and takes it as a parameter. This is the
 * production adapter; tests pass stubs.
 */
export const registryLookup: LayoutLookup = {
  layout(layoutId: string) {
    const layout = byId.get(layoutId);
    if (!layout) return undefined;
    return {
      slotKeys: layout.slots.map((s) => s.key),
      requiredSlotKeys: requiredSlots(layout).map((s) => s.key),
    };
  },
};

/** What `/api/registry/layouts` returns — no React, no functions (SPEC §11). */
export interface LayoutSummary {
  id: string;
  displayName: string;
  description: string;
  intents: readonly string[];
  slots: readonly SlotSpec[];
  defaultZones: readonly SlotZone[];
}

export const layoutSummaries = (): LayoutSummary[] =>
  LAYOUTS.map((l) => ({
    id: l.id,
    displayName: l.displayName,
    description: l.description,
    intents: l.intents,
    slots: l.slots,
    defaultZones: l.defaultZones,
  }));

/* ────────────────────────── load-time invariants ────────────────────────── */

const SLOT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const LAYOUT_ID = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Checks that concern ONE layout in isolation.
 *
 * Split from the whole-registry checks below so a candidate layout can be validated on its own — which
 * is what §10's one-file-layout proof needs, and what keeps a single broken layout's report free of
 * cross-layout noise. Returns problems rather than throwing so every one is reported at once.
 */
export function layoutProblems(layout: SlideLayout): string[] {
  const problems: string[] = [];
  const where = `layout "${layout.id}"`;

  if (!LAYOUT_ID.test(layout.id)) {
    problems.push(`${where}: id must be lower_snake_case (it appears in URLs and brand config keys).`);
  }

  if (layout.displayName.trim() === "") problems.push(`${where}: displayName is empty.`);
  if (layout.description.trim() === "") problems.push(`${where}: description is empty.`);
  if (layout.intents.length === 0) {
    problems.push(`${where}: declares no intents, so mapping can never select it.`);
  }
  if (layout.slots.length === 0) problems.push(`${where}: declares no slots.`);

  const seenSlots = new Set<string>();
  for (const slot of layout.slots) {
    const at = `${where} slot "${slot.key}"`;
    if (!SLOT_KEY.test(slot.key)) {
      problems.push(`${at}: key must match ${SLOT_KEY.source} — it is a JSON key in model output.`);
    }
    if (seenSlots.has(slot.key)) problems.push(`${at}: duplicate slot key.`);
    seenSlots.add(slot.key);

    if (slot.description.trim() === "") {
      problems.push(`${at}: description is empty — it is the model's only guidance for this slot.`);
    }
    if (!Number.isInteger(slot.maxChars) || slot.maxChars <= 0) {
      problems.push(`${at}: maxChars must be a positive integer (§1.1/C1 — truncation is the only guard).`);
    }

    if (slot.type === "list") {
      if (slot.maxItems === undefined || !Number.isInteger(slot.maxItems) || slot.maxItems <= 0) {
        problems.push(`${at}: list slots must declare a positive integer maxItems.`);
      }
      if (slot.itemMaxChars === undefined || !Number.isInteger(slot.itemMaxChars) || slot.itemMaxChars <= 0) {
        problems.push(`${at}: list slots must declare a positive integer itemMaxChars.`);
      }
    } else {
      if (slot.maxItems !== undefined) problems.push(`${at}: maxItems is meaningless on a text slot.`);
      if (slot.itemMaxChars !== undefined) {
        problems.push(`${at}: itemMaxChars is meaningless on a text slot.`);
      }
    }
  }

  // THE check §4 names explicitly. A required slot with no zone renders as absent content on an
  // otherwise-correct slide — silent, and indistinguishable from a model that omitted the field.
  const zoned = new Set(layout.defaultZones.map((z) => z.slotKey));
  for (const slot of requiredSlots(layout)) {
    if (!zoned.has(slot.key)) {
      problems.push(
        `${where}: required slot "${slot.key}" has no entry in defaultZones, so it would render `
        + "nowhere. Every required slot must be positioned.",
      );
    }
  }

  // The reverse direction is a real bug too: a zone for a slot that doesn't exist means the brand
  // editor shows a row the model is never asked to fill.
  for (const zone of layout.defaultZones) {
    if (!seenSlots.has(zone.slotKey)) {
      problems.push(`${where}: defaultZones positions "${zone.slotKey}", which is not one of its slots.`);
    }
  }

  const seenZones = new Set<string>();
  for (const zone of layout.defaultZones) {
    if (seenZones.has(zone.slotKey)) {
      problems.push(`${where}: two defaultZones entries for slot "${zone.slotKey}".`);
    }
    seenZones.add(zone.slotKey);

    // The same bounds `brand-schema.ts` enforces on user zones. §1.1/C4: pptxgenjs clamps nothing,
    // so an out-of-bounds default would place text off the slide with no warning.
    const bad = zone.x < 0 || zone.y < 0 || zone.w <= 0 || zone.h <= 0
      || zone.x + zone.w > 100.000001 || zone.y + zone.h > 100.000001;
    if (bad) {
      problems.push(
        `${where}: defaultZones entry for "${zone.slotKey}" is outside the slide `
        + `(x:${zone.x} y:${zone.y} w:${zone.w} h:${zone.h}).`,
      );
    }
  }

  return problems;
}

/** The fallback layout's contract, checked wherever it appears in a candidate set (SPEC §7.3). */
function fallbackProblems(layouts: readonly SlideLayout[]): string[] {
  const fallback = layouts.find((l) => l.id === FALLBACK_LAYOUT_ID);
  if (!fallback) return [];

  const required = requiredSlots(fallback).map((s) => s.key).sort();
  const expected = ["items", "title"];
  if (required.join(",") === expected.join(",")) return [];

  return [
    `the fallback layout "${FALLBACK_LAYOUT_ID}" must require exactly ${expected.join(" + ")} `
    + `(it requires ${required.join(" + ") || "nothing"}). FallbackHandler can only supply those two `
    + "from an outline entry, so any other required slot would render blank on every failure.",
  ];
}

/**
 * Every check that must hold for the registry to be safe to build on: each layout in isolation, plus
 * the cross-layout rules (unique ids, the fallback layout's existence and shape).
 *
 * Callers validating a *candidate* layout on its own want `layoutProblems` — the registry-wide rules
 * would otherwise report the absent fallback layout as that candidate's problem.
 */
export function registryProblems(layouts: readonly SlideLayout[] = LAYOUTS): string[] {
  const problems = layouts.flatMap(layoutProblems);

  const seen = new Set<string>();
  for (const layout of layouts) {
    if (seen.has(layout.id)) {
      problems.push(`layout "${layout.id}": duplicate id — registry ids must be unique.`);
    }
    seen.add(layout.id);
  }

  if (!seen.has(FALLBACK_LAYOUT_ID)) {
    problems.push(`FALLBACK_LAYOUT_ID "${FALLBACK_LAYOUT_ID}" is not in the registry.`);
  }
  problems.push(...fallbackProblems(layouts));

  return problems;
}

export function assertRegistryInvariants(layouts: readonly SlideLayout[] = LAYOUTS): void {
  const problems = registryProblems(layouts);
  if (problems.length > 0) {
    throw new Error(
      `Layout registry is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

assertRegistryInvariants();
