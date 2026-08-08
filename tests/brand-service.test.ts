/**
 * §2 step 12 — `BrandService` against memory repos, wired through the container (§6.3).
 *
 * The assertions are chosen from what this service claims to add over the repository (see its header):
 * server-assigned identity, validation-with-cross-checks before any write, nothing partially applied,
 * the `BrandInUse` delete guard, and the asset lifecycle's ordering. A test per *guarantee*, not a test
 * per method — `list` needs no suite of its own, but "a payload's `userId` cannot redirect a write" does,
 * because that one is an authorization hole rather than a bug.
 */

import { describe, expect, it } from "vitest";
import type { AssetMeta } from "@/lib/domain/asset";
import { AppError } from "@/lib/errors/errors";
import { LAYOUTS } from "@/lib/layouts/registry";
import { brandInput, harness } from "@/tests/service-harness";

const bytes = (): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/**
 * `addAsset` takes `Omit<AssetMeta, "createdAt">` — the service stamps the time. `makeAssetMeta` in
 * `tests/fixtures.ts` includes `createdAt` (correct for the repository suites, which store records
 * wholesale), so passing it here would need a cast at every call site.
 */
const upload = (overrides: Partial<Omit<AssetMeta, "createdAt">> = {}): Omit<AssetMeta, "createdAt"> => ({
  filename: "bg-16x9.png",
  contentType: "image/png",
  byteSize: 4,
  width: 1920,
  height: 1080,
  kind: "background",
  layoutId: "title",
  ...overrides,
});

/**
 * A layout's own `defaultZones`, copied.
 *
 * A template must place every REQUIRED slot or `validateBrand` rejects it — deliberately, since a slot
 * with no zone renders nowhere. So a fixture that only wants to exercise `backgroundAssetId` still needs
 * real zones, and taking them from the registry means a layout gaining a required slot doesn't silently
 * turn these tests into assertions about the missing-zone error instead.
 */
const zonesOf = (layoutId: string) =>
  (LAYOUTS.find((l) => l.id === layoutId)!.defaultZones).map((z) => ({ ...z }));

const titleZones = () => zonesOf("title");

/** Asserts the thrown value is our taxonomy with this code, and returns it for message checks. */
async function rejectsWith(code: string, run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (err) {
    expect(err, `expected an AppError, got ${String(err)}`).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`expected ${code}, but the call resolved`);
}

describe("BrandService — identity is server-assigned", () => {
  it("assigns id, userId and timestamps itself", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput());

    expect(brand.id).toBe("id-1");            // from `newId`
    expect(brand.userId).toBe(h.userId);
    expect(brand.createdAt).toBe(h.clock.iso());
    expect(brand.updatedAt).toBe(brand.createdAt);
  });

  it("REJECTS an identity-carrying payload on create rather than silently dropping it", async () => {
    const h = harness();
    // `brandInputSchema` is a `strictObject`, so the create/update surface refuses unknown keys outright.
    // That is stronger than ignoring them and it is the behaviour to lock in: a client that sends `userId`
    // has misunderstood the API, and a 400 says so where a silent drop leaves them believing it worked.
    // `importConfig` is the one path that accepts identity, because an export round-trip carries it —
    // and the test below proves it still cannot redirect the write.
    const err = await rejectsWith("InvalidBrandConfig", () => h.services.brands.create(h.userId, {
      ...brandInput(),
      id: "attacker-chosen",
      userId: "user-b",
    }));
    expect(JSON.stringify(err.detail)).toContain("userId");

    // Nothing was written anywhere, least of all into user-b's partition.
    await expect(h.container.brands.get("user-b", "attacker-chosen")).resolves.toBeNull();
    await expect(h.services.brands.list(h.userId)).resolves.toEqual([]);
  });

  it("keeps createdAt and the path's id on update", async () => {
    const h = harness();
    const first = await h.services.brands.create(h.userId, brandInput());
    const other = await h.services.brands.create(h.userId, brandInput({ name: "Other" }));

    const updatedAt = h.clock.tick();
    const saved = await h.services.brands.update(h.userId, first.id, brandInput({ name: "Renamed" }));

    expect(saved.id).toBe(first.id);
    expect(saved.userId).toBe(h.userId);
    // Carried over from the stored brand, not re-stamped — `createdAt` is not an editable field.
    expect(saved.createdAt).toBe(first.createdAt);
    expect(saved.updatedAt).toBe(updatedAt);
    // The other brand is untouched — proof the write went where the path said.
    await expect(h.services.brands.get(h.userId, other.id)).resolves.toMatchObject({ name: "Other" });
  });

  it("scopes reads by user: user-b cannot read user-a's brand", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput());
    // `BrandNotFound`, not a leak and not an empty object.
    await rejectsWith("BrandNotFound", () => h.services.brands.get("user-b", brand.id));
  });
});

describe("BrandService — validation before persistence", () => {
  it("creates a complete default brand from a name alone", async () => {
    const h = harness();
    // Defaults come from the schema, so `{ name }` must yield a usable brand rather than a stub.
    const brand = await h.services.brands.create(h.userId, { name: "Minimal" });

    expect(brand.colors.primary).toMatch(/^[0-9A-F]{6}$/);
    expect(brand.fonts.heading).not.toBe("");
    expect(brand.tone.voice).not.toBe("");
    expect(brand.templates).toEqual({});
  });

  it("normalizes colours to canonical RRGGBB so #fff and #FFFFFF are one brand", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput({
      colors: {
        primary: "#fff", secondary: "#00FFAA", accent: "#AA00FF",
        background: "#0b0b14", surface: "#1A1A2E",
        textOnLight: "#111", textOnDark: "#FAFAFA",
      },
    } as never));

    expect(brand.colors.primary).toBe("FFFFFF");
    expect(brand.colors.background).toBe("0B0B14");
    expect(brand.colors.textOnLight).toBe("111111");
  });

  it("rejects an invalid config with field-level issues and writes NOTHING", async () => {
    const h = harness();
    const err = await rejectsWith("InvalidBrandConfig", () =>
      h.services.brands.create(h.userId, brandInput({ fonts: { heading: "zapfino", body: "georgia" } } as never)));

    // §12: field-level, readable. The offending field must be nameable from the message.
    expect(JSON.stringify(err.detail)).toContain("heading");
    // Nothing partially applied — the id was not even consumed, so the next brand is `id-1`.
    await expect(h.services.brands.list(h.userId)).resolves.toEqual([]);
  });

  it("rejects a template naming an unknown layout (the cross-check the schema alone can't do)", async () => {
    const h = harness();
    await rejectsWith("InvalidBrandConfig", () => h.services.brands.create(h.userId, brandInput({
      templates: { notALayout: { zones: [] } },
    } as never)));
  });

  it("rejects a zone whose slotKey isn't on that layout", async () => {
    const h = harness();
    const err = await rejectsWith("InvalidBrandConfig", () => h.services.brands.create(h.userId, brandInput({
      templates: {
        title: {
          zones: [{ slotKey: "nope", x: 5, y: 5, w: 50, h: 10, align: "left", valign: "top" }],
        },
      },
    } as never)));
    // Both cross-checks fire, and both matter: the stray key is named by PATH (so the editor can
    // highlight the row), and the required slot it displaced is reported separately — content with
    // nowhere to go is invisible rather than merely misplaced.
    const issues = (err.detail as { issues: string[] }).issues;
    expect(issues).toContain('templates.title.zones[0].slotKey: isn\'t a slot on the "title" layout');
    expect(issues.some((i) => i.includes('missing a zone for the required "title" slot'))).toBe(true);
  });

  it("rejects a background reference that doesn't resolve to a stored asset", async () => {
    const h = harness();
    // The dangling-reference cross-check needs the user's real asset ids, which only this layer has.
    const err = await rejectsWith("InvalidBrandConfig", () => h.services.brands.create(h.userId, brandInput({
      templates: { title: { backgroundAssetId: "ghost-asset", zones: titleZones() } },
    } as never)));
    expect(JSON.stringify(err.detail)).toContain("backgroundAssetId");
  });

  it("lets an update that only renames pass, even though it references a real background", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());
    const { brand } = await h.services.brands.addAsset(
      h.userId, created.id, bytes(), upload(),
    );

    // The regression this guards: `knownAssetIds` returning an empty set would make the brand's own
    // background look dangling, and a pure rename would fail validation.
    const { id: _i, userId: _u, createdAt: _c, updatedAt: _t, ...editable } = brand;
    await expect(
      h.services.brands.update(h.userId, brand.id, { ...editable, name: "Renamed" }),
    ).resolves.toMatchObject({ name: "Renamed" });
  });
});

describe("BrandService — JSON export/import round-trip (§11 step 3)", () => {
  it("re-imports an exported config to an identical brand, ids aside", async () => {
    const h = harness();
    const original = await h.services.brands.create(h.userId, brandInput());

    // What the export endpoint hands back is the stored definition verbatim.
    const exported = JSON.parse(JSON.stringify(original)) as unknown;
    const imported = await h.services.brands.importConfig(h.userId, exported);

    expect(imported.id).not.toBe(original.id);       // a new brand, not a silent overwrite
    expect(imported.userId).toBe(h.userId);
    const strip = ({ id: _i, createdAt: _c, updatedAt: _u, ...rest }: typeof original) => rest;
    expect(strip(imported)).toEqual(strip(original));
  });

  it("accepts a hand-written config with no ids or timestamps", async () => {
    const h = harness();
    // `withPlaceholderIdentity` exists for exactly this: an import authored by hand has no identity.
    await expect(h.services.brands.importConfig(h.userId, brandInput({ name: "Hand written" })))
      .resolves.toMatchObject({ name: "Hand written", userId: h.userId });
  });

  it("replaces the brand named in the path, never the one in the payload", async () => {
    const h = harness();
    const target = await h.services.brands.create(h.userId, brandInput({ name: "Target" }));
    const donor = await h.services.brands.create(h.userId, brandInput({ name: "Donor" }));

    const imported = await h.services.brands.importConfig(
      h.userId, { ...donor, name: "From donor" }, target.id,
    );

    expect(imported.id).toBe(target.id);
    expect(imported.name).toBe("From donor");
    await expect(h.services.brands.get(h.userId, donor.id)).resolves.toMatchObject({ name: "Donor" });
  });
});

describe("BrandService — delete guard (§11 step 11)", () => {
  it("blocks delete while a deck references the brand, then allows it", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput());
    const deck = await h.services.decks.create(h.userId, { title: "Q3", brandId: brand.id });

    const err = await rejectsWith("BrandInUse", () => h.services.brands.delete(h.userId, brand.id));
    expect(err.status).toBe(409);
    expect(err.readable).toContain("1");          // the count is what makes the message actionable
    await expect(h.services.brands.get(h.userId, brand.id)).resolves.toBeTruthy();

    await h.services.decks.delete(h.userId, deck.id);
    await expect(h.services.brands.delete(h.userId, brand.id)).resolves.toBeUndefined();
    await rejectsWith("BrandNotFound", () => h.services.brands.get(h.userId, brand.id));
  });

  it("does not count another user's deck as a reference", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput());
    // Same brandId string, different owner. Reading decks unscoped would wrongly block this delete.
    await h.services.decks.create("user-b", { title: "Theirs", brandId: brand.id });

    await expect(h.services.brands.delete(h.userId, brand.id)).resolves.toBeUndefined();
  });

  it("404s an unknown id rather than silently succeeding", async () => {
    const h = harness();
    await rejectsWith("BrandNotFound", () => h.services.brands.delete(h.userId, "nope"));
  });

  /**
   * Pins the CURRENT behaviour of a known limitation, found live rather than by reasoning: deleting a
   * brand leaves its assets in the store, and because `knownAssetIds` enumerates *references* rather than
   * stored assets, those surviving bytes stop validating. A config exported before the delete then fails
   * to import with "refers to an image that no longer exists" — while `GET /api/assets/:id` still serves
   * the image.
   *
   * Asserting it (rather than only writing it in a comment) means whichever fix lands — cascade the
   * deletion, or add `list` to the asset port — breaks this test and has to update it deliberately. A
   * limitation nothing asserts is one the next person rediscovers from a user report.
   */
  it("leaves assets behind, so a config exported beforehand no longer imports (known limitation)", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput());
    const { assetId } = await h.services.brands.addAsset(h.userId, brand.id, bytes(), upload());

    // What the editor's "Export JSON" produces, captured while the brand still exists.
    const exported = await h.services.brands.get(h.userId, brand.id);
    expect(exported.templates.title?.backgroundAssetId).toBe(assetId);

    await h.services.brands.delete(h.userId, brand.id);

    // The bytes survive: this is a leak, not a cascade.
    await expect(h.container.assets.getMeta(h.userId, assetId)).resolves.not.toBeNull();

    // But nothing references them any more, so the validator cannot see them and the round trip that
    // §11 step 3 promises is broken for this config.
    const err = await rejectsWith(
      "InvalidBrandConfig",
      () => h.services.brands.importConfig(h.userId, exported),
    );
    // `issues` is on `detail`, not on the AppError itself — the HTTP body's `issues` key is produced by
    // the route's serializer (errors.ts:305), so a test at the service layer has to read the source.
    const issues = (err.detail as { issues: string[] }).issues;
    expect(issues.join(" ")).toMatch(/no longer exists/i);

    // The same config imports fine while ANY brand still references the asset — proof the failure is the
    // reference bookkeeping and not the asset itself.
    const holder = await h.services.brands.create(h.userId, brandInput());
    await h.services.brands.addAsset(h.userId, holder.id, bytes(), upload());
    const held = await h.services.brands.get(h.userId, holder.id);
    await expect(h.services.brands.importConfig(h.userId, held)).resolves.toBeTruthy();
  });
});

describe("BrandService — assets", () => {
  it("seeds the template's zones from the layout's defaultZones (§4)", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());

    const { assetId, brand } = await h.services.brands.addAsset(
      h.userId, created.id, bytes(), upload(),
    );

    const seeded = brand.templates.title;
    const layout = LAYOUTS.find((l) => l.id === "title")!;
    expect(seeded?.backgroundAssetId).toBe(assetId);
    // Seeded from the registry, not from an empty array — this is what makes the zone table non-empty
    // when the brand editor opens, and it must be a COPY (editing it must not mutate the registry).
    expect(seeded?.zones).toEqual(layout.defaultZones);
    expect(seeded?.zones[0]).not.toBe(layout.defaultZones[0]);
  });

  it("rejects an unknown layoutId BEFORE storing bytes, leaving no orphan asset", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());

    await rejectsWith("InvalidBrandConfig", () => h.services.brands.addAsset(
      h.userId, created.id, bytes(), upload({ layoutId: "notALayout" }),
    ));

    // The orphan check: an id was never minted, so nothing was written to the store.
    expect(h.ids()).toEqual(["id-1"]);
  });

  it("requires a layoutId for a background", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());
    const err = await rejectsWith("InvalidBrandConfig", () => h.services.brands.addAsset(
      h.userId, created.id, bytes(), upload({ layoutId: undefined }),
    ));
    expect(JSON.stringify(err.detail)).toContain("layoutId");
  });

  it("preserves customized zones when a background is replaced", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput({
      templates: {
        title: {
          zones: [{ slotKey: "title", x: 42, y: 12, w: 50, h: 20, align: "left", valign: "top" }],
        },
      },
    } as never));

    const { brand } = await h.services.brands.addAsset(
      h.userId, created.id, bytes(), upload(),
    );

    // Re-seeding here would silently discard the user's zone table on a background swap.
    expect(brand.templates.title?.zones).toEqual([
      { slotKey: "title", x: 42, y: 12, w: 50, h: 20, align: "left", valign: "top" },
    ]);
  });

  it("detaches the reference before deleting the bytes, leaving a valid brand", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());
    const { assetId } = await h.services.brands.addAsset(
      h.userId, created.id, bytes(), upload(),
    );

    const after = await h.services.brands.removeAsset(h.userId, created.id, assetId);

    expect(after.templates.title?.backgroundAssetId).toBeUndefined();
    // The zones survive — losing them would silently reset a customized layout to defaults.
    expect(after.templates.title?.zones.length).toBeGreaterThan(0);
    // And the brand still validates, which is the point of detaching first: a dangling reference would
    // make every later save fail the asset cross-check.
    const { id: _i, userId: _u, createdAt: _c, updatedAt: _t, ...editable } = after;
    await expect(h.services.brands.update(h.userId, created.id, editable)).resolves.toBeTruthy();
  });
});

describe("BrandService — theme and template resolution (§8)", () => {
  it("compiles tokens rather than exposing the brand for appearance", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());
    const { tokens } = await h.services.brands.themeFor(h.userId, created.id);

    // Tokens are the only appearance input a renderer or exporter may see (`lib/brand/types.ts`).
    expect(tokens.colors.primary).toMatch(/^[0-9A-F]{6}$/);
    expect(tokens.fonts.headingPptx).toBeTruthy();
    expect(tokens.type.display).toBeGreaterThan(tokens.type.body);
  });

  it("falls back to defaultZones in token-styled mode, and reports the mode", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());

    const plain = await h.services.brands.resolveTemplate(h.userId, created.id, "title");
    expect(plain.mode).toBe("token-styled");
    expect(plain.zonesCustomized).toBe(false);
    expect(plain.zones).toEqual(LAYOUTS.find((l) => l.id === "title")!.defaultZones);
    expect(plain.backgroundAssetId).toBeUndefined();

    await h.services.brands.addAsset(
      h.userId, created.id, bytes(), upload(),
    );
    const templated = await h.services.brands.resolveTemplate(h.userId, created.id, "title");
    expect(templated.mode).toBe("templated");
    expect(templated.backgroundAssetId).toBeTruthy();
  });

  it("treats an unknown layoutId from a URL as a bad request, not an internal error", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());
    const err = await rejectsWith("InvalidBrandConfig", () =>
      h.services.brands.resolveTemplate(h.userId, created.id, "notALayout"));
    expect(err.status).toBe(400);
  });
});

describe("BrandService — resolveRenderAssets (§1.1/C3)", () => {
  it("returns ONE object shared by every layout using the same background", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());
    const { assetId } = await h.services.brands.addAsset(
      h.userId, created.id, bytes(), upload(),
    );

    // Point a second layout at the SAME asset — the common brand shape, and the case C3 is about.
    const withShared = await h.services.brands.update(h.userId, created.id, {
      ...brandInput(),
      templates: {
        title: { backgroundAssetId: assetId, zones: titleZones() },
        bullets: { backgroundAssetId: assetId, zones: zonesOf("bullets") },
      },
    });

    const resolved = await h.services.brands.resolveRenderAssets(
      h.userId, withShared, ["title", "bullets"],
    );

    // Object IDENTITY, not deep equality: it is how the exporter recognises the distinct set without
    // comparing bytes, so `toEqual` here would pass even if the dedupe were removed.
    expect(resolved.backgroundsByLayoutId.title)
      .toBe(resolved.backgroundsByLayoutId.bullets);
    expect(resolved.backgroundsByLayoutId.title?.bytes).toBeInstanceOf(Uint8Array);
  });

  it("resolves nothing for layouts with no background, and skips a missing one", async () => {
    const h = harness();
    const created = await h.services.brands.create(h.userId, brandInput());
    const { assetId, brand } = await h.services.brands.addAsset(
      h.userId, created.id, bytes(), upload(),
    );

    // Bytes deleted out from under a valid config — the exact case `resolveOrSkip` swallows.
    await h.container.assets.delete(h.userId, assetId);

    const resolved = await h.services.brands.resolveRenderAssets(h.userId, brand, ["title", "quote"]);
    // Skipped, not thrown: the layout exports token-styled, which is a complete slide.
    expect(resolved.backgroundsByLayoutId).toEqual({});
    expect(resolved.logos).toBeUndefined();
  });
});
