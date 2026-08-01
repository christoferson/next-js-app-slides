/**
 * §2 step 12 — `DeckService` against memory repos, wired through the container (§6.3).
 *
 * The guarantees under test are the ones this layer adds over `DeckRepository`, which stores whatever it
 * is handed:
 *
 *   - **`order` is dense and contiguous** after every mutation. The repository has no opinion about
 *     positions; this service's delete/duplicate/reorder paths are the only thing keeping `0,1,2` from
 *     drifting to `0,1,3` — and that drift only surfaces as a slide landing in the wrong place several
 *     edits later, which is why it is asserted directly rather than through behaviour.
 *   - **Budgets are enforced on the USER's typing only** (§7.4 / §1.1-C1). The asymmetry with the
 *     generation path is deliberate, and the layout-switch case is where it earns its keep.
 *   - **`trimmed` is recomputed, other flags survive.** A stale amber badge on corrected content teaches
 *     users to ignore badges.
 *   - **A brand swap writes one field and touches zero slides** (SPEC §13).
 */

import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors/errors";
import { LAYOUTS, requireLayout } from "@/lib/layouts/registry";
import { carryOverSlots } from "@/lib/services/deck-service";
import { brandInput, harness, type Harness } from "@/tests/service-harness";

async function rejectsWith(code: string, run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (err) {
    expect(err, `expected an AppError, got ${String(err)}`).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`expected ${code}, but the call resolved`);
}

/** A deck over a real brand — decks reference a brand id, and the export/generate paths resolve it. */
async function deck(h: Harness, title = "Q3 Review") {
  const brand = await h.services.brands.create(h.userId, brandInput());
  return h.services.decks.create(h.userId, { title, brandId: brand.id });
}

/** Three `bullets` slides, ordered 0,1,2 — the shape most order assertions start from. */
async function threeSlides(h: Harness, deckId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const slide = await h.services.decks.addSlide(h.userId, deckId, {
      layoutId: "bullets",
      slots: { title: `Slide ${n}`, items: [`Point ${n}a`, `Point ${n}b`] },
    });
    ids.push(slide.id);
  }
  return ids;
}

const orders = async (h: Harness, deckId: string): Promise<number[]> =>
  (await h.services.decks.listSlides(h.userId, deckId)).map((s) => s.order);

const titles = async (h: Harness, deckId: string): Promise<unknown[]> =>
  (await h.services.decks.listSlides(h.userId, deckId)).map((s) => s.slots.title);

describe("DeckService — deck lifecycle", () => {
  it("assigns id and timestamps, and scopes by user", async () => {
    const h = harness();
    const created = await deck(h);

    expect(created.userId).toBe(h.userId);
    expect(created.createdAt).toBe(h.clock.iso());
    expect(created.updatedAt).toBe(created.createdAt);

    await rejectsWith("DeckNotFound", () => h.services.decks.getMeta("user-b", created.id));
  });

  it("patches only the named field, and touches updatedAt", async () => {
    const h = harness();
    const created = await deck(h);

    const at = h.clock.tick();
    const renamed = await h.services.decks.setTitle(h.userId, created.id, "Renamed");

    expect(renamed.title).toBe("Renamed");
    expect(renamed.updatedAt).toBe(at);
    expect(renamed.createdAt).toBe(created.createdAt);
    expect(renamed.brandId).toBe(created.brandId);
  });

  it("swaps the brand with ZERO slide writes (SPEC §13)", async () => {
    const h = harness();
    const created = await deck(h);
    await threeSlides(h, created.id);
    const before = await h.services.decks.listSlides(h.userId, created.id);

    const other = await h.services.brands.create(h.userId, brandInput({ name: "Second" }));
    h.clock.tick();
    const swapped = await h.services.decks.setBrand(h.userId, created.id, other.id);

    expect(swapped.brandId).toBe(other.id);
    // Content unchanged AND untouched: `updatedAt` on every slide is identical, so the re-theme is
    // genuinely a read-time concern rather than a rewrite (§11 step 10).
    expect(await h.services.decks.listSlides(h.userId, created.id)).toEqual(before);
  });

  it("404s an unknown deck rather than returning an empty one", async () => {
    const h = harness();
    await rejectsWith("DeckNotFound", () => h.services.decks.getMeta(h.userId, "nope"));
    await rejectsWith("DeckNotFound", () => h.services.decks.getFull(h.userId, "nope"));
  });

  it("cascades slide deletion when the deck is deleted", async () => {
    const h = harness();
    const created = await deck(h);
    await threeSlides(h, created.id);

    await h.services.decks.delete(h.userId, created.id);

    await rejectsWith("DeckNotFound", () => h.services.decks.getMeta(h.userId, created.id));
    // Recreating a deck must not resurrect the old slides — the cascade is the repository's contract
    // (§6), and this is the service-level consequence the workspace depends on.
    const again = await deck(h);
    await expect(h.services.decks.listSlides(h.userId, again.id)).resolves.toEqual([]);
  });
});

describe("DeckService — order stays dense and contiguous", () => {
  it("appends at the end", async () => {
    const h = harness();
    const created = await deck(h);
    await threeSlides(h, created.id);
    expect(await orders(h, created.id)).toEqual([0, 1, 2]);
  });

  it("closes the gap on delete", async () => {
    const h = harness();
    const created = await deck(h);
    const [, second] = await threeSlides(h, created.id);

    await h.services.decks.deleteSlide(h.userId, created.id, second!);

    // `0,1` — not `0,2`. Without the renumber every later insert-at-position computes from a wrong base.
    expect(await orders(h, created.id)).toEqual([0, 1]);
    expect(await titles(h, created.id)).toEqual(["Slide 1", "Slide 3"]);
  });

  it("inserts a duplicate directly after its original, renumbering the rest", async () => {
    const h = harness();
    const created = await deck(h);
    const [first] = await threeSlides(h, created.id);

    const copy = await h.services.decks.duplicateSlide(h.userId, created.id, first!);

    // Position 1, not appended at 3 — a user duplicating slide 1 wants the variant next to it.
    expect(copy.order).toBe(1);
    expect(await orders(h, created.id)).toEqual([0, 1, 2, 3]);
    expect(await titles(h, created.id)).toEqual(["Slide 1", "Slide 1", "Slide 2", "Slide 3"]);
    expect(copy.id).not.toBe(first);
  });

  it("deep-copies a duplicate's slots so editing one doesn't change the other", async () => {
    const h = harness();
    const created = await deck(h);
    const [first] = await threeSlides(h, created.id);
    const copy = await h.services.decks.duplicateSlide(h.userId, created.id, first!);

    await h.services.decks.updateSlide(h.userId, created.id, copy.id, {
      slots: { items: ["Changed"] },
    });

    const original = await h.services.decks.getSlide(h.userId, created.id, first!);
    // `structuredClone` in `duplicateSlide` is what makes this hold — a shallow spread would share
    // the `items` array, and in the memory backend that aliasing is visible immediately.
    expect(original.slots.items).toEqual(["Point 1a", "Point 1b"]);
  });

  it("applies a reorder all-or-nothing and rejects a non-permutation", async () => {
    const h = harness();
    const created = await deck(h);
    const [a, b, c] = await threeSlides(h, created.id);

    const reordered = await h.services.decks.reorderSlides(h.userId, created.id, [c!, a!, b!]);
    expect(reordered.map((s) => s.slots.title)).toEqual(["Slide 3", "Slide 1", "Slide 2"]);
    expect(reordered.map((s) => s.order)).toEqual([0, 1, 2]);

    // A partial list, a duplicate, and an unknown id are all malformed REQUESTS, not missing slides.
    for (const bad of [[a!, b!], [a!, a!, b!], [a!, b!, "ghost"]]) {
      await rejectsWith("InvalidSlideOrder", () =>
        h.services.decks.reorderSlides(h.userId, created.id, bad));
    }
    // And nothing moved — the repository validates the whole permutation before mutating (§6.5).
    expect((await h.services.decks.listSlides(h.userId, created.id)).map((s) => s.slots.title))
      .toEqual(["Slide 3", "Slide 1", "Slide 2"]);
  });

  it("rejects an empty reorder with a deck-scoped 404 first for an unknown deck", async () => {
    const h = harness();
    const created = await deck(h);
    await rejectsWith("InvalidSlideOrder", () => h.services.decks.reorderSlides(h.userId, created.id, []));
    // The `getMeta` call in `reorderSlides` exists for this: the repository would otherwise report a
    // missing deck as an ordering problem.
    await rejectsWith("DeckNotFound", () => h.services.decks.reorderSlides(h.userId, "nope", ["x"]));
  });

  it("404s slide operations on a slide that isn't there", async () => {
    const h = harness();
    const created = await deck(h);
    await threeSlides(h, created.id);

    for (const call of [
      () => h.services.decks.getSlide(h.userId, created.id, "ghost"),
      () => h.services.decks.updateSlide(h.userId, created.id, "ghost", { slots: { title: "x" } }),
      () => h.services.decks.duplicateSlide(h.userId, created.id, "ghost"),
      () => h.services.decks.deleteSlide(h.userId, created.id, "ghost"),
    ]) {
      await rejectsWith("SlideNotFound", call);
    }
  });
});

describe("DeckService — budgets on a user's own edit (§7.4)", () => {
  it("rejects over-budget typing with the field named, and writes nothing", async () => {
    const h = harness();
    const created = await deck(h);
    const [first] = await threeSlides(h, created.id);
    const max = requireLayout("bullets").slots.find((s) => s.key === "title")!.maxChars;

    const err = await rejectsWith("InvalidSlideContent", () =>
      h.services.decks.updateSlide(h.userId, created.id, first!, {
        slots: { title: "x".repeat(max + 1) },
      }));

    // Rejected with the slot named — NOT truncated. Silently rewriting someone's typing is worse than
    // telling them it does not fit (see `InvalidSlideContent`'s note); the model path truncates instead.
    expect(JSON.stringify(err.detail)).toContain("title");
    expect(err.status).toBe(400);
    const unchanged = await h.services.decks.getSlide(h.userId, created.id, first!);
    expect(unchanged.slots.title).toBe("Slide 1");
    expect(unchanged.flags).toEqual([]);
  });

  it("rejects too many list items typed by hand", async () => {
    const h = harness();
    const created = await deck(h);
    const spec = requireLayout("bullets").slots.find((s) => s.key === "items")!;
    const created2 = await h.services.decks.addSlide(h.userId, created.id, {
      layoutId: "bullets", slots: { title: "T", items: ["a"] },
    });

    await rejectsWith("InvalidSlideContent", () =>
      h.services.decks.updateSlide(h.userId, created.id, created2.id, {
        slots: { items: Array.from({ length: (spec.maxItems ?? 6) + 1 }, (_, i) => `Item ${i}`) },
      }));
  });

  it("rejects an unknown layoutId as a 400, not a 500", async () => {
    const h = harness();
    const created = await deck(h);

    // A layout id from a request body is untrusted input — distinct from `requireLayout`'s throw, which
    // means a *persisted* slide names a removed layout and is correctly a 500.
    const err = await rejectsWith("UnknownLayout", () => h.services.decks.addSlide(h.userId, created.id, {
      layoutId: "notALayout", slots: { title: "T" },
    }));
    expect(err.status).toBe(400);
  });
});

describe("DeckService — layout switch carries slots over (§7.4)", () => {
  it("keeps same-key same-type slots and drops what has nowhere to go", async () => {
    const h = harness();
    const created = await deck(h);
    const slide = await h.services.decks.addSlide(h.userId, created.id, {
      layoutId: "bullets",
      slots: { title: "Kept title", items: ["First point", "Second point"], takeaway: "Dropped" },
    });

    // `bullets` → `title`: `title` is text→text (kept); `items`/`takeaway` don't exist on `title`.
    const switched = await h.services.decks.updateSlide(h.userId, created.id, slide.id, {
      layoutId: "title",
    });

    expect(switched.layoutId).toBe("title");
    expect(switched.slots.title).toBe("Kept title");
    // Dropped, not concatenated into whatever slot remains — concatenation produces text no one wrote.
    expect(switched.slots.items).toBeUndefined();
    expect(switched.slots.takeaway).toBeUndefined();
  });

  it("carries a shared list slot across layouts intact", async () => {
    const h = harness();
    const created = await deck(h);
    const slide = await h.services.decks.addSlide(h.userId, created.id, {
      layoutId: "bullets", slots: { title: "T", items: ["First point", "Second point"] },
    });

    // `items` is a list on both — the same-key/same-type path, which is the one the seed registry
    // actually exercises (see the pure-function test below for why).
    const switched = await h.services.decks.updateSlide(h.userId, created.id, slide.id, {
      layoutId: "agenda",
    });
    expect(switched.slots.items).toEqual(["First point", "Second point"]);
  });

  /**
   * The type-CHANGING branches are tested on the pure function, not through the service.
   *
   * Not a shortcut: no slot key in the current seed registry has different types on two layouts (checked
   * by the assertion below), so `list → text` and `text → list` are unreachable via `updateSlide` today.
   * They are still live code — SPEC §7.4 names "first bullet → `body`" explicitly, and a future layout
   * reusing `title` as a list would hit them immediately. Driving them through `carryOverSlots` directly
   * tests the rule that exists rather than inventing a layout to reach it.
   */
  it("maps list → text by taking the first item, and text → list by wrapping", () => {
    const byKey = new Map<string, Set<string>>();
    for (const layout of LAYOUTS) {
      for (const spec of layout.slots) {
        byKey.set(spec.key, (byKey.get(spec.key) ?? new Set()).add(spec.type));
      }
    }
    const conflicting = [...byKey].filter(([, types]) => types.size > 1).map(([key]) => key);
    expect(conflicting, "a key now differs in type across layouts — assert it via updateSlide too")
      .toEqual([]);

    const listSlot = { slots: [{ key: "body", type: "list" as const }] };
    const textSlot = { slots: [{ key: "body", type: "text" as const }] };

    // SPEC §7.4's "first bullet → body". The rest is dropped rather than joined.
    expect(carryOverSlots(listSlot, textSlot, { body: ["First", "Second"] })).toEqual({ body: "First" });
    // An empty list has no first item, so the slot is absent rather than set to "".
    expect(carryOverSlots(listSlot, textSlot, { body: [] })).toEqual({});
    expect(carryOverSlots(textSlot, listSlot, { body: "Only" })).toEqual({ body: ["Only"] });
  });

  it("TRUNCATES rather than rejects when a carried-over value exceeds the new layout's budget", async () => {
    const h = harness();
    const created = await deck(h);
    const bulletsMax = requireLayout("bullets").slots.find((s) => s.key === "title")!.maxChars;
    const closingMax = requireLayout("closing").slots.find((s) => s.key === "title")!.maxChars;
    // `bullets.title` allows 55, `closing.title` allows 45 — so a legal title can become illegal purely
    // by switching layout. This is the case `assertWithinBudgets`' `typedKeys` scoping exists for.
    expect(bulletsMax).toBeGreaterThan(closingMax);

    const longTitle = "A".repeat(bulletsMax);
    const slide = await h.services.decks.addSlide(h.userId, created.id, {
      layoutId: "bullets", slots: { title: longTitle, items: ["Point"] },
    });
    expect(slide.flags).toEqual([]);

    const switched = await h.services.decks.updateSlide(h.userId, created.id, slide.id, {
      layoutId: "closing",
    });

    // Mechanical overflow, not typed overflow: truncated and flagged, NOT a 400. Enforcing across the
    // whole merged set would block a legitimate layout change on content the user never touched.
    expect((switched.slots.title as string).length).toBeLessThanOrEqual(closingMax);
    expect(switched.flags).toContain("trimmed");
  });

  it("applies incoming slots ON TOP of the carry-over, not instead of it", async () => {
    const h = harness();
    const created = await deck(h);
    const slide = await h.services.decks.addSlide(h.userId, created.id, {
      layoutId: "bullets", slots: { title: "Old title", items: ["Kept point"] },
    });

    // An edit that ALSO switches layout: `agenda` keeps `items`, and the patch renames the title.
    const switched = await h.services.decks.updateSlide(h.userId, created.id, slide.id, {
      layoutId: "agenda",
      slots: { title: "New title" },
    });

    expect(switched.slots.title).toBe("New title");
    // The carry-over survives the patch — if the order were reversed, `items` would be gone.
    expect(switched.slots.items).toEqual(["Kept point"]);
  });
});

describe("DeckService — flags are recomputed, not accumulated", () => {
  it("clears `trimmed` when the user fixes the content", async () => {
    const h = harness();
    const created = await deck(h);
    const closingMax = requireLayout("closing").slots.find((s) => s.key === "title")!.maxChars;

    // Reach a `trimmed` state the way the app does — a layout switch, since typed overflow is rejected.
    const slide = await h.services.decks.addSlide(h.userId, created.id, {
      layoutId: "bullets",
      slots: { title: "A".repeat(closingMax + 8), items: ["Point"] },
    });
    const trimmed = await h.services.decks.updateSlide(h.userId, created.id, slide.id, {
      layoutId: "closing",
    });
    expect(trimmed.flags).toContain("trimmed");

    const fixed = await h.services.decks.updateSlide(h.userId, created.id, slide.id, {
      slots: { title: "Short" },
    });
    // A stale amber badge on corrected content teaches the user to ignore badges (§12).
    expect(fixed.flags).not.toContain("trimmed");
  });

  it("preserves flags it doesn't own through a text edit", async () => {
    const h = harness();
    const created = await deck(h);
    const slide = await h.services.decks.addSlide(h.userId, created.id, {
      layoutId: "bullets", slots: { title: "T", items: ["Point"] },
    });
    // A `fallback` marker belongs to the generation path. Seeded through the repository directly,
    // because no service API sets it — that is the point: this layer must not clear it.
    await h.container.decks.putSlide(h.userId, created.id, {
      ...await h.services.decks.getSlide(h.userId, created.id, slide.id),
      flags: ["fallback"],
    });

    const edited = await h.services.decks.updateSlide(h.userId, created.id, slide.id, {
      slots: { title: "Edited" },
    });

    expect(edited.flags).toEqual(["fallback"]);
  });

  it("keeps speakerNotes untouched unless the patch names them", async () => {
    const h = harness();
    const created = await deck(h);
    const slide = await h.services.decks.addSlide(h.userId, created.id, {
      layoutId: "bullets", slots: { title: "T", items: ["Point"] }, speakerNotes: "Say this",
    });

    const edited = await h.services.decks.updateSlide(h.userId, created.id, slide.id, {
      slots: { title: "Edited" },
    });
    expect(edited.speakerNotes).toBe("Say this");

    const renotes = await h.services.decks.updateSlide(h.userId, created.id, slide.id, {
      speakerNotes: "Say that",
    });
    expect(renotes.speakerNotes).toBe("Say that");
  });
});
