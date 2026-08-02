/**
 * §2 step 12 — `ExportService`.
 *
 * ## Format resolution, tested against fakes; format bytes, tested elsewhere
 *
 * What is under test here is the *resolution*: which exporter a format selects, and exactly what
 * resolved inputs it is handed. A fake exporter that records its `ExportRequest` is therefore the right
 * dependency even now that the real `PptxExporter` exists — `tests/pptx-exporter.test.ts` owns the bytes.
 *
 * Two rules keep that honest:
 *   - the `ExportRequest` assertions read the real resolved values from the harness's repositories, so
 *     the fake proves nothing by itself;
 *   - the container-wired service is exercised too (`the container's own wiring`, below), so "step 13
 *     registered pptx under the right key" is not left to a comment.
 *
 * This file was written before step 13 with the note that it would switch to `h.services.export` "and
 * the assertions stand unchanged". They did — the hand-wired `service()` helper survives only because
 * these cases need to inject *fake* format maps, which the container by definition does not offer.
 *
 * (`new ExportService(...)` is not a §3 violation: the construction ban covers concrete *impls* —
 * `tests/architecture.test.ts` matches `new (File|Memory|LocalDisk|Stub|Bedrock|Pptx)…` — and a service
 * over injected ports is what the container itself does.)
 */

import { describe, expect, it } from "vitest";
import type { AssetMeta } from "@/lib/domain/asset";
import type { ExportRequest, ExportResult, Exporter } from "@/lib/ports/exporter";
import { AppError } from "@/lib/errors/errors";
import { PPTX_CONTENT_TYPE } from "@/lib/export/pptx-exporter";
import { LAYOUTS } from "@/lib/layouts/registry";
import { ExportService, exportFilename } from "@/lib/services/export-service";
import { brandInput, harness, type Harness } from "@/tests/service-harness";

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

/** Records what it was handed, so the resolution is assertable without a real format. */
function fakeExporter(format: string): Exporter & { seen: ExportRequest[] } {
  const seen: ExportRequest[] = [];
  return {
    format,
    seen,
    async export(request): Promise<ExportResult> {
      seen.push(request);
      return {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: `application/${format}`,
        filename: exportFilename(request.deck, format),
      };
    },
  };
}

const service = (h: Harness, exporters: Record<string, Exporter>) =>
  new ExportService({ decks: h.services.decks, brands: h.services.brands, exporters });

/** A brand, a deck, and `count` slides — the minimum an export needs. */
async function exportable(h: Harness, count = 2, title = "Q3 Review") {
  const brand = await h.services.brands.create(h.userId, brandInput());
  const deck = await h.services.decks.create(h.userId, { title, brandId: brand.id });
  for (let n = 1; n <= count; n += 1) {
    await h.services.decks.addSlide(h.userId, deck.id, {
      layoutId: "bullets", slots: { title: `Slide ${n}`, items: [`Point ${n}`] },
    });
  }
  return { brand, deck };
}

const png = (): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/**
 * A layout's own `defaultZones`, copied.
 *
 * Read from the registry rather than written out, so a layout gaining a required slot doesn't silently
 * turn these fixtures into assertions about the missing-zone error instead — a template must place every
 * required slot or `validateBrand` rejects it.
 */
const zonesOf = (layoutId: string) =>
  LAYOUTS.find((l) => l.id === layoutId)!.defaultZones.map((z) => ({ ...z }));

/** `addAsset` takes `Omit<AssetMeta, "createdAt">` — the service stamps the time itself. */
const background = (layoutId: string): Omit<AssetMeta, "createdAt"> => ({
  filename: `bg-${layoutId}.png`,
  contentType: "image/png",
  byteSize: 4,
  width: 1920,
  height: 1080,
  kind: "background",
  layoutId,
});

describe("ExportService — format selection is a registry", () => {
  it("lists the formats this deployment has, sorted", () => {
    const h = harness();
    const svc = service(h, { pptx: fakeExporter("pptx"), html: fakeExporter("html") });
    // Sorted, because this is the download menu's order and a menu that reshuffles per process start
    // (object key order is insertion order, and the container's insertion order is not a UI decision)
    // would move the item under the user's cursor.
    expect(svc.formats()).toEqual(["html", "pptx"]);
  });

  it("routes to the exporter registered under the requested format", async () => {
    const h = harness();
    const pptx = fakeExporter("pptx");
    const html = fakeExporter("html");
    const { deck } = await exportable(h);

    const result = await service(h, { pptx, html }).export(h.userId, deck.id, "html");

    expect(result.contentType).toBe("application/html");
    expect(html.seen).toHaveLength(1);
    expect(pptx.seen).toHaveLength(0);
  });

  it("rejects an unknown format as a 400 that names the alternatives", async () => {
    const h = harness();
    const { deck } = await exportable(h);
    const svc = service(h, { pptx: fakeExporter("pptx") });

    const err = await rejectsWith("UnknownExportFormat", () => svc.export(h.userId, deck.id, "pdf"));
    // A format arrives from a URL segment, so this is a bad request, not a bug. "pptx isn't available,
    // try html" is actionable where "unsupported format" is not — so the list is in the readable text.
    expect(err.status).toBe(400);
    expect(err.readable).toContain("pptx");
  });

  it("does not resolve a prototype key as an exporter", async () => {
    const h = harness();
    const { deck } = await exportable(h);
    const svc = service(h, { pptx: fakeExporter("pptx") });

    // `exporters["toString"]` under a bare index resolves to a function off the prototype chain and
    // would then be CALLED as an exporter. The format comes straight from a URL segment, so this is
    // reachable input rather than a hypothetical — hence `Object.hasOwn`.
    for (const key of ["toString", "constructor", "__proto__", "valueOf"]) {
      await rejectsWith("UnknownExportFormat", () => svc.export(h.userId, deck.id, key));
    }
  });

  it("fails loudly when a container entry is filed under the wrong key", async () => {
    const h = harness();
    const { deck } = await exportable(h);
    // A wiring mistake: the pptx exporter registered under "ppt". Resolving by key alone would succeed
    // and then hand the user a file named `.ppt` containing pptx bytes.
    const svc = service(h, { ppt: fakeExporter("pptx") });

    await expect(svc.export(h.userId, deck.id, "ppt")).rejects.toThrow(/fix lib\/container\.ts/);
  });
});

describe("ExportService — the resolved request", () => {
  it("hands the exporter the deck, its slides in order, and compiled tokens", async () => {
    const h = harness();
    const pptx = fakeExporter("pptx");
    const { brand, deck } = await exportable(h, 3);

    await service(h, { pptx }).export(h.userId, deck.id, "pptx");

    const request = pptx.seen[0]!;
    expect(request.deck.id).toBe(deck.id);
    expect(request.slides.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(request.slides.map((s) => s.slots.title)).toEqual(["Slide 1", "Slide 2", "Slide 3"]);
    expect(request.brand.id).toBe(brand.id);

    // COMPILED tokens, not the raw `BrandDefinition`'s colours: appearance is read through `themeFor` so
    // contrast repair has already happened once, rather than per consumer or not at all.
    const { tokens } = await h.services.brands.themeFor(h.userId, brand.id);
    expect(request.tokens).toEqual(tokens);
    expect(request.tokens.fonts.headingPptx).toBeDefined();
  });

  it("carries no repository, asset store, or userId into the exporter", async () => {
    const h = harness();
    const pptx = fakeExporter("pptx");
    const { deck } = await exportable(h);

    await service(h, { pptx }).export(h.userId, deck.id, "pptx");

    // The port's whole shape claim: an exporter is a pure function of resolved inputs and cannot reach
    // storage. Asserted on the actual keys, since an accidental `userId` passthrough would type-check
    // against `ExportRequest`'s excess-property rules only at the literal — not here.
    expect(Object.keys(pptx.seen[0]!).sort())
      .toEqual(["backgroundsByLayoutId", "brand", "deck", "slides", "tokens"]);
  });

  it("resolves backgrounds only for the layouts the deck actually uses", async () => {
    const h = harness();
    const pptx = fakeExporter("pptx");
    const { brand, deck } = await exportable(h);          // two `bullets` slides

    // Backgrounds on both `bullets` (used) and `title` (not used by any slide).
    await h.services.brands.addAsset(h.userId, brand.id, png(), background("bullets"));
    await h.services.brands.addAsset(h.userId, brand.id, png(), background("title"));

    await service(h, { pptx }).export(h.userId, deck.id, "pptx");

    // Reading bytes for a background no slide references is wasted IO — and on a brand with a background
    // per layout that is most of them.
    expect(Object.keys(pptx.seen[0]!.backgroundsByLayoutId)).toEqual(["bullets"]);
  });

  it("shares ONE resolved asset object across layouts using the same background (§1.1/C3)", async () => {
    const h = harness();
    const pptx = fakeExporter("pptx");
    const { brand, deck } = await exportable(h);

    // One upload, then pointed at a second layout — the shape a brand with a single house background has.
    const { assetId } = await h.services.brands.addAsset(
      h.userId, brand.id, png(), background("bullets"));
    const current = await h.services.brands.get(h.userId, brand.id);
    await h.services.brands.update(h.userId, brand.id, {
      ...brandInput(),
      templates: {
        ...current.templates,
        closing: { zones: zonesOf("closing"), backgroundAssetId: assetId },
      },
    });
    // A `closing` slide so both templated layouts are in play.
    await h.services.decks.addSlide(h.userId, deck.id, {
      layoutId: "closing", slots: { title: "Approve it", nextSteps: ["Sign off"] },
    });

    await service(h, { pptx }).export(h.userId, deck.id, "pptx");

    const backgrounds = pptx.seen[0]!.backgroundsByLayoutId;
    // OBJECT IDENTITY, not deep equality. pptxgenjs does not dedupe identical media (611 KB / 15 parts
    // → 146 KB / 1 part in the §1.1 probe), so the exporter must build one master per DISTINCT
    // background — and identity is how it recognises the distinct set without comparing bytes.
    expect(backgrounds.bullets).toBe(backgrounds.closing);
  });

  it("omits logos entirely when the brand has none", async () => {
    const h = harness();
    const pptx = fakeExporter("pptx");
    const { deck } = await exportable(h);

    await service(h, { pptx }).export(h.userId, deck.id, "pptx");

    // Absent rather than `{}`: an exporter checking `if (request.logos)` must not take the branch for a
    // brand that has no logo.
    expect(pptx.seen[0]!.logos).toBeUndefined();
  });
});

describe("ExportService — the container's own wiring", () => {
  it("offers pptx, keyed so that the format field matches (§2 step 13)", async () => {
    const h = harness();
    const { deck } = await exportable(h, 1);

    // The real registration, not a fake: `createExporters` files `PptxExporter` under "pptx". A key/field
    // mismatch here is exactly what `export` throws on, so this both proves the format is available and
    // that it was filed correctly.
    expect(h.services.export.formats()).toEqual(["pptx"]);

    const result = await h.services.export.export(h.userId, deck.id, "pptx");
    expect(result.contentType).toBe(PPTX_CONTENT_TYPE);
    expect(result.filename).toBe("Q3-Review.pptx");
    // A real .pptx is a ZIP — `PK\x03\x04`. Enough to show the container produced a working exporter
    // rather than a stub; `tests/pptx-exporter.test.ts` unpacks it and checks the XML.
    expect([...result.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});

describe("ExportService — preconditions and scoping", () => {
  it("refuses a deck with no slides, naming the step to do first", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput());
    const deck = await h.services.decks.create(h.userId, { title: "Empty", brandId: brand.id });
    const pptx = fakeExporter("pptx");

    const err = await rejectsWith("DeckNotReady", () =>
      service(h, { pptx }).export(h.userId, deck.id, "pptx"));
    // 409, not 400: the request is well-formed and the fix is an action on the deck. A zero-slide PPTX
    // downloads fine and looks like the export is broken.
    expect(err.status).toBe(409);
    expect(err.readable).toMatch(/generate them/i);
    expect(pptx.seen).toHaveLength(0);
  });

  it("404s another user's deck without invoking the exporter", async () => {
    const h = harness();
    const { deck } = await exportable(h);
    const pptx = fakeExporter("pptx");

    await rejectsWith("DeckNotFound", () => service(h, { pptx }).export("user-b", deck.id, "pptx"));
    expect(pptx.seen).toHaveLength(0);
  });

  it("404s a brand the deck references but the user cannot read", async () => {
    const h = harness();
    const { brand, deck } = await exportable(h);
    // The brand is deleted out from under the deck. `BrandInUse` normally prevents this, so reaching it
    // takes a repository-level delete — the point being that the export fails readably rather than
    // exporting a deck with no theme.
    await h.container.brands.delete(h.userId, brand.id);

    await rejectsWith("BrandNotFound", () =>
      service(h, { pptx: fakeExporter("pptx") }).export(h.userId, deck.id, "pptx"));
  });

  it("builds the same request through buildRequest as through export (§8)", async () => {
    const h = harness();
    const pptx = fakeExporter("pptx");
    const { deck } = await exportable(h);
    const svc = service(h, { pptx });

    await svc.export(h.userId, deck.id, "pptx");
    const built = await svc.buildRequest(h.userId, deck.id);

    // §8's zone-fidelity check uses `buildRequest` as its fixture builder, which is only meaningful if it
    // produces what the export path produces. A separate assembly path here would mean the fidelity
    // comparison was validating its own reconstruction.
    expect(built).toEqual(pptx.seen[0]);
  });
});

describe("exportFilename", () => {
  it("derives a filesystem-safe name from the deck title", () => {
    expect(exportFilename({ title: "Q3 Review" }, "pptx")).toBe("Q3-Review.pptx");
    // A whitelist, not a blacklist: a blacklist has to enumerate every reserved character on every
    // platform and misses the next one. Path separators are the case that actually matters.
    expect(exportFilename({ title: "../../etc/passwd" }, "pptx")).toBe("etc-passwd.pptx");
    expect(exportFilename({ title: "Billing: Q3/Q4 <draft>" }, "pptx")).toBe("Billing-Q3-Q4-draft.pptx");
  });

  it("keeps non-Latin titles rather than emptying or mangling them", () => {
    // `\p{L}` is Unicode-aware, so these survive where an ASCII-only class would strip them to nothing
    // and every such deck would download as `deck.pptx`.
    //
    // Both cases below caught a real bug: the original normalized to NFKD, which decomposes `デ` into
    // `テ` + a combining dakuten and `é` into `e` + a combining acute. A combining mark matches neither
    // `\p{L}` nor `\p{N}`, so it became a hyphen INSIDE the word — `テ-ッキ`, `Cafe-`.
    expect(exportFilename({ title: "日本語のデッキ" }, "pptx")).toBe("日本語のデッキ.pptx");
    expect(exportFilename({ title: "Café Q3" }, "pptx")).toBe("Café-Q3.pptx");
  });

  it("falls back to `deck` when nothing survives, and caps the length", () => {
    expect(exportFilename({ title: "!!!" }, "pptx")).toBe("deck.pptx");
    expect(exportFilename({ title: "" }, "pptx")).toBe("deck.pptx");
    const long = exportFilename({ title: "A".repeat(200) }, "pptx");
    // Capped so the name cannot exceed a filesystem's per-component limit once the extension is added.
    expect(long.length).toBeLessThanOrEqual(85);
    expect(long.endsWith(".pptx")).toBe(true);
  });
});
