/**
 * `GET | POST | PATCH /api/decks/:deckId/outline` (SPEC §3, §7.1).
 *
 * ## One endpoint, three verbs, because they are three views of one document
 *
 *   - `GET` → `outlineView`: the stored plan, its advisories, and the mapping preview, in ONE service
 *     call. Not three requests: fetching the plan and the mapping separately lets a concurrent regenerate
 *     land between them, and the badges would then explain slides no longer on screen
 *     (`OutlineService.view`'s own note).
 *   - `POST` → generate. `sectionIndex` present ⇒ regenerate that one section in place, which is SPEC
 *     §7.1's documented body (`{ instruction?, sectionIndex? }`) and §12's "regenerate a section" seam.
 *     Both paths persist before returning, so a client that navigates away keeps the result.
 *   - `PATCH` → save the user's edits (reorder, reword, move between sections).
 *
 * ## Why the outline body is `z.unknown()`
 *
 * `saveOutlineSchema` checks that a request has an `outline` key and no others; the DOCUMENT goes to
 * `OutlineService.save` unexamined, because the domain's own zod is the authority — and it validates every
 * `layoutOverride` against the layout registry. A route-level copy of that shape is how an override the
 * mapping chain will silently ignore gets accepted with a 200 (§4's parallel table, in its most damaging
 * form: the client believes a pin was saved).
 *
 * ## Streaming
 *
 * The outline is a single LLM call producing one document, so it is a plain JSON response rather than SSE.
 * Only per-slide generation streams — there, each slide is independently useful the moment it lands.
 * `request.signal` is still forwarded so a client that navigates away stops paying for tokens.
 */

import { getFacade } from "@/lib/container";
import { handle, json, readJson } from "@/lib/http/route-helpers";
import { generateOutlineSchema, saveOutlineSchema } from "@/lib/http/request-schemas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string }> };

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId } = await ctx.params;
    return json(await getFacade().outlineView(request.headers, deckId));
  });
}

export function POST(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId } = await ctx.params;
    const body = await readJson(request, generateOutlineSchema);
    const facade = getFacade();

    const options = {
      ...(body.instruction !== undefined ? { instruction: body.instruction } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      signal: request.signal,
    };

    return json(
      body.sectionIndex !== undefined
        ? await facade.regenerateOutlineSection(request.headers, deckId, body.sectionIndex, options)
        : await facade.generateOutline(request.headers, deckId, options),
    );
  });
}

export function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId } = await ctx.params;
    const body = await readJson(request, saveOutlineSchema);
    // `body.outline` stays `unknown` all the way to `OutlineService.save`, which parses it with
    // `parseEditedOutline` and raises `InvalidRequest` with field-level issues. No cast, and no shape
    // declared here — see the header.
    return json(await getFacade().saveOutline(request.headers, deckId, body.outline));
  });
}
