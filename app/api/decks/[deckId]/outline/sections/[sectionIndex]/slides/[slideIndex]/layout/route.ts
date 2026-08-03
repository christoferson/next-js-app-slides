/**
 * `PUT /api/decks/:deckId/outline/sections/:si/slides/:li/layout` — pin or clear one slide's layout
 * (SPEC §7.2's `UserOverrideRule`, §12's outline layout switcher).
 *
 * ## Why a deep path instead of `PATCH …/outline` with the whole document
 *
 * The layout switcher is a single click. Round-tripping the entire outline to serve it makes every
 * concurrent edit a lost-update race — the user pins a layout on slide 6 while a section regenerate is in
 * flight, and whichever document lands second wins wholesale. A targeted write is the only shape that
 * cannot do that (`OutlineService.setLayoutOverride`'s own note).
 *
 * Indices, not ids: an outline slide has no id. It is a position in a document, which is also why the two
 * segments are parsed with `readIndex` rather than `Number()` — `" 1"`, `"1e3"`, `"0x2"`, and `""` all
 * coerce to a number that indexes somewhere the client did not ask for. Out of range is a readable error
 * from the service, not a silent no-op.
 *
 * `PUT` with `{layoutId: string | null}`: `null` CLEARS the pin, which is why the field is nullable rather
 * than optional. "Absent" and "explicitly cleared" have to be distinguishable — an optional field would
 * collapse them, and clearing a pin would become unexpressible.
 *
 * Whether `layoutId` names a real layout is the service's check, via `assertValidOverride`, against the
 * registry. Not here: §4 forbids the second copy of the layout list, and a mapping-aware answer ("that
 * layout isn't available") is what the switcher can act on.
 */

import { getFacade } from "@/lib/container";
import { handle, json, readIndex, readJson } from "@/lib/http/route-helpers";
import { layoutOverrideSchema } from "@/lib/http/request-schemas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string; sectionIndex: string; slideIndex: string }> };

export function PUT(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId, sectionIndex, slideIndex } = await ctx.params;
    const body = await readJson(request, layoutOverrideSchema);
    return json(await getFacade().setLayoutOverride(
      request.headers,
      deckId,
      readIndex(sectionIndex, "sectionIndex"),
      readIndex(slideIndex, "slideIndex"),
      body.layoutId,
    ));
  });
}
