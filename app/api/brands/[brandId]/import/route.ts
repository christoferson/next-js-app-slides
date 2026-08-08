/**
 * `PUT /api/brands/:brandId/import` — replace an existing brand from an exported JSON config
 * (SPEC §5, §11 step 3; §12's "invalid config → field-level readable zod errors").
 *
 * ## Why this is not `PUT /api/brands/:brandId`
 *
 * The payloads differ, in the same way `POST /api/brands/import` differs from `POST /api/brands` — and
 * that sibling route's header already documents this endpoint as where a replace-from-JSON lands, so
 * this file is that promise kept rather than a new idea. `PUT /api/brands/:brandId` takes the *editable
 * surface* (`brandInputSchema`, a `strictObject`), while an exported config carries `id`, `userId`,
 * `createdAt`, and `updatedAt`. Pasting an export into the editable-surface endpoint fails on four
 * unrecognized keys, which is a confusing 400 for a file this app itself produced.
 *
 * `importConfig` validates the whole definition and then discards the identity fields, so the `brandId`
 * in the PATH is the only thing that decides which record is written. A pasted config naming another
 * user's `userId` — or another brand's `id` — cannot redirect the write (`BrandService.importConfig`).
 *
 * `PUT` rather than `POST` for the same reason as its neighbour: this is a full replace of one named
 * brand, and it is idempotent. The create-from-JSON case stays a `POST` to the collection.
 */

import { getFacade } from "@/lib/container";
import { handle, json, readObjectJson } from "@/lib/http/route-helpers";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ brandId: string }> };

export function PUT(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { brandId } = await ctx.params;
    const input = await readObjectJson(request);
    return json(await getFacade().importBrand(request.headers, input, brandId));
  });
}
