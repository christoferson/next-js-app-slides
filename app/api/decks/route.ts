/**
 * `GET /api/decks` · `POST /api/decks` (SPEC §3, §9's wizard steps 1–2).
 *
 * Unlike the brand endpoints, these DO parse their body here: a deck's request shape is HTTP-edge
 * knowledge (which fields this endpoint takes, how long a `sourceText` may be) rather than a domain
 * schema someone else owns. `createDeckSchema` is parameterized by `maxSourceTextChars` because the cap is
 * a config value — and this is the point where that knob, which existed unconsumed through steps 1–14,
 * takes effect. It has to be here: by the time a service sees a briefing, the megabyte has been parsed.
 *
 * `brandId` is required. A deck with no brand cannot be previewed or exported, so there is no useful state
 * in which one exists; the facade then checks it names a brand this user owns, before creating anything
 * (see `createDeck`'s note on why failing at creation beats failing at outline time).
 *
 * The briefing is optional here and required by the time an outline is generated — `DeckNotReady` (409)
 * says which wizard step is missing. That split is what lets the wizard create the deck at step 1 and
 * collect the briefing at step 2 without holding unsaved state in the browser.
 */

import { getConfig, getFacade } from "@/lib/container";
import { handle, json, readJson } from "@/lib/http/route-helpers";
import { createDeckSchema } from "@/lib/http/request-schemas";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handle(async () => json({ decks: await getFacade().listDecks(request.headers) }));
}

export function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const input = await readJson(request, createDeckSchema(getConfig().maxSourceTextChars));
    return json(
      await getFacade().createDeck(request.headers, {
        title: input.title,
        brandId: input.brandId,
        ...(input.briefing !== undefined ? { briefing: input.briefing } : {}),
      }),
      { status: 201 },
    );
  });
}
