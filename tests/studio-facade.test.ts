/**
 * §2 step 14 — `StudioFacade`.
 *
 * ## What this suite deliberately does NOT test
 *
 * Not brand validation, not slot budgets, not the generation chain: those are the service suites', and
 * re-asserting them through the facade would double the cost of every future change to buy nothing. Most
 * of this file's methods are one-line delegations, and a test per delegation is a test that only ever
 * catches a typo the compiler already catches.
 *
 * What IS tested here is what the facade uniquely owns and what would be silently broken if it were
 * wrong:
 *
 *   1. **Authentication.** Every method resolves its own principal and raises `Unauthorized` when there
 *      is none. The security property is that a caller cannot supply a userId — so the test that matters
 *      is that two containers with different principals cannot see each other's data through the facade,
 *      and that a header claiming otherwise changes nothing.
 *   2. **Orchestration.** The four methods that touch more than one service: `createDeck`'s brand check,
 *      `switchBrand`'s re-resolution, `workspace`'s single-revision composition, and `templatesFor`'s
 *      narrowing to the layouts a deck actually uses.
 *   3. **Coverage.** That every service capability a route will need is reachable — the check that
 *      catches "step 15 needs this and the facade has no method for it" now instead of at route time.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors/errors";
import { createContainer } from "@/lib/container";
import { StudioFacade } from "@/lib/facade/studio-facade";
import { LAYOUTS, requireLayout } from "@/lib/layouts/registry";
import type { VisualHint } from "@/lib/domain/deck";
import { brandInput, harness, outlineOf, recorder, slideResponseFor } from "@/tests/service-harness";

/** A PNG signature — same convention as `tests/brand-service.test.ts`; the stores are byte-agnostic. */
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/**
 * A deck with a brand AND a briefing, ready for the orchestration tests.
 *
 * The briefing is not optional scaffolding: `OutlineService` raises `DeckNotReady` without one, so a deck
 * created bare cannot reach outline or generation at all.
 */
async function deckWithBrand(h = harness()) {
  const brand = await h.facade.createBrand(h.headers, brandInput());
  const deck = await h.facade.createDeck(h.headers, {
    title: "Q3 Review",
    brandId: brand.id,
    briefing: {
      topic: "Q3 results", audience: "the exec team", objective: "approve the Q4 plan",
      targetSlideCount: 3,
    },
  });
  return { h, brand, deck };
}

describe("StudioFacade — authentication is the facade's, not the route's", () => {
  it("raises Unauthorized when the provider yields no principal", async () => {
    // The stub always authenticates, so an unauthenticated provider is substituted directly. This is the
    // Cognito-with-no-session case, and it must be a 401 rather than a crash or an anonymous read.
    const { services } = harness().container;
    const facade = new StudioFacade({
      auth: { authenticate: async () => null },
      ...services,
    });

    await expect(facade.listBrands(new Headers())).rejects.toThrow(AppError);
    await expect(facade.listBrands(new Headers())).rejects.toMatchObject({
      code: "Unauthorized", status: 401,
    });
  });

  it("scopes reads to the authenticated principal, so one user cannot see another's brands", async () => {
    // Two containers over ONE store would be the sharper test, but the memory backend is per-instance;
    // what is verifiable here is that the userId the facade threads is the provider's. Both facades run
    // over the same services with different principals.
    const { services } = harness().container;
    const asA = new StudioFacade({ auth: principal("user-a"), ...services });
    const asB = new StudioFacade({ auth: principal("user-b"), ...services });

    const brand = await asA.createBrand(new Headers(), brandInput({ name: "A's brand" }));

    expect(await asA.listBrands(new Headers())).toHaveLength(1);
    expect(await asB.listBrands(new Headers())).toEqual([]);
    // Not merely absent from the list — unreadable by id, which is the property that matters when the id
    // is guessable or leaked.
    await expect(asB.getBrand(new Headers(), brand.id)).rejects.toMatchObject({ code: "BrandNotFound" });
  });

  it("ignores a header claiming a different user", async () => {
    // The authorization hole this design forecloses: with `userId` as a parameter, any route could be one
    // line away from trusting the client. Here there is no parameter to trust.
    const h = harness();
    const brand = await h.facade.createBrand(h.headers, brandInput());
    const spoofed = new Headers({ "x-user-id": "user-b", "x-userid": "user-b" });

    expect(await h.facade.listBrands(spoofed)).toHaveLength(1);
    await expect(h.facade.getBrand(spoofed, brand.id)).resolves.toMatchObject({ id: brand.id });
  });

  it("exposes the principal itself, for routes that need a display name", async () => {
    const h = harness();
    await expect(h.facade.principal(h.headers)).resolves.toMatchObject({ userId: h.userId });
  });
});

describe("StudioFacade — orchestration across services", () => {
  it("rejects a deck whose brand does not exist, at creation rather than at outline time", async () => {
    const h = harness();
    // Without the facade's pre-check this succeeds and fails later, on an unrelated action, with a
    // BrandNotFound that names a brand the user never chose on that screen.
    await expect(h.facade.createDeck(h.headers, { title: "Orphan", brandId: "brand-nope" }))
      .rejects.toMatchObject({ code: "BrandNotFound", status: 404 });

    expect(await h.facade.listDecks(h.headers)).toEqual([]);
  });

  it("rejects a deck pointed at ANOTHER user's brand", async () => {
    const { services } = harness().container;
    const asA = new StudioFacade({ auth: principal("user-a"), ...services });
    const asB = new StudioFacade({ auth: principal("user-b"), ...services });
    const brand = await asA.createBrand(new Headers(), brandInput());

    // The scoped read is what refuses this; B never gets a deck referencing A's brand.
    await expect(asB.createDeck(new Headers(), { title: "Borrowed", brandId: brand.id }))
      .rejects.toMatchObject({ code: "BrandNotFound" });
  });

  it("switchBrand validates the target and returns re-resolved templates", async () => {
    const { h, deck } = await deckWithBrand();
    const other = await h.facade.createBrand(h.headers, brandInput({ name: "Second Brand" }));

    const result = await h.facade.switchBrand(h.headers, deck.id, other.id);

    expect(result.deck.brandId).toBe(other.id);
    expect(result.brand.id).toBe(other.id);
    // Tokens describe the brand that was switched TO — the drift a second round trip could introduce.
    expect(result.tokens).toEqual((await h.facade.getBrandTheme(h.headers, other.id)).tokens);
  });

  it("switchBrand refuses an unknown brand and leaves the deck untouched", async () => {
    const { h, brand, deck } = await deckWithBrand();

    await expect(h.facade.switchBrand(h.headers, deck.id, "brand-nope"))
      .rejects.toMatchObject({ code: "BrandNotFound" });
    // The guarantee: a failed swap is not a partial swap (§12 "nothing partially applied").
    await expect(h.facade.getDeck(h.headers, deck.id)).resolves.toMatchObject({ brandId: brand.id });
  });

  it("getBrandTheme composes brand, tokens and templates for exactly the TEMPLATED layouts", async () => {
    const h = harness();
    const brand = await h.facade.createBrand(h.headers, brandInput());

    // No background yet: nothing to resolve, and the field is still present so the editor never has to
    // distinguish "this brand has no templates" from "this deployment doesn't send them".
    await expect(h.facade.getBrandTheme(h.headers, brand.id))
      .resolves.toMatchObject({ templates: [] });

    await h.facade.addBrandAsset(h.headers, brand.id, BYTES, {
      filename: "bg.png", kind: "background", layoutId: "title", width: 800, height: 600,
    });
    const view = await h.facade.getBrandTheme(h.headers, brand.id);

    // Narrowed by the SHARED `templatedLayoutIds` rule, not a local filter — a second copy here could
    // disagree with the resolver about the very brand it is resolving. Customizing zones without a
    // background is deliberately not "templated": `resolveRenderPlan` says so, so this must too.
    expect(view.templates.map((t) => t.layoutId)).toEqual(["title"]);
    expect(view.templates.length).toBeLessThan(LAYOUTS.length);
    expect(view.templates[0]?.mode).toBe("templated");
    // The §12 letterbox badge's input, which a browser cannot derive from a CSS background image.
    expect(view.templates[0]?.backgroundSize).toEqual({ width: 800, height: 600 });
    // One revision, three parts: the brand carried alongside is the one the tokens were compiled from.
    expect(view.brand.id).toBe(brand.id);
    expect(view.brand.templates["title"]?.backgroundAssetId).toBe(view.templates[0]?.backgroundAssetId);
  });

  it("workspace composes deck, slides, brand, tokens and templates in one call", async () => {
    const { h, brand, deck } = await deckWithBrand();
    await generate(h, deck.id);

    const view = await h.facade.workspace(h.headers, deck.id);

    expect(view.deck.id).toBe(deck.id);
    expect(view.brand.id).toBe(brand.id);
    expect(view.slides.length).toBeGreaterThan(0);
    expect(view.exportFormats).toContain("pptx");
    // Tokens are the brand's compiled tokens, not a second compilation of a different revision.
    expect(view.tokens).toEqual((await h.facade.getBrandTheme(h.headers, brand.id)).tokens);
  });

  it("workspace resolves templates for exactly the layouts the deck uses, and no others", async () => {
    const { h, deck } = await deckWithBrand();
    await generate(h, deck.id);

    const view = await h.facade.workspace(h.headers, deck.id);
    const used = [...new Set(view.slides.map((s) => s.layoutId))].sort();

    // Narrowed the same way `ExportService.buildRequest` narrows. If these diverged, the preview would
    // show zones for slides the export never renders — the §8 mismatch this suite exists to prevent.
    expect(view.templates.map((t) => t.layoutId).sort()).toEqual(used);
    expect(view.templates.length).toBeLessThan(LAYOUTS.length);
  });

  it("workspace fails with DeckNotFound for another user's deck", async () => {
    const { services } = harness().container;
    const asA = new StudioFacade({ auth: principal("user-a"), ...services });
    const asB = new StudioFacade({ auth: principal("user-b"), ...services });
    const brand = await asA.createBrand(new Headers(), brandInput());
    const deck = await asA.createDeck(new Headers(), { title: "Private", brandId: brand.id });

    await expect(asB.workspace(new Headers(), deck.id)).rejects.toMatchObject({ code: "DeckNotFound" });
  });
});

describe("StudioFacade — asset serving", () => {
  it("streams an asset's bytes for its owner", async () => {
    const h = harness();
    const brand = await h.facade.createBrand(h.headers, brandInput());
    const { assetId } = await h.facade.addBrandAsset(h.headers, brand.id, BYTES, {
      filename: "bg.png", contentType: "image/png", kind: "background", layoutId: "title",
    });

    const asset = await h.facade.serveAsset(h.headers, assetId);
    expect(asset.contentType).toBe("image/png");
    expect(asset.byteSize).toBe(BYTES.byteLength);
    // Drain it: a route returns this body directly, so it must actually be readable.
    const chunks: Uint8Array[] = [];
    for await (const chunk of asset.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    expect(Buffer.concat(chunks).byteLength).toBe(BYTES.byteLength);
  });

  it("derives byteSize from the bytes, not from the upload's claim", async () => {
    const h = harness();
    const brand = await h.facade.createBrand(h.headers, brandInput());
    // A multipart part can claim any length; the stored size is what the editor shows.
    const { assetId } = await h.facade.addBrandAsset(h.headers, brand.id, BYTES, {
      filename: "bg.png", contentType: "image/png", kind: "logo",
    });
    expect((await h.facade.serveAsset(h.headers, assetId)).byteSize).toBe(BYTES.byteLength);
  });

  it("returns AssetNotFound — not Forbidden — for another user's asset id", async () => {
    const { services } = harness().container;
    const asA = new StudioFacade({ auth: principal("user-a"), ...services });
    const asB = new StudioFacade({ auth: principal("user-b"), ...services });
    const brand = await asA.createBrand(new Headers(), brandInput());
    const { assetId } = await asA.addBrandAsset(new Headers(), brand.id, BYTES, {
      filename: "bg.png", contentType: "image/png", kind: "logo",
    });

    // 404 rather than 403 deliberately: a distinguishable "exists but forbidden" turns the serving URL
    // space into an id oracle. The serving URL carries no userId, so this is the only scoping there is.
    await expect(asB.serveAsset(new Headers(), assetId))
      .rejects.toMatchObject({ code: "AssetNotFound", status: 404 });
  });
});

describe("StudioFacade — the streaming seam", () => {
  it("emits events through the callback and returns counts that match them", async () => {
    const { h, deck } = await deckWithBrand();
    const { events, emit } = recorder();

    await outlineAndScript(h, deck.id, ["list", "list"]);
    const result = await h.facade.generateDeck(h.headers, deck.id, { emit });

    // The facade owns WHICH events occur; the route owns SSE framing. That split is what makes this
    // assertable with no HTTP server (§9).
    expect(events.filter((e) => e.type === "slide-done")).toHaveLength(result.ok);
    expect(result.ok).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("passes an instruction through to a slide regeneration", async () => {
    const { h, deck } = await deckWithBrand();
    await outlineAndScript(h, deck.id, ["list"]);
    const { emit } = recorder();
    await h.facade.generateDeck(h.headers, deck.id, { emit });

    const [slide] = await h.facade.workspace(h.headers, deck.id).then((v) => v.slides);
    h.llm.push({ text: slideResponseFor(requireLayout(slide!.layoutId), "Punchier") });
    await h.facade.regenerateSlide(h.headers, deck.id, slide!.id, { emit, instruction: "punchier" });

    // §12 requires the instruction to demonstrably alter output; here the check is that it REACHED the
    // model at all, which is the facade's whole responsibility for it.
    expect(h.llm.calls.at(-1)?.prompt).toContain("punchier");
  });
});

describe("StudioFacade — route coverage and layer hygiene", () => {
  it("exposes a method for every endpoint SPEC §3 lists", async () => {
    // The check that catches a missing use-case at step 14 rather than at step 15, when a route has
    // nothing to call and the tempting fix is to reach past the facade into a service.
    const f = StudioFacade.prototype as unknown as Record<string, unknown>;
    for (const method of [
      "listBrands", "getBrand", "getBrandTheme", "resolveTemplate", "createBrand", "updateBrand",
      "importBrand", "deleteBrand", "addBrandAsset", "removeBrandAsset", "serveAsset",
      "listDecks", "createDeck", "getDeck", "setDeckTitle", "setBriefing", "switchBrand", "deleteDeck",
      "generateOutline", "regenerateOutlineSection", "saveOutline", "setLayoutOverride", "outlineView",
      "generateDeck", "regenerateSlide",
      "getSlide", "updateSlide", "duplicateSlide", "deleteSlide", "reorderSlides",
      "workspace", "exportFormats", "exportDeck", "principal",
    ]) {
      expect(typeof f[method], `StudioFacade.${method} is missing`).toBe("function");
    }
  });

  it("takes Headers on every public use-case method, never a userId", async () => {
    // The structural version of the authentication test: a method accepting a userId would reintroduce
    // the parameter this design removes. Read the source, because a signature is not introspectable.
    const source = await readFile(
      path.join(path.resolve(__dirname, ".."), "lib/facade/studio-facade.ts"), "utf8",
    );
    // Public methods only — `private async userId(headers)` legitimately names the thing.
    const signatures = source.match(/^  (?:async )?[a-zA-Z][a-zA-Z0-9]*\([^)]*/gm) ?? [];
    expect(signatures.length).toBeGreaterThan(20);

    const offenders = signatures.filter(
      (s) => /\buserId\s*:/.test(s) && !s.includes("private"),
    );
    expect(offenders).toEqual([]);
  });

  it("holds no state beyond its deps", () => {
    // A facade that cached would be a facade with a stale-data bug waiting to happen: `workspace` is
    // composed fresh precisely so it describes one revision.
    const facade = harness().facade;
    expect(Object.keys(facade)).toEqual(["deps"]);
  });

  it("is the same instance the container exposes, over the same services", () => {
    const c = createContainer({ storageBackend: "memory", assetBackend: "memory" });
    expect(c.facade).toBe(c.facade);
    // Assembled from `container.services`, not from an independently-constructed second graph — the
    // failure mode would be routes writing through one set of services while tests read another.
    expect(c.facade).toBeInstanceOf(StudioFacade);
    expect((c.facade as unknown as { deps: { decks: unknown } }).deps.decks).toBe(c.services.decks);
  });
});

/* ─────────────────────────────── helpers ─────────────────────────────── */

const principal = (userId: string) => ({ authenticate: async () => ({ userId }) });

/**
 * Save an outline, then script one clean response per slide it will actually produce.
 *
 * The layouts are read from the mapping chain, not from the `visualHint`s: the chain's Positional rule
 * gives a deck's first slide `title` regardless of its hint, so scripting per hint yields a response that
 * fails validation and lands as a *fallback* slide — which looks like a facade bug in the counts. Same
 * approach as `plannedLayouts` in `tests/generation-service.test.ts`, and §4's reason: the layout each
 * slide gets is the registry's decision to state, not a fixture's to duplicate.
 */
async function outlineAndScript(
  h: ReturnType<typeof harness>, deckId: string, hints: readonly VisualHint[], label = "Value",
): Promise<string[]> {
  const outline = outlineOf(hints);
  await h.facade.saveOutline(h.headers, deckId, outline);
  const planned = h.services.mapping.map(outline).map((m) => m.decision.layoutId);
  for (const layoutId of planned) {
    h.llm.push({ text: slideResponseFor(requireLayout(layoutId), label) });
  }
  return planned;
}

/** Outline + generate, for the reads that need a populated deck. */
async function generate(h: ReturnType<typeof harness>, deckId: string): Promise<void> {
  await outlineAndScript(h, deckId, ["list", "quote", "list"]);
  const { emit } = recorder();
  const result = await h.facade.generateDeck(h.headers, deckId, { emit });
  // Asserted in the helper: a fallback slide would still populate the deck, so a read test downstream
  // would pass while silently exercising fallback content instead of the clean path.
  expect(result.failed, "helper produced fallback slides — the script is misaligned").toBe(0);
}
