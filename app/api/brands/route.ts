/**
 * `GET /api/brands` · `POST /api/brands` (SPEC §3, §5).
 *
 * Thin by construction: the body is checked to be an object and handed to the facade as `unknown`.
 * `brandInputSchema` is the authority on what a brand may contain, and re-declaring any of it here would
 * create the parallel table §4 forbids — a route that validated colours would drift from the schema the
 * service actually saves through, and the editor would then get two different answers about the same
 * field.
 *
 * `POST` returns 201 with the created brand rather than a bare id: `brandInputSchema` supplies defaults
 * for everything except `name`, so `POST {name}` produces a complete, valid, on-brand default — and the
 * response is how the client learns what those defaults were. Returning only an id would mean an empty
 * editor for one round trip.
 *
 * The userId is never in this file. `StudioFacade` resolves the principal from the headers, so there is no
 * parameter here that could be taken from the body (see that class's header for why that matters).
 */

import { getFacade } from "@/lib/container";
import { handle, json, readObjectJson } from "@/lib/http/route-helpers";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handle(async () => json({ brands: await getFacade().listBrands(request.headers) }));
}

export function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const input = await readObjectJson(request);
    return json(await getFacade().createBrand(request.headers, input), { status: 201 });
  });
}
