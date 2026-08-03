/**
 * `DELETE /api/brands/:brandId/assets/:assetId` (SPEC §5).
 *
 * Returns the updated brand, not 204 — unlike the other deletes in this app. The reason is that this
 * delete *edits the brand*: `removeAsset` detaches the asset from every template that referenced it and
 * from `brand.logo` before deleting the bytes (that order is deliberate — see the service). A 204 would
 * leave the editor holding a config that still names a background which no longer exists, and the next
 * save would fail `validateBrand`'s asset cross-check with an error the user did nothing to cause.
 */

import { getFacade } from "@/lib/container";
import { handle, json } from "@/lib/http/route-helpers";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ brandId: string; assetId: string }> };

export function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { brandId, assetId } = await ctx.params;
    return json(await getFacade().removeBrandAsset(request.headers, brandId, assetId));
  });
}
