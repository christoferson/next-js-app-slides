/**
 * `GET | PUT | DELETE /api/brands/:brandId` (SPEC §3, §5).
 *
 * ## `GET` returns the brand, its compiled tokens, AND its resolved templates
 *
 * One call, via `getBrandTheme`. The editor's live preview needs all three, and the facade's note gives
 * the reason they must not be separate requests: `compileTheme` runs contrast repair, so tokens fetched
 * separately can describe a different revision than the config on screen — the §8 drift the whole
 * shared-resolver design exists to prevent. `tokens.notices` is also where the contrast-repair badge
 * comes from (§12), so a client that skipped it would silently suppress a warning; the templates carry
 * the background luminance and intrinsic size behind the other two §12 badges, which a browser cannot
 * derive from a CSS background image.
 *
 * ## `PUT`, not `PATCH`
 *
 * The editor and the JSON import both submit whole configs, and `BrandService.update` is a full replace of
 * the editable surface. A `PATCH` verb over replace semantics would invite a client to send one changed
 * field and silently reset the other six.
 *
 * ## `DELETE` is expected to fail
 *
 * `BrandInUse` (409) while any deck references the brand — §11 step 11's guard. The readable message names
 * the deck count, which is the actionable part; the route adds nothing.
 */

import { getFacade } from "@/lib/container";
import { handle, json, noContent, readObjectJson } from "@/lib/http/route-helpers";

export const runtime = "nodejs";

/** Next 16 route handlers receive `params` as a Promise — verified against the installed typegen. */
type Ctx = { params: Promise<{ brandId: string }> };

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { brandId } = await ctx.params;
    return json(await getFacade().getBrandTheme(request.headers, brandId));
  });
}

export function PUT(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { brandId } = await ctx.params;
    const input = await readObjectJson(request);
    return json(await getFacade().updateBrand(request.headers, brandId, input));
  });
}

export function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { brandId } = await ctx.params;
    await getFacade().deleteBrand(request.headers, brandId);
    return noContent();
  });
}
