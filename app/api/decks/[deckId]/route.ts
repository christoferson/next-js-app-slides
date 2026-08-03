/**
 * `GET | PATCH | DELETE /api/decks/:deckId` (SPEC §3, §9).
 *
 * ## `PATCH`, not `PUT` — the opposite choice from brands, for a reason
 *
 * `PUT /api/brands/:id` is a full replace because the brand editor submits whole configs. A deck's three
 * editable fields are edited from three different places in the UI at three different times: the title
 * from the header, the briefing from the wizard, the brand from the swap control. A replace verb would
 * mean the swap control had to send the briefing back, and a client that forgot would silently erase it.
 *
 * ## `brandId` in the patch is the brand SWAP, and it is not a meta write
 *
 * It routes to `switchBrand`, which validates the target brand and returns the deck with its templates
 * re-resolved (§11 step 10: "re-render check; content unchanged"). A bare `setBrand` would leave the
 * client holding zones from the OLD brand while showing the new brand's name — the §8 preview/export
 * divergence, arriving through the one action most likely to change every zone on screen.
 *
 * That is why the response of a `brandId` patch is a different shape from the other two: it carries
 * `{ deck, brand, tokens, templates }` rather than a bare `DeckMeta`. Documented rather than smoothed
 * over, because a client must be able to tell which it got — the discriminator is which field it sent.
 *
 * Fields are applied in a fixed order (title → briefing → brand) so a multi-field patch is deterministic,
 * and each is a separate service call because each is a separate persisted concern. A patch naming
 * several fields is therefore not atomic: if the brand swap fails after the title was written, the title
 * stays written. That is the honest trade for keeping the writes single-purpose, and the UI sends one
 * field at a time.
 */

import { getConfig, getFacade } from "@/lib/container";
import { handle, json, noContent, readJson } from "@/lib/http/route-helpers";
import { patchDeckSchema } from "@/lib/http/request-schemas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string }> };

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId } = await ctx.params;
    return json(await getFacade().getDeck(request.headers, deckId));
  });
}

export function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId } = await ctx.params;
    const patch = await readJson(request, patchDeckSchema(getConfig().maxSourceTextChars));
    const facade = getFacade();

    if (patch.title !== undefined) {
      await facade.setDeckTitle(request.headers, deckId, patch.title);
    }
    if (patch.briefing !== undefined) {
      await facade.setBriefing(request.headers, deckId, patch.briefing);
    }
    // Last, and it returns the whole re-resolved view — see the header. Returning early here rather than
    // falling through to `getDeck` is what keeps the swap's templates in the SAME response as the swap.
    if (patch.brandId !== undefined) {
      return json(await facade.switchBrand(request.headers, deckId, patch.brandId));
    }

    return json(await facade.getDeck(request.headers, deckId));
  });
}

export function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId } = await ctx.params;
    await getFacade().deleteDeck(request.headers, deckId);
    return noContent();
  });
}
