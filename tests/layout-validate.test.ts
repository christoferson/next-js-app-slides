/**
 * `validate.ts` — the SlotSpec→zod compiler, the truncation pass, and the flag rules.
 *
 * This is where CLAUDE.md §9's matrix rows about *content* live (the model-error and abort rows belong to
 * the generation pipeline, step 11). The two behaviours worth stating plainly:
 *
 *  - **Over budget is not a validation failure.** §9 requires "valid JSON, one field over budget →
 *    truncated at word boundary + `trimmed` flag". Spending the single repair call on something we can
 *    fix deterministically would waste it.
 *  - **Only lost content earns `trimmed`.** An absent optional slot and a hallucinated extra key are
 *    both adjustments, but neither is a quality problem the user should see an amber badge for. If they
 *    flagged, nearly every slide would wear one and the badge would stop meaning anything.
 */

import { describe, expect, it } from "vitest";
import type { SlideLayout, SlotSpec } from "@/lib/layouts/types";
import {
  SPEAKER_NOTES_MAX_CHARS, compileSlideResponseSchema, describeSlotIssues,
  normalizeSlots, slotBudgets, truncateAtWordBoundary, validateAndNormalize, validateSlots,
} from "@/lib/layouts/validate";
import { bulletsLayout } from "@/lib/layouts/defs/bullets";

/** A layout with round budgets, so the arithmetic in each expectation is obvious. */
const layout: SlideLayout = {
  id: "probe",
  displayName: "Probe",
  description: "Budget fixture.",
  intents: ["detail"],
  slots: [
    { key: "title", type: "text", required: true, typeRole: "title", maxChars: 20, description: "T." },
    {
      key: "items", type: "list", required: true, typeRole: "body",
      maxChars: 60, maxItems: 3, itemMaxChars: 20, description: "I.",
    },
    { key: "note", type: "text", required: false, typeRole: "caption", maxChars: 30, description: "N." },
  ],
  defaultZones: [
    { slotKey: "title", x: 8, y: 10, w: 84, h: 20, align: "left", valign: "top" },
    { slotKey: "items", x: 8, y: 34, w: 84, h: 48, align: "left", valign: "top" },
    { slotKey: "note", x: 8, y: 86, w: 60, h: 8, align: "left", valign: "top" },
  ],
  FallbackRenderer: () => null,
  toPptx: () => {},
};

const spec = (key: string): SlotSpec => layout.slots.find((s) => s.key === key)!;

describe("truncateAtWordBoundary", () => {
  it("leaves text within budget untouched", () => {
    expect(truncateAtWordBoundary("short", 20)).toBe("short");
  });

  it("leaves text exactly at budget untouched", () => {
    expect(truncateAtWordBoundary("12345", 5)).toBe("12345");
  });

  it("cuts at a word boundary and marks it", () => {
    // 17 chars of budget before the ellipsis, so the boundary lands after "brown".
    const result = truncateAtWordBoundary("the quick brown fox jumps", 20);
    expect(result).toBe("the quick brown…");
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("keeps the ellipsis INSIDE the budget", () => {
    // Otherwise truncation would itself overflow the box it exists to protect.
    for (const max of [8, 12, 20, 33, 40]) {
      const result = truncateAtWordBoundary("a".repeat(10) + " " + "b".repeat(60), max);
      expect(result.length, `budget ${max}`).toBeLessThanOrEqual(max);
    }
  });

  it("cuts mid-word rather than collapsing a long unbroken token", () => {
    // A URL, a compound noun, or CJK with no spaces. A word boundary here would leave almost nothing,
    // which loses more meaning than a mid-word cut does.
    const url = "https://example.com/a/very/long/path/that/never/breaks";
    expect(truncateAtWordBoundary(url, 20)).toBe("https://example.com…");
  });

  it("uses a word boundary only when it keeps ≥60% of the budget", () => {
    // The only space is at index 2, far below 60% of the 17-char budget, so cut mid-word instead of
    // collapsing the field to "aa…".
    expect(truncateAtWordBoundary("aa " + "b".repeat(30), 20)).toBe("aa bbbbbbbbbbbbbbbb…");
  });

  it("strips dangling punctuation before the ellipsis", () => {
    // The boundary falls after "three," — the comma would otherwise read as ",…".
    expect(truncateAtWordBoundary("one two three, four five", 20)).toBe("one two three…");
  });

  it("handles degenerate budgets without throwing", () => {
    expect(truncateAtWordBoundary("anything", 0)).toBe("");
    expect(truncateAtWordBoundary("anything", -5)).toBe("");
    expect(truncateAtWordBoundary("anything", 1)).toHaveLength(1);
  });

  it("never returns more than the budget, for any budget", () => {
    const text = "The quick brown fox jumps over the lazy dog again and again";
    for (let max = 1; max <= 60; max += 1) {
      expect(truncateAtWordBoundary(text, max).length, `budget ${max}`).toBeLessThanOrEqual(max);
    }
  });
});

describe("normalizeSlots — §9's content rows", () => {
  it("valid slots within budget: no flags, no adjustments", () => {
    const result = normalizeSlots(layout, { title: "Short title", items: ["one", "two"] });
    expect(result.flags).toEqual([]);
    expect(result.adjustments).toEqual([]);
    expect(result.slots).toEqual({ title: "Short title", items: ["one", "two"] });
  });

  it("one field over budget: truncated at a word boundary + trimmed flag", () => {
    const result = normalizeSlots(layout, {
      title: "A title far longer than twenty characters",
      items: ["one"],
    });
    expect(result.flags).toEqual(["trimmed"]);
    expect(result.slots.title).toBe("A title far longer…");
    expect(result.adjustments).toContainEqual({
      slotKey: "title", kind: "truncated", detail: "41 → 20 chars",
    });
  });

  it("too many items: extras dropped + trimmed flag", () => {
    const result = normalizeSlots(layout, { title: "T", items: ["a", "b", "c", "d", "e"] });
    expect(result.slots.items).toEqual(["a", "b", "c"]);
    expect(result.flags).toEqual(["trimmed"]);
    expect(result.adjustments).toContainEqual({
      slotKey: "items", kind: "items-dropped", detail: "5 → 3 items",
    });
  });

  it("one over-long item: that item truncated, others untouched", () => {
    const result = normalizeSlots(layout, {
      title: "T", items: ["fine", "this item is far too long to fit", "also fine"],
    });
    const items = result.slots.items as string[];
    expect(items[0]).toBe("fine");
    expect(items[2]).toBe("also fine");
    expect(items[1]!.length).toBeLessThanOrEqual(20);
    expect(result.flags).toEqual(["trimmed"]);
    expect(result.adjustments.some((a) => a.kind === "item-truncated")).toBe(true);
  });

  it("an empty optional slot is dropped WITHOUT a trimmed flag", () => {
    // The rule that keeps the badge meaningful: nothing was lost, the field was simply absent.
    const result = normalizeSlots(layout, { title: "T", items: ["a"], note: "   " });
    expect(result.slots).not.toHaveProperty("note");
    expect(result.flags).toEqual([]);
    expect(result.adjustments).toContainEqual({ slotKey: "note", kind: "empty-dropped" });
  });

  it("a hallucinated slot is dropped WITHOUT a trimmed flag", () => {
    const result = normalizeSlots(layout, { title: "T", items: ["a"], invented: "noise" });
    expect(result.slots).not.toHaveProperty("invented");
    expect(result.flags).toEqual([]);
    expect(result.adjustments).toContainEqual({ slotKey: "invented", kind: "unknown-slot-dropped" });
  });

  it("flags are a set, not a tally: many adjustments still yield one trimmed", () => {
    const result = normalizeSlots(layout, {
      title: "A title far longer than twenty characters",
      items: ["x".repeat(40), "y".repeat(40), "z".repeat(40), "dropped"],
    });
    expect(result.flags).toEqual(["trimmed"]);
    expect(result.adjustments.length).toBeGreaterThan(2);
  });

  it("blank items are removed before the item cap is applied", () => {
    const result = normalizeSlots(layout, { title: "T", items: ["a", "", "b", "  ", "c"] });
    expect(result.slots.items).toEqual(["a", "b", "c"]);
    expect(result.adjustments.some((a) => a.kind === "items-dropped")).toBe(false);
  });

  it("a list slot given a newline string is split rather than rejected", () => {
    const result = normalizeSlots(layout, { title: "T", items: "one\ntwo\nthree" as never });
    expect(result.slots.items).toEqual(["one", "two", "three"]);
  });

  it("a list slot given a bulleted string has its markers stripped", () => {
    const result = normalizeSlots(layout, { title: "T", items: "- one\n* two\n3. three" as never });
    expect(result.slots.items).toEqual(["one", "two", "three"]);
  });

  it("a text slot given an array is joined rather than dropped", () => {
    const result = normalizeSlots(layout, { title: ["Two", "parts"] as never, items: ["a"] });
    expect(result.slots.title).toBe("Two parts");
  });

  it("a list that normalizes to nothing is dropped, not left empty", () => {
    // An empty array would render as an empty text box; absent is honest.
    const result = normalizeSlots(layout, { title: "T", items: ["", "  "] });
    expect(result.slots).not.toHaveProperty("items");
  });

  it("never throws on off-contract values", () => {
    /*
     * `normalizeSlots` runs on stored slides, JSON imports, and applied repair responses — none of
     * which necessarily passed `compileSlotSchema` first. A `.trim()` on a number here is a 500 on the
     * render path, so the coercion has to be total. This is the promise in its doc comment, tested.
     */
    const hostile: unknown[] = [
      {}, { title: null }, { items: null }, { items: [null] }, { title: 42 }, { items: {} },
      { title: { nested: true } }, { items: [["nested"]] }, { title: true }, { items: 7 },
    ];
    for (const input of hostile) {
      expect(() => normalizeSlots(layout, input as never), JSON.stringify(input)).not.toThrow();
    }
  });

  it("stringifies a number in a text slot and a list slot alike", () => {
    expect(normalizeSlots(layout, { title: 42 as never, items: ["a"] }).slots.title).toBe("42");
    expect(normalizeSlots(layout, { title: "T", items: 42 as never }).slots.items).toEqual(["42"]);
  });

  it("drops a value with no sensible text form rather than rendering [object Object]", () => {
    const result = normalizeSlots(layout, { title: { nested: true } as never, items: ["a"] });
    expect(result.slots).not.toHaveProperty("title");
  });
});

describe("compileSlotSchema", () => {
  it("accepts a well-formed response", () => {
    const result = validateSlots(layout, { title: "T", items: ["a", "b"] });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing required slot, with a path for the repair pass", () => {
    const result = validateSlots(layout, { items: ["a"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "title")).toBe(true);
  });

  it("coerces a number into a text slot — models do this on stats-like fields", () => {
    const result = validateSlots(layout, { title: 42, items: ["a"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("42");
  });

  it("coerces a newline string into a list slot", () => {
    const result = validateSlots(layout, { title: "T", items: "one\ntwo" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual(["one", "two"]);
  });

  it("rejects a structurally wrong shape rather than guessing", () => {
    // An object where a list belongs is not recoverable deterministically — that IS repair's job.
    expect(validateSlots(layout, { title: "T", items: { a: 1 } }).ok).toBe(false);
    expect(validateSlots(layout, { title: { text: "T" }, items: ["a"] }).ok).toBe(false);
  });

  it("strips unknown keys instead of failing the slide", () => {
    const result = validateSlots(layout, { title: "T", items: ["a"], invented: "noise" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("invented");
  });

  it("omits an absent optional slot without complaint", () => {
    const result = validateSlots(layout, { title: "T", items: ["a"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("note");
  });

  it("ignores budgets by default", () => {
    expect(validateSlots(layout, { title: "x".repeat(500), items: ["a"] }).ok).toBe(true);
  });

  it("enforces budgets when asked — the user-edit path", () => {
    // Silently rewriting what someone typed would be wrong; the editor reports instead.
    const result = validateSlots(
      layout, { title: "x".repeat(500), items: ["a"] }, { enforceBudgets: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.message).toMatch(/20 characters or fewer/);
  });

  it("enforces item count and item length when asked", () => {
    const tooMany = validateSlots(
      layout, { title: "T", items: ["a", "b", "c", "d"] }, { enforceBudgets: true },
    );
    expect(tooMany.ok).toBe(false);

    const tooLong = validateSlots(
      layout, { title: "T", items: ["x".repeat(40)] }, { enforceBudgets: true },
    );
    expect(tooLong.ok).toBe(false);
  });

  it("compiles from the layout's own specs — a real registry layout round-trips", () => {
    const result = validateSlots(bulletsLayout, {
      title: "A claim", items: ["one", "two"], takeaway: "So what",
    });
    expect(result.ok).toBe(true);
  });
});

describe("compileSlideResponseSchema", () => {
  it("accepts slots plus speaker notes", () => {
    const parsed = compileSlideResponseSchema(layout).safeParse({
      slots: { title: "T", items: ["a"] }, speakerNotes: "Say this.",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a response with no notes", () => {
    const parsed = compileSlideResponseSchema(layout).safeParse({ slots: { title: "T", items: ["a"] } });
    expect(parsed.success).toBe(true);
  });

  it("caps notes at the SPEC §6 limit when enforcing", () => {
    const parsed = compileSlideResponseSchema(layout, { enforceBudgets: true }).safeParse({
      slots: { title: "T", items: ["a"] },
      speakerNotes: "x".repeat(SPEAKER_NOTES_MAX_CHARS + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a response missing slots entirely", () => {
    expect(compileSlideResponseSchema(layout).safeParse({ speakerNotes: "n" }).success).toBe(false);
  });
});

describe("validateAndNormalize — the happy path", () => {
  it("validates then fits, so a budget overrun costs a flag not a repair call", () => {
    const result = validateAndNormalize(layout, {
      title: "A title far longer than twenty characters", items: ["a"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.flags).toEqual(["trimmed"]);
  });

  it("reports issues when the response is genuinely unusable", () => {
    const result = validateAndNormalize(layout, { items: ["a"] });
    expect(result.ok).toBe(false);
  });
});

describe("describeSlotIssues — written for the model, not the user", () => {
  it("names the field and states the requirement", () => {
    const result = validateSlots(layout, { items: ["a"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const described = describeSlotIssues(result.issues);
    expect(described.some((d) => d.startsWith('"title":'))).toBe(true);
  });

  it("contains no visual vocabulary (§7)", () => {
    const result = validateSlots(layout, { title: 0, items: {} });
    if (result.ok) return;
    const text = describeSlotIssues(result.issues).join(" ");
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(text).not.toMatch(/\b(?:font|colour|color|pixel|inch|coordinate)\b/i);
  });
});

describe("slotBudgets — the workspace counters", () => {
  it("reports usage against each slot's budget", () => {
    const budgets = slotBudgets(layout, { title: "12345", items: ["ab", "cde"] });
    const title = budgets.find((b) => b.key === "title")!;
    expect(title).toMatchObject({ used: 5, max: 20, over: false });
  });

  it("turns over when a text slot exceeds its budget", () => {
    const budgets = slotBudgets(layout, { title: "x".repeat(21), items: [] });
    expect(budgets.find((b) => b.key === "title")!.over).toBe(true);
  });

  it("reports the LONGEST item for a list slot, since that is what overflows", () => {
    const budgets = slotBudgets(layout, { title: "T", items: ["ab", "x".repeat(25)] });
    const items = budgets.find((b) => b.key === "items")!;
    expect(items.used).toBe(25);
    expect(items.over).toBe(true);
  });

  it("reports item count separately from item length", () => {
    const budgets = slotBudgets(layout, { title: "T", items: ["a", "b", "c", "d"] });
    const items = budgets.find((b) => b.key === "items")!;
    expect(items.items).toEqual({ used: 4, max: 3, over: true });
    expect(items.over).toBe(false);
  });

  it("reports zero usage for an absent slot rather than omitting it", () => {
    // The editor needs a counter for every slot, including ones the model left empty.
    const budgets = slotBudgets(layout, {});
    expect(budgets.map((b) => b.key)).toEqual(["title", "items", "note"]);
    expect(budgets.every((b) => b.used === 0)).toBe(true);
  });

  it("covers every slot of every registry layout without throwing", () => {
    expect(() => slotBudgets(bulletsLayout, {})).not.toThrow();
    expect(slotBudgets(bulletsLayout, {})).toHaveLength(bulletsLayout.slots.length);
  });
});

describe("the spec fixture itself", () => {
  it("declares the budgets the assertions above depend on", () => {
    // Guards the test file: if someone retunes the fixture, the arithmetic in every expectation moves.
    expect(spec("title").maxChars).toBe(20);
    expect(spec("items").maxItems).toBe(3);
    expect(spec("items").itemMaxChars).toBe(20);
  });
});
