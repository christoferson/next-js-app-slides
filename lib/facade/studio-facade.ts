/**
 * `StudioFacade` — one coarse method per use-case (CLAUDE.md §2 step 14, SPEC §3/§4.1).
 *
 * ## What this layer is FOR
 *
 * Routes are "zod validate + delegate + stream" (SPEC §4.2). Everything a use-case needs that is not
 * HTTP lives here, and there are three such things:
 *
 *   1. **Authentication is resolved HERE, not in routes.** Every method takes `Headers` and derives its
 *      own `userId`. This is the security-relevant decision in this file: `userId` is the scoping key for
 *      ALL persisted data, and if routes passed it in, then *every* route would be one forgotten line
 *      away from either an unauthenticated read or — far worse — accepting a client-supplied `userId` and
 *      writing into another user's partition. Making the principal unforgeable from outside this layer
 *      means a new route cannot introduce that bug: there is no parameter to get wrong. `Unauthorized`
 *      is raised here (the port returns `null`, per its own note, so the *meaning* of absence is a
 *      caller decision — and this is the caller).
 *   2. **Multi-service orchestration.** A use-case that touches two services belongs here so a route
 *      never sequences business logic. The real instances: `createDeck` validates the brand exists
 *      before creating a deck that references it; `outlineView`/`workspace` compose deck + brand +
 *      mapping into one payload; `switchBrand` re-resolves templates after the swap.
 *   3. **Nothing else.** Where a use-case IS one service call, this file is a one-line delegation and
 *      says so. That is not boilerplate to be optimized away — it is what keeps `app/**` free of
 *      `lib/services/**` (lint-enforced) so the service layer stays swappable and route-free.
 *
 * ## What this layer must NOT do
 *
 * No zod parsing (routes own request shape; services own domain validation), no `Response` objects, no
 * status codes, no SSE framing. `generateDeck` takes an `emit` callback rather than a stream: the facade
 * decides *what* is emitted, the route decides how it is encoded on the wire. That split is what lets the
 * §9 generation matrix be tested without an HTTP server.
 *
 * Per §5 this file may import `lib/services/**` and `lib/errors` only — plus domain/port *types*, which
 * carry no implementation. It holds no state and constructs nothing (§3).
 */

import type { AuthProvider, Principal } from "@/lib/ports/auth-provider";
import type { ExportResult } from "@/lib/ports/exporter";
import type { ReadableAsset } from "@/lib/domain/asset";
import type { AssetKind } from "@/lib/domain/asset";
import type { BrandDefinition, BrandSummary, DesignTokens } from "@/lib/brand/types";
import type { Briefing, DeckMeta, DeckSummary, Outline, Slide } from "@/lib/domain/deck";
import { Unauthorized } from "@/lib/errors/errors";
import type { BrandService, ResolvedTemplate } from "@/lib/services/brand-service";
import type { DeckService, SlidePatch } from "@/lib/services/deck-service";
import type { ExportService } from "@/lib/services/export-service";
import type { GenerateDeckOptions, GenerationService } from "@/lib/services/generation-service";
import type { LayoutMappingService } from "@/lib/services/layout-mapping-service";
import type { OutlineResultView, OutlineService } from "@/lib/services/outline-service";
import type { DeckGenerationResult, SlideOutcome } from "@/lib/generation/pipeline";

/**
 * Exactly `Container.services` plus the auth port.
 *
 * `auth` is the one port the facade holds, because resolving a principal is not business logic — no
 * service needs it, since every service is already `(userId, …)`-keyed. Typed as the interface, so the
 * facade is testable with a stub principal and has no idea whether Cognito or the v1 stub is behind it.
 */
export interface StudioFacadeDeps {
  auth: AuthProvider;
  brands: BrandService;
  decks: DeckService;
  mapping: LayoutMappingService;
  outline: OutlineService;
  generation: GenerationService;
  export: ExportService;
}

/**
 * Upload metadata a route extracts from multipart form data.
 *
 * `contentType` is what the CLIENT declared — a plain string, optional, and deliberately not
 * `AssetMimeType`. A browser derives it from the filename extension, so narrowing it here would mean this
 * layer had vouched for it; `BrandService.addAsset` re-derives the stored type from the bytes themselves
 * and rejects a mismatch (`checkAssetBytes`). Same reasoning for `width`/`height`: they are a fallback for
 * formats whose bytes carry no dimensions, never the source of truth for the letterbox decision.
 */
export interface AssetUpload {
  filename: string;
  contentType?: string;
  kind: AssetKind;
  /** Required for `kind: "background"` — `BrandService.addAsset` enforces that, not this layer. */
  layoutId?: string;
  width?: number;
  height?: number;
}

/** What the workspace screen loads in one request (SPEC §9). */
export interface WorkspaceView {
  deck: DeckMeta;
  slides: Slide[];
  brand: BrandDefinition;
  tokens: DesignTokens;
  /** Resolved per layout the deck actually uses, so the preview can render each slide's zones (§8). */
  templates: ResolvedTemplate[];
  /** Formats this deployment can produce — the download menu (`ExportService.formats`). */
  exportFormats: string[];
}

export class StudioFacade {
  constructor(private readonly deps: StudioFacadeDeps) {}

  /* ─────────────────────────────── principal ─────────────────────────────── */

  /**
   * The caller, or `Unauthorized`.
   *
   * Public because two things legitimately need a principal without performing a use-case: the asset
   * serving route (which then calls `serveAsset`) and any page-level "who am I" read. It returns the
   * whole `Principal` rather than a bare string so a display name is available without a second call.
   */
  async principal(headers: Headers): Promise<Principal> {
    const principal = await this.deps.auth.authenticate(headers);
    if (!principal) throw Unauthorized();
    return principal;
  }

  /** `userId` only — what every method below actually threads into the services. */
  private async userId(headers: Headers): Promise<string> {
    return (await this.principal(headers)).userId;
  }

  /* ─────────────────────────────── brands ─────────────────────────────── */

  async listBrands(headers: Headers): Promise<BrandSummary[]> {
    return this.deps.brands.list(await this.userId(headers));
  }

  async getBrand(headers: Headers, brandId: string): Promise<BrandDefinition> {
    return this.deps.brands.get(await this.userId(headers), brandId);
  }

  /**
   * Brand + compiled tokens — what the brand editor's live preview needs.
   *
   * One call rather than two because the tokens must describe the brand that was read: `compileTheme`
   * runs contrast repair, and a preview showing repaired colours for a *different* revision of the brand
   * is exactly the kind of drift §8 is written to prevent.
   */
  async getBrandTheme(
    headers: Headers, brandId: string,
  ): Promise<{ brand: BrandDefinition; tokens: DesignTokens }> {
    return this.deps.brands.themeFor(await this.userId(headers), brandId);
  }

  /** Zones + background for one layout, through the §8 shared resolver. */
  async resolveTemplate(
    headers: Headers, brandId: string, layoutId: string,
  ): Promise<ResolvedTemplate> {
    return this.deps.brands.resolveTemplate(await this.userId(headers), brandId, layoutId);
  }

  /** `input` is the editable surface; `BrandService` validates it (§12: nothing partially applied). */
  async createBrand(headers: Headers, input: unknown): Promise<BrandDefinition> {
    return this.deps.brands.create(await this.userId(headers), input);
  }

  async updateBrand(headers: Headers, brandId: string, input: unknown): Promise<BrandDefinition> {
    return this.deps.brands.update(await this.userId(headers), brandId, input);
  }

  /**
   * JSON import (SPEC §5, §11 step 3). Distinct from `updateBrand` because it may CREATE — importing
   * without a `brandId` is how a shared config becomes a new brand.
   */
  async importBrand(headers: Headers, input: unknown, brandId?: string): Promise<BrandDefinition> {
    return this.deps.brands.importConfig(await this.userId(headers), input, brandId);
  }

  /** `BrandInUse` (409) while a deck still references it — the §11 step 11 guard. */
  async deleteBrand(headers: Headers, brandId: string): Promise<void> {
    return this.deps.brands.delete(await this.userId(headers), brandId);
  }

  /**
   * Attach an uploaded logo/background.
   *
   * `byteSize` is derived from `data` here rather than taken from the upload: a multipart part can claim
   * any length, and the stored record's size is what the editor displays and what quota logic would key
   * off. The bytes are the only honest source.
   */
  async addBrandAsset(
    headers: Headers, brandId: string, data: Uint8Array, upload: AssetUpload,
  ): Promise<{ assetId: string; brand: BrandDefinition }> {
    return this.deps.brands.addAsset(await this.userId(headers), brandId, data, {
      filename: upload.filename,
      ...(upload.contentType !== undefined ? { contentType: upload.contentType } : {}),
      byteSize: data.byteLength,
      kind: upload.kind,
      ...(upload.layoutId !== undefined ? { layoutId: upload.layoutId } : {}),
      ...(upload.width !== undefined ? { width: upload.width } : {}),
      ...(upload.height !== undefined ? { height: upload.height } : {}),
    });
  }

  async removeBrandAsset(
    headers: Headers, brandId: string, assetId: string,
  ): Promise<BrandDefinition> {
    return this.deps.brands.removeAsset(await this.userId(headers), brandId, assetId);
  }

  /**
   * Serve an asset's bytes (`/api/assets/:id`).
   *
   * The URL carries no userId — see `BrandService.getAssetStream` — so this method's `headers` are the
   * *only* thing scoping the read. An id from another user raises `AssetNotFound` (404), not 403: a
   * distinguishable "exists but forbidden" would let the id space be enumerated.
   */
  async serveAsset(headers: Headers, assetId: string): Promise<ReadableAsset> {
    return this.deps.brands.getAssetStream(await this.userId(headers), assetId);
  }

  /* ─────────────────────────────── decks ─────────────────────────────── */

  async listDecks(headers: Headers): Promise<DeckSummary[]> {
    return this.deps.decks.list(await this.userId(headers));
  }

  /**
   * Create a deck.
   *
   * The brand is read first, and that read is the point: `DeckService` stores whatever `brandId` it is
   * handed, so without this a deck could be created against a brand that does not exist (or belongs to
   * someone else) and would fail later — at outline time, with a confusing `BrandNotFound` on an
   * unrelated action. Failing at creation is `BrandNotFound` (404) on the request that actually named it.
   * This is the multi-service orchestration this layer exists for.
   */
  async createDeck(
    headers: Headers, input: { title: string; brandId: string; briefing?: Briefing },
  ): Promise<DeckMeta> {
    const userId = await this.userId(headers);
    await this.deps.brands.get(userId, input.brandId);
    return this.deps.decks.create(userId, input);
  }

  async getDeck(headers: Headers, deckId: string): Promise<DeckMeta> {
    return this.deps.decks.getMeta(await this.userId(headers), deckId);
  }

  async setDeckTitle(headers: Headers, deckId: string, title: string): Promise<DeckMeta> {
    return this.deps.decks.setTitle(await this.userId(headers), deckId, title);
  }

  async setBriefing(headers: Headers, deckId: string, briefing: Briefing): Promise<DeckMeta> {
    return this.deps.decks.setBriefing(await this.userId(headers), deckId, briefing);
  }

  /**
   * Point the deck at a different brand (§11 step 10: "re-render check; content unchanged").
   *
   * Validates the target brand before the swap, for `createDeck`'s reason, and returns the deck with its
   * templates already re-resolved — the caller's next need is always to re-render, and a swap that
   * returned only the meta would force a second round trip to discover the new zones.
   */
  async switchBrand(
    headers: Headers, deckId: string, brandId: string,
  ): Promise<{ deck: DeckMeta; brand: BrandDefinition; tokens: DesignTokens; templates: ResolvedTemplate[] }> {
    const userId = await this.userId(headers);
    await this.deps.brands.get(userId, brandId);
    const deck = await this.deps.decks.setBrand(userId, deckId, brandId);
    const { brand, tokens } = await this.deps.brands.themeFor(userId, brandId);
    const slides = await this.deps.decks.listSlides(userId, deckId);
    return { deck, brand, tokens, templates: await this.templatesFor(userId, brandId, slides) };
  }

  async deleteDeck(headers: Headers, deckId: string): Promise<void> {
    return this.deps.decks.delete(await this.userId(headers), deckId);
  }

  /* ─────────────────────────────── outline ─────────────────────────────── */

  /**
   * Generate the outline and persist it in the same call (SPEC §7.1).
   *
   * `signal` is threaded through so a client that navigates away stops paying for tokens; the service
   * persists whatever completed.
   */
  async generateOutline(
    headers: Headers,
    deckId: string,
    options: { instruction?: string; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<OutlineResultView> {
    return this.deps.outline.generate(await this.userId(headers), deckId, options);
  }

  /** Regenerate one section in place — the §12 "regenerate a section" seam. */
  async regenerateOutlineSection(
    headers: Headers,
    deckId: string,
    sectionIndex: number,
    options: { instruction?: string; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<OutlineResultView> {
    return this.deps.outline.regenerateSection(
      await this.userId(headers), deckId, sectionIndex, options,
    );
  }

  /**
   * Save user edits (reorder, reword, move between sections).
   *
   * `unknown`, matching `createBrand`/`updateBrand`: the document comes from a request body and
   * `OutlineService.save` parses it (`parseEditedOutline`). A typed parameter here would put the outline's
   * shape in the route's hands, and §4 forbids that second copy.
   */
  async saveOutline(headers: Headers, deckId: string, outline: unknown): Promise<OutlineResultView> {
    return this.deps.outline.save(await this.userId(headers), deckId, outline);
  }

  async setLayoutOverride(
    headers: Headers, deckId: string, sectionIndex: number, slideIndex: number, layoutId: string | null,
  ): Promise<OutlineResultView> {
    return this.deps.outline.setLayoutOverride(
      await this.userId(headers), deckId, sectionIndex, slideIndex, layoutId,
    );
  }

  /**
   * The outline editor's read: plan + advisories + mapping preview.
   *
   * A single service call by design — `OutlineService.view`'s own note explains that fetching the plan
   * and its mapping separately lets a concurrent regenerate land between them, leaving badges that
   * describe slides no longer on screen.
   */
  async outlineView(
    headers: Headers, deckId: string,
  ): Promise<Awaited<ReturnType<OutlineService["view"]>>> {
    return this.deps.outline.view(await this.userId(headers), deckId);
  }

  /* ─────────────────────────────── generation ─────────────────────────────── */

  /**
   * Generate every slide, streaming progress through `options.emit`.
   *
   * The facade takes a callback, not a stream. The route owns SSE framing (`lib/stream/events.ts` is the
   * wire contract) and this layer owns which events occur — so the §9 matrix, including the abort and
   * mid-deck-throttle rows, is testable by collecting events into an array with no HTTP involved.
   *
   * Returns the pipeline's `{ ok, failed, outcomes, aborted }` unchanged, so a route that logs the
   * counts cannot disagree with the `deck-done` the client already received.
   */
  async generateDeck(
    headers: Headers, deckId: string, options: GenerateDeckOptions,
  ): Promise<DeckGenerationResult> {
    return this.deps.generation.generateDeck(await this.userId(headers), deckId, options);
  }

  /** Regenerate one slide in place, keeping its id/order/createdAt (SPEC §7.4). */
  async regenerateSlide(
    headers: Headers, deckId: string, slideId: string, options: GenerateDeckOptions,
  ): Promise<SlideOutcome> {
    return this.deps.generation.regenerateSlide(await this.userId(headers), deckId, slideId, options);
  }

  /* ─────────────────────────────── slides ─────────────────────────────── */

  async getSlide(headers: Headers, deckId: string, slideId: string): Promise<Slide> {
    return this.deps.decks.getSlide(await this.userId(headers), deckId, slideId);
  }

  /** Patch slots / layout / speaker notes. Budget enforcement and flags are `DeckService`'s. */
  async updateSlide(
    headers: Headers, deckId: string, slideId: string, patch: SlidePatch,
  ): Promise<Slide> {
    return this.deps.decks.updateSlide(await this.userId(headers), deckId, slideId, patch);
  }

  async duplicateSlide(headers: Headers, deckId: string, slideId: string): Promise<Slide> {
    return this.deps.decks.duplicateSlide(await this.userId(headers), deckId, slideId);
  }

  async deleteSlide(headers: Headers, deckId: string, slideId: string): Promise<void> {
    return this.deps.decks.deleteSlide(await this.userId(headers), deckId, slideId);
  }

  /** Drag-and-drop reorder; returns the full reordered list so the client re-syncs from one response. */
  async reorderSlides(headers: Headers, deckId: string, orderedIds: string[]): Promise<Slide[]> {
    return this.deps.decks.reorderSlides(await this.userId(headers), deckId, orderedIds);
  }

  /* ─────────────────────────────── workspace + export ─────────────────────────────── */

  /**
   * Everything the workspace screen needs, in one request.
   *
   * Composed here rather than left to the client for the same consistency reason as `outlineView`: the
   * slides, the tokens they are styled with, and the zones they are positioned by must all describe one
   * revision of one brand. Four separate fetches can interleave with a brand edit and produce a preview
   * that matches nothing — and §8's guarantee is that the preview matches the export.
   */
  async workspace(headers: Headers, deckId: string): Promise<WorkspaceView> {
    const userId = await this.userId(headers);
    const { meta, slides } = await this.deps.decks.getFull(userId, deckId);
    const { brand, tokens } = await this.deps.brands.themeFor(userId, meta.brandId);
    return {
      deck: meta,
      slides,
      brand,
      tokens,
      templates: await this.templatesFor(userId, meta.brandId, slides),
      exportFormats: this.deps.export.formats(),
    };
  }

  /** Formats this deployment can produce. Sorted by the service, so the menu order is stable. */
  exportFormats(): string[] {
    return this.deps.export.formats();
  }

  /**
   * Export the deck. The route sets `Content-Disposition` from `ExportResult.filename` (already
   * sanitized by the one shared `exportFilename`) and `Content-Type` from `ExportResult.contentType`.
   */
  async exportDeck(headers: Headers, deckId: string, format: string): Promise<ExportResult> {
    return this.deps.export.export(await this.userId(headers), deckId, format);
  }

  /* ─────────────────────────────── internals ─────────────────────────────── */

  /**
   * Resolve templates for the layouts a deck ACTUALLY uses.
   *
   * Deliberately not every templated layout: `ExportService.buildRequest` narrows the same way, and the
   * two must agree or the preview would show zones for slides the export never renders. Deduped, since a
   * ten-slide deck typically uses three or four layouts.
   */
  private templatesFor(
    userId: string, brandId: string, slides: readonly Slide[],
  ): Promise<ResolvedTemplate[]> {
    const layoutIds = [...new Set(slides.map((s) => s.layoutId))];
    return Promise.all(
      layoutIds.map((layoutId) => this.deps.brands.resolveTemplate(userId, brandId, layoutId)),
    );
  }
}
