/**
 * `GET /api/decks/:deckId/workspace` — everything the workspace screen loads, in one request (SPEC §9).
 *
 * The composition happens in `StudioFacade.workspace`, not here, and the reason is §8's guarantee rather
 * than convenience: the slides, the tokens they are styled with, the templates that position them, and the
 * brand they all belong to must describe ONE revision of one brand. Four parallel fetches can interleave
 * with a brand edit and produce a preview that matches no state that ever existed — and the preview is
 * what the user trusts the export to match.
 *
 * A read-only aggregate, so `GET`. `no-store` (the default in `json`) matters here more than elsewhere:
 * this is the response that would otherwise be served from a shared cache keyed on a URL that carries no
 * userId.
 */

import { getFacade } from "@/lib/container";
import { handle, json } from "@/lib/http/route-helpers";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string }> };

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId } = await ctx.params;
    return json(await getFacade().workspace(request.headers, deckId));
  });
}
