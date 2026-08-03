/**
 * `POST /api/brands/import` — JSON import that CREATES (SPEC §5, §11 step 3).
 *
 * ## Why import is its own endpoint rather than `POST /api/brands`
 *
 * They accept different payloads. `POST /api/brands` takes the *editable surface* (`brandInputSchema`,
 * a `strictObject` — an unknown key is a 400). An exported config carries `id`, `userId`, `createdAt`,
 * and `updatedAt`, so sending one to the create endpoint fails on four unrecognized keys. §11 step 3
 * requires "export JSON → re-import → identical", which means the import path must accept exactly what
 * the export produced.
 *
 * `importConfig` validates it as a complete definition and then discards the identity fields — the ids
 * never decide which record is written, so a crafted `userId` cannot redirect the write into another
 * user's partition (see `BrandService.importConfig`).
 *
 * Field-level zod errors reach the client through `InvalidBrandConfig`'s allowlisted `issues`
 * (`toErrorBody`), which is what §12's "invalid config → field-level readable zod errors, nothing
 * partially applied" asks for. The "nothing partially applied" half is the service's: validation
 * completes before any write.
 *
 * Replacing an *existing* brand from JSON is `PUT /api/brands/:brandId/import` — same service, same
 * guarantees, and separate from `PUT /api/brands/:brandId` for exactly the payload reason above.
 *
 * `import` is a static segment sitting beside `[brandId]`, and static wins in the App Router — so this
 * shadows a brand whose id is literally `"import"`. Ids are ULIDs (26 chars, Crockford base32), so no
 * generated id can collide, and `safeId` would reject a crafted one long before it reached a path.
 */

import { getFacade } from "@/lib/container";
import { handle, json, readObjectJson } from "@/lib/http/route-helpers";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const input = await readObjectJson(request);
    return json(await getFacade().importBrand(request.headers, input), { status: 201 });
  });
}
