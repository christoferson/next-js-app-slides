/**
 * `PUT /api/decks/:deckId/slides/order` — drag-and-drop reorder (SPEC §9, §12's `@dnd-kit` grid).
 *
 * ## Why `order` is a static segment beside `[slideId]`, and why that is safe
 *
 * `slides/order` and `slides/:slideId` are siblings. The App Router resolves a static segment before a
 * dynamic one, so this file wins for the literal path and no slide can shadow it. A slide id is a ULID and
 * cannot be the string `"order"`; a crafted one would be rejected by the repository's path builder before
 * it named anything.
 *
 * ## `PUT` with the whole permutation, not `PATCH` with a move
 *
 * A reorder is a statement about the entire list, and the repository rejects a partial permutation outright
 * (`InvalidSlideOrder`) rather than applying it. That is deliberate: an incremental "move slide 3 to
 * position 7" is ambiguous the moment two clients send one, and reconstructing the intended final order
 * from two overlapping moves is not something either side can do. A full list either matches the deck or is
 * refused, so a stale client is told rather than silently reordering someone else's deck.
 *
 * The response is the full reordered list, so the client re-syncs from one response instead of applying its
 * optimistic guess and hoping — and the guess and the truth differ whenever a concurrent delete landed.
 */

import { getFacade } from "@/lib/container";
import { handle, json, readJson } from "@/lib/http/route-helpers";
import { reorderSlidesSchema } from "@/lib/http/request-schemas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string }> };

export function PUT(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId } = await ctx.params;
    const body = await readJson(request, reorderSlidesSchema);
    return json({
      slides: await getFacade().reorderSlides(request.headers, deckId, body.orderedIds),
    });
  });
}
