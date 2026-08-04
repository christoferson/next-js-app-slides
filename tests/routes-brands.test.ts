/**
 * `/api/brands*` and `/api/assets/:id` — the brand half of §2 step 15.
 *
 * These assert what only the route layer decides: status codes, envelope shape, the params-are-a-Promise
 * contract, and — the load-bearing ones — that an error response carries the taxonomy's readable text and
 * NOT `AppError.detail`, and that the asset-serving response carries its sandbox headers. Brand VALIDATION
 * is `tests/brand-service.test.ts`'s subject and is not re-asserted here (see `route-harness.ts`).
 */

import { describe, expect, it } from "vitest";
import { GET as listBrands, POST as createBrand } from "@/app/api/brands/route";
import { DELETE as deleteBrand, GET as getBrand, PUT as putBrand } from "@/app/api/brands/[brandId]/route";
import { POST as importBrand } from "@/app/api/brands/import/route";
import { POST as uploadAsset } from "@/app/api/brands/[brandId]/assets/route";
import { DELETE as deleteAsset } from "@/app/api/brands/[brandId]/assets/[assetId]/route";
import { GET as serveAsset } from "@/app/api/assets/[assetId]/route";
import { POST as createDeck } from "@/app/api/decks/route";
import {
  PNG_1x1, type RouteHarness, pngOfSize, rawReq, readBody, readError, req, routeHarness, uploadReq,
} from "@/tests/route-harness";
import { brandInput } from "@/tests/service-harness";
import type { BrandDefinition } from "@/lib/brand/types";

/** Create a brand through the route, since that is what every other case here starts from. */
async function seedBrand(h: RouteHarness, overrides = {}): Promise<BrandDefinition> {
  const response = await createBrand(req("POST", brandInput(overrides)));
  const { status, body } = await readBody<BrandDefinition>(response);
  expect(status).toBe(201);
  return body;
}

describe("POST /api/brands", () => {
  it("returns 201 with the created brand", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);

    expect(brand.id).toBe("id-1");
    expect(brand.name).toBe("Loud Brand");
    // The route forwards the body opaquely; the SERVICE stamps ownership. Asserted here because a route
    // that passed a client-supplied `userId` through would be a cross-tenant write, and the body it
    // forwards is a `looseObject`.
    expect(brand.userId).toBe(h.userId);
  });

  it("rejects a body that is not a JSON object with 400 InvalidRequest", async () => {
    routeHarness();
    for (const body of ["[]", '"a string"', "null", "42"]) {
      const { status, body: error } = await readError(await createBrand(rawReq("POST", body)));
      expect(status).toBe(400);
      expect(error.code).toBe("InvalidRequest");
      expect(error.issues).toEqual(["body: must be a JSON object"]);
    }
  });

  it("rejects malformed JSON with 400 rather than a 500", async () => {
    routeHarness();
    const { status, body } = await readError(await createBrand(rawReq("POST", "{ not json")));
    expect(status).toBe(400);
    expect(body.issues).toEqual(["body: must be valid JSON"]);
  });

  it("surfaces InvalidBrandConfig's field-level issues (§12) with a 400", async () => {
    routeHarness();
    const bad = { ...brandInput(), colors: { ...brandInput().colors as object, primary: "not-a-hex" } };
    const { status, body } = await readError(await createBrand(req("POST", bad)));

    expect(status).toBe(400);
    expect(body.code).toBe("InvalidBrandConfig");
    // The issues array is the whole point of the allowlist crossing (`ISSUE_BEARING`): without it the
    // editor gets "this brand configuration isn't valid" and no field to highlight.
    expect(body.issues?.some((issue) => issue.includes("colors.primary"))).toBe(true);
  });
});

describe("GET /api/brands", () => {
  it("returns a `{brands}` envelope, not a bare array", async () => {
    const h = routeHarness();
    await seedBrand(h);
    const { status, body } = await readBody<{ brands: unknown[] }>(await listBrands(req("GET")));

    expect(status).toBe(200);
    // An envelope rather than a top-level array: a JSON array response cannot grow a field (pagination,
    // a count) without breaking every client, and every list endpoint here answers the same way.
    expect(Array.isArray(body.brands)).toBe(true);
    expect(body.brands).toHaveLength(1);
  });

  it("is `no-store`, because the URL carries no userId", async () => {
    routeHarness();
    const response = await listBrands(req("GET"));
    // A shared cache keyed on this URL alone would serve one user's brand list to another. This header is
    // the only thing preventing that, and it comes from `json`'s default rather than each route.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("scopes the list to the authenticated principal", async () => {
    const a = routeHarness({ defaultUserId: "user-a" });
    await seedBrand(a);
    const { body: mine } = await readBody<{ brands: unknown[] }>(await listBrands(req("GET")));
    expect(mine.brands).toHaveLength(1);

    // A second container with a different principal over its OWN memory store: the point is that the
    // route derives the userId from the provider and there is no header or body field that changes it.
    routeHarness({ defaultUserId: "user-b" });
    const { body: theirs } = await readBody<{ brands: unknown[] }>(await listBrands(req("GET")));
    expect(theirs.brands).toHaveLength(0);
  });
});

describe("GET | PUT | DELETE /api/brands/:brandId", () => {
  it("GET returns brand + compiled tokens in one response", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);
    const { status, body } = await readBody<{ brand: BrandDefinition; tokens: Record<string, unknown> }>(
      await getBrand(req("GET"), h.ctx({ brandId: brand.id })),
    );

    expect(status).toBe(200);
    expect(body.brand.id).toBe(brand.id);
    // Both in one payload, so the preview cannot show repaired colours for a different revision.
    expect(body.tokens).toBeTruthy();
  });

  it("GET a missing brand is 404 and never echoes the id", async () => {
    const h = routeHarness();
    const crafted = "../../etc/passwd";
    const { status, body } = await readError(
      await getBrand(req("GET"), h.ctx({ brandId: crafted })),
    );

    expect(status).toBe(404);
    expect(body.code).toBe("BrandNotFound");
    // The whole reason `fail` sends only taxonomy text: a 404 reading `Brand "../../etc/passwd" not
    // found` is reflected input in an error path, and it is the natural thing to write.
    expect(JSON.stringify(body)).not.toContain("etc/passwd");
    expect(JSON.stringify(body)).not.toContain("..");
  });

  it("PUT replaces the config and returns the updated brand", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);
    h.clock.tick();

    const { status, body } = await readBody<BrandDefinition>(
      await putBrand(req("PUT", brandInput({ name: "Renamed" })), h.ctx({ brandId: brand.id })),
    );

    expect(status).toBe(200);
    expect(body.name).toBe("Renamed");
    expect(body.id).toBe(brand.id);
  });

  it("DELETE is 204 with no body", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);
    const response = await deleteBrand(req("DELETE"), h.ctx({ brandId: brand.id }));

    expect(response.status).toBe(204);
    // A `{ok:true}` envelope would invite clients to branch on it; 204 means there is nothing to branch on.
    expect(await response.text()).toBe("");
  });

  it("DELETE is 409 BrandInUse while a deck references it (§11 step 11)", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);
    await createDeck(req("POST", { title: "Q3 review", brandId: brand.id }));

    const { status, body } = await readError(
      await deleteBrand(req("DELETE"), h.ctx({ brandId: brand.id })),
    );
    expect(status).toBe(409);
    expect(body.code).toBe("BrandInUse");
    // Readable enough to act on without naming which deck — `detail` holds the deck ids, the body does not.
    expect(body.message).toMatch(/deck/i);
    expect(JSON.stringify(body)).not.toContain("id-2");
  });
});

describe("POST /api/brands/import", () => {
  it("creates a new brand from a config and returns 201", async () => {
    routeHarness();
    const { status, body } = await readBody<BrandDefinition>(
      await importBrand(req("POST", brandInput({ name: "Imported" }))),
    );

    expect(status).toBe(201);
    expect(body.name).toBe("Imported");
  });

  it("reports invalid config with field-level issues and applies nothing (§12)", async () => {
    routeHarness();
    const { status, body } = await readError(
      await importBrand(req("POST", { name: "Broken", colors: {} })),
    );

    expect(status).toBe(400);
    expect(body.code).toBe("InvalidBrandConfig");
    expect(body.issues?.length).toBeGreaterThan(0);

    // "Nothing partially applied" is the SPEC §12 promise, and this is the observable form of it.
    const { body: list } = await readBody<{ brands: unknown[] }>(await listBrands(req("GET")));
    expect(list.brands).toHaveLength(0);
  });
});

describe("POST /api/brands/:brandId/assets", () => {
  it("stores a logo and returns 201 with `{assetId, brand}`", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);

    const { status, body } = await readBody<{ assetId: string; brand: BrandDefinition }>(
      await uploadAsset(
        uploadReq({ bytes: PNG_1x1, filename: "logo.png", type: "image/png" }, { kind: "logo" }),
        h.ctx({ brandId: brand.id }),
      ),
    );

    expect(status).toBe(201);
    expect(body.assetId).toBeTruthy();
    // The brand comes back because the upload ATTACHED: without it the editor would have to guess whether
    // the logo landed and what it landed on.
    expect(body.brand.logo?.light).toBe(body.assetId);
  });

  it("seeds a background's zones from the layout's defaults", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);

    const { body } = await readBody<{ assetId: string; brand: BrandDefinition }>(
      await uploadAsset(
        uploadReq(
          { bytes: pngOfSize(1920, 1080), filename: "bg.png", type: "image/png" },
          { kind: "background", layoutId: "title" },
        ),
        h.ctx({ brandId: brand.id }),
      ),
    );

    const template = body.brand.templates.title;
    expect(template?.backgroundAssetId).toBe(body.assetId);
    // Seeded, not empty: the brand editor's zone table is populated by this upload (§4's registry-driven
    // seeding), and an empty `zones` would render every slot at the origin.
    expect(Object.keys(template?.zones ?? {}).length).toBeGreaterThan(0);
  });

  it("requires layoutId for a background, naming the field", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);

    const { status, body } = await readError(
      await uploadAsset(
        uploadReq({ bytes: PNG_1x1, filename: "bg.png", type: "image/png" }, { kind: "background" }),
        h.ctx({ brandId: brand.id }),
      ),
    );

    expect(status).toBe(400);
    expect(body.code).toBe("InvalidRequest");
    expect(body.issues?.some((i) => i.startsWith("layoutId"))).toBe(true);
  });

  it("rejects an unknown form field rather than ignoring it", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);

    // `strictObject` on the form fields: `layout` for `layoutId` is an easy typo, and a background stored
    // with no layout would attach to nothing — a successful upload that changed nothing on screen.
    const { status, body } = await readError(
      await uploadAsset(
        uploadReq({ bytes: PNG_1x1, filename: "bg.png", type: "image/png" },
          { kind: "logo", layout: "title" }),
        h.ctx({ brandId: brand.id }),
      ),
    );

    expect(status).toBe(400);
    expect(body.issues?.some((i) => i.includes("layout"))).toBe(true);
  });

  it("requires a file part", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);

    const form = new FormData();
    form.append("kind", "logo");
    const { status, body } = await readError(await uploadAsset(
      new Request("http://test.local/api", { method: "POST", body: form }),
      h.ctx({ brandId: brand.id }),
    ));

    expect(status).toBe(400);
    expect(body.issues).toEqual(["file: is required"]);
  });

  it("rejects a body that is not multipart at all", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);

    const { status, body } = await readError(await uploadAsset(
      req("POST", { kind: "logo" }),
      h.ctx({ brandId: brand.id }),
    ));

    expect(status).toBe(400);
    expect(body.issues).toEqual(["body: must be a multipart/form-data upload"]);
  });

  it("enforces maxAssetBytes on the real byte length with 413", async () => {
    const h = routeHarness({ maxAssetBytes: 64 });
    const brand = await seedBrand(h);

    const big = new Uint8Array(200);
    big.set(PNG_1x1.slice(0, 8));
    const { status, body } = await readError(await uploadAsset(
      uploadReq({ bytes: big, filename: "big.png", type: "image/png" }, { kind: "logo" }),
      h.ctx({ brandId: brand.id }),
    ));

    expect(status).toBe(413);
    expect(body.code).toBe("AssetTooLarge");
    // The limit is stated in the message because "too large" with no number is unactionable.
    expect(body.message).toMatch(/limit/i);
  });

  it("enforces maxAssetBytes on Content-Length before parsing the body", async () => {
    const h = routeHarness({ maxAssetBytes: 1024 });
    const brand = await seedBrand(h);

    // The body is a lie — it is not multipart at all. If the header check did NOT fire first, the failure
    // would be `InvalidRequest("must be a multipart/form-data upload")` from `formData()`. Getting 413
    // instead is the proof that nothing was buffered or parsed.
    const { status, body } = await readError(await uploadAsset(
      new Request("http://test.local/api", {
        method: "POST",
        body: "x",
        headers: { "content-length": String(1024 + 8 * 1024 + 1) },
      }),
      h.ctx({ brandId: brand.id }),
    ));

    expect(status).toBe(413);
    expect(body.code).toBe("AssetTooLarge");
  });

  it("rejects an SVG carrying active content (SPEC §5)", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);

    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/brands")</script></svg>',
    );
    const { status, body } = await readError(await uploadAsset(
      uploadReq({ bytes: svg, filename: "logo.svg", type: "image/svg+xml" }, { kind: "logo" }),
      h.ctx({ brandId: brand.id }),
    ));

    expect(status).toBe(400);
    expect(body.code).toBe("UnsafeAsset");
    // A real rejection, not a stored-with-a-warning: the brand must not now name a script-bearing asset.
    const { body: after } = await readBody<{ brand: BrandDefinition }>(
      await getBrand(req("GET"), h.ctx({ brandId: brand.id })),
    );
    expect(after.brand.logo?.light).toBeUndefined();
  });

  it("rejects bytes whose signature contradicts the declared type", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);

    const { status, body } = await readError(await uploadAsset(
      // Claims PNG, is actually a JPEG. The declared type comes from a filename extension, so it is a
      // claim; `checkAssetBytes` re-derives it and a mismatch is a rejection rather than a silent fix.
      uploadReq({
        bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]),
        filename: "logo.png",
        type: "image/png",
      }, { kind: "logo" }),
      h.ctx({ brandId: brand.id }),
    ));

    expect(status).toBe(400);
    expect(body.code).toBe("UnsafeAsset");
  });
});

describe("DELETE /api/brands/:brandId/assets/:assetId", () => {
  it("returns the updated brand rather than 204, because the delete edits it", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);
    const { body: uploaded } = await readBody<{ assetId: string }>(await uploadAsset(
      uploadReq({ bytes: pngOfSize(1920, 1080), filename: "bg.png", type: "image/png" },
        { kind: "background", layoutId: "title" }),
      h.ctx({ brandId: brand.id }),
    ));

    const { status, body } = await readBody<BrandDefinition>(await deleteAsset(
      req("DELETE"), h.ctx({ brandId: brand.id, assetId: uploaded.assetId }),
    ));

    expect(status).toBe(200);
    // Detached, not dangling. A 204 here would leave the editor holding a config naming a missing
    // background — which `validateBrand` would then reject on the editor's next save.
    expect(body.templates.title?.backgroundAssetId).toBeUndefined();
  });
});

describe("GET /api/assets/:assetId", () => {
  it("serves the bytes with the sandbox headers", async () => {
    const h = routeHarness();
    const brand = await seedBrand(h);
    const { body: uploaded } = await readBody<{ assetId: string }>(await uploadAsset(
      uploadReq({ bytes: PNG_1x1, filename: "logo.png", type: "image/png" }, { kind: "logo" }),
      h.ctx({ brandId: brand.id }),
    ));

    const response = await serveAsset(req("GET"), h.ctx({ assetId: uploaded.assetId }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PNG_1x1.byteLength));
    // The security half of `assetResponse`. An `image/svg+xml` response is a document a browser will
    // execute in this origin; these three are what make a validator gap non-exploitable.
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // Cacheable AND user-scoped — the one response in the app that is both, so `private` is essential.
    expect(response.headers.get("cache-control")).toContain("private");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(PNG_1x1);
  });

  it("404s an unknown id without echoing it", async () => {
    const h = routeHarness();
    const { status, body } = await readError(
      await serveAsset(req("GET"), h.ctx({ assetId: "../../secret" })),
    );

    // 404 rather than 403, deliberately: a distinguishable "exists but forbidden" would let the id space
    // be enumerated.
    expect(status).toBe(404);
    expect(body.code).toBe("AssetNotFound");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
