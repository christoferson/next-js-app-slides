/**
 * `POST /api/brands/:brandId/assets` — logo/background upload, multipart (SPEC §3, §5; §11 step 2).
 *
 * ## The three things this route is responsible for
 *
 *   1. **The size limit.** `MAX_ASSET_MB` is config, and it can only be applied here: by the time a
 *      service sees bytes they are already in memory. `readUpload` checks `Content-Length` before parsing
 *      and the real byte length after — see its header for why one check is not enough, and for the
 *      chunked-body caveat that is flagged rather than hidden.
 *   2. **Form shape.** `uploadFieldsSchema` decides that `kind` is one of two values and that a
 *      background names a layout. Whether that layout *exists* is `BrandService.addAsset`'s call, from
 *      the registry — a second copy of the layout list here is the parallel table §4 forbids.
 *   3. **Nothing else.** Content type, dimensions, and byte size are all derived from the bytes by the
 *      service and the facade. This route forwards a claim about none of them.
 *
 * ## Why the response is the whole brand
 *
 * `addAsset` attaches as it stores: a background lands on `brand.templates[layoutId].backgroundAssetId`
 * with zones seeded from the layout's `defaultZones`, and a logo on `brand.logo.light`. So the upload
 * changes the brand, and returning only an `assetId` would leave the editor to guess what the attachment
 * did — including whether the zone table it is showing is now the seeded one. 201 with
 * `{ assetId, brand }` is one round trip for both facts.
 *
 * `AssetTooLarge` is a 413 and `UnsafeAsset` a 400 with field-level `issues`, both from the taxonomy via
 * `fail`. The SVG case is a real rejection, not a warning: see `lib/domain/asset-bytes.ts`.
 */

import { getConfig, getFacade } from "@/lib/container";
import { describeZodIssues, handle, json, readUpload } from "@/lib/http/route-helpers";
import { uploadFieldsSchema } from "@/lib/http/request-schemas";
import { InvalidRequest } from "@/lib/errors/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ brandId: string }> };

export function POST(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { brandId } = await ctx.params;
    const upload = await readUpload(request, getConfig().maxAssetBytes);

    const parsed = uploadFieldsSchema.safeParse(upload.fields);
    if (!parsed.success) throw InvalidRequest(describeZodIssues(parsed.error));

    return json(
      await getFacade().addBrandAsset(request.headers, brandId, upload.bytes, {
        filename: upload.filename,
        // The DECLARED type, passed for cross-checking only: `checkAssetBytes` compares it against the
        // file's signature and rejects a mismatch, then returns the type that is actually stored. This
        // route never decides what the bytes are.
        contentType: upload.declaredType,
        kind: parsed.data.kind,
        ...(parsed.data.layoutId !== undefined ? { layoutId: parsed.data.layoutId } : {}),
      }),
      { status: 201 },
    );
  });
}
