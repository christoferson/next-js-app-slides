/**
 * `GET | PATCH | DELETE /api/decks/:deckId/slides/:slideId` (SPEC §3, §7.4).
 *
 * `PATCH` carries slots, layout, and speaker notes — the inline editor's three writes. What a layout's
 * slots ACCEPT is not decided here: `DeckService.updateSlide` compiles a zod schema from the layout's own
 * `SlotSpec`s and raises `InvalidSlideContent` with field-level issues, so the editor can highlight the
 * offending slot (§12). `patchSlideSchema` owns only the shapes `SlotValue` does not admit — a number, an
 * object, a nested array — the ones that would otherwise reach the budget checker as a type it cannot
 * measure.
 *
 * A user's over-long edit is REJECTED, where a model's is truncated and flagged. That asymmetry is
 * deliberate and documented on `InvalidSlideContent`: silently rewriting what a person typed is worse than
 * telling them it does not fit, and the editor already shows a live counter.
 *
 * `DELETE` is 204. Unlike the asset delete, nothing else in the deck changes — `deleteSlide` closes the
 * `order` gap itself, and the client's next read reflects it.
 */

import { getFacade } from "@/lib/container";
import { handle, json, noContent, readJson } from "@/lib/http/route-helpers";
import { patchSlideSchema } from "@/lib/http/request-schemas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string; slideId: string }> };

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId, slideId } = await ctx.params;
    return json(await getFacade().getSlide(request.headers, deckId, slideId));
  });
}

export function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId, slideId } = await ctx.params;
    const patch = await readJson(request, patchSlideSchema);
    return json(await getFacade().updateSlide(request.headers, deckId, slideId, {
      ...(patch.slots !== undefined ? { slots: patch.slots } : {}),
      ...(patch.layoutId !== undefined ? { layoutId: patch.layoutId } : {}),
      ...(patch.speakerNotes !== undefined ? { speakerNotes: patch.speakerNotes } : {}),
    }));
  });
}

export function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId, slideId } = await ctx.params;
    await getFacade().deleteSlide(request.headers, deckId, slideId);
    return noContent();
  });
}
