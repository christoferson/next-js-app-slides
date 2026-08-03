/**
 * `POST /api/decks/:deckId/slides/:slideId/duplicate` (SPEC §9's slide actions).
 *
 * A separate endpoint rather than `POST /slides` with a body, because "copy this slide" is not the same
 * request as "create a slide": the copy's layout, slots, notes, and quality flags all come from the
 * original, and the only thing the client knows is *which* slide. Sending the content back to be re-stored
 * would let a stale editor buffer overwrite what is on screen with what was on screen a minute ago.
 *
 * 201 with the new slide — the caller needs its id (to focus it) and its `order` (to place it), and
 * `duplicateSlide` inserts directly after the original rather than appending.
 *
 * No body at all: there is nothing to configure, so there is no schema and nothing to validate beyond the
 * two path segments, whose validity is the repository's answer (`SlideNotFound`).
 */

import { getFacade } from "@/lib/container";
import { handle, json } from "@/lib/http/route-helpers";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string; slideId: string }> };

export function POST(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId, slideId } = await ctx.params;
    return json(
      await getFacade().duplicateSlide(request.headers, deckId, slideId),
      { status: 201 },
    );
  });
}
