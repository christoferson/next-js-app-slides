/**
 * Slot values — the content payload of a slide, keyed by a layout's `SlotSpec.key`.
 *
 * Deliberately primitive: `string` for text slots, `string[]` for list slots. Nothing here
 * knows about fonts, colours, or coordinates — a slide's *content* and its *appearance* are
 * separate by construction, which is what makes "brand swap re-themes with zero content
 * change" (SPEC §13) true rather than aspirational.
 */
export type SlotValue = string | string[];

export type SlotValues = Readonly<Record<string, SlotValue>>;

/** Narrowing helpers — slot values arrive from JSON, so call sites must not assume. */
export const isTextSlot = (v: SlotValue | undefined): v is string => typeof v === "string";
export const isListSlot = (v: SlotValue | undefined): v is string[] => Array.isArray(v);
