/**
 * `GET /api/assets/:assetId` — serve an asset's bytes.
 *
 * This is the URL both asset stores return from `resolveUrl`, and it carries **no userId** — deliberately,
 * so a serving URL cannot be used to probe another user's partition by editing a path segment. The
 * consequence is that scoping rests entirely on the request's own principal: the facade resolves it from
 * the headers and passes it to the store, and an id belonging to someone else raises `AssetNotFound`
 * (404), not 403. A distinguishable "exists but forbidden" would let the id space be enumerated.
 *
 * The body is streamed straight through — `ReadableAsset.body` is a WEB `ReadableStream`, which is what a
 * route handler returns natively (that is why the port chose it over a Node `Readable`), so a 5 MB
 * background never lands in this process's memory on the read path.
 *
 * `assetResponse` carries the response headers, and they are load-bearing rather than cosmetic: SPEC §5
 * allows SVG, and an SVG served without a CSP sandbox is a script-execution vector in this origin. See
 * that function for the full reasoning, and `lib/domain/asset-bytes.ts` for the upload-time rejection
 * these headers back up.
 */

import { getFacade } from "@/lib/container";
import { assetResponse, handle } from "@/lib/http/route-helpers";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ assetId: string }> };

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { assetId } = await ctx.params;
    return assetResponse(await getFacade().serveAsset(request.headers, assetId));
  });
}
