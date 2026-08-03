/**
 * `GET /api/registry/layouts` — the layout registry, projected for the client (SPEC §3, §11).
 *
 * Serves with **no AWS credentials and no storage write** (§1.3). That is a property of the container's
 * laziness, not of this file: `layoutSummaries()` is static data and nothing here calls `getFacade()`, so
 * no repository, asset store, or Bedrock client is ever constructed to answer this request.
 *
 * `layoutSummaries` rather than `LAYOUTS`: the registry entries carry `FallbackRenderer` (a React
 * component) and `toPptx` (which closes over pptxgenjs types). Neither is serializable and neither may
 * cross into the client bundle (§0.5) — the projection is what makes that structural instead of a rule
 * someone has to remember when adding a layout.
 *
 * Public and immutable-per-deploy, so this is the one route family that caches. `s-maxage` with
 * `stale-while-revalidate` rather than `immutable`: a deploy changes the payload, and a stale registry
 * would offer layouts the server no longer has.
 */

import { handle, json } from "@/lib/http/route-helpers";
import { layoutSummaries } from "@/lib/layouts/registry";

/** Node, not edge: the registry's import graph reaches layout defs, which reference server-side types. */
export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return handle(async () => json(
    { layouts: layoutSummaries() },
    { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" } },
  ));
}
