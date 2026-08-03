/**
 * `BrandService` — brand CRUD, validation, theme compilation, and asset attachment (SPEC §5).
 *
 * ## What this layer adds over the repository
 *
 * The repository stores whatever it is handed. Everything that makes a stored brand *trustworthy*
 * lives here:
 *
 *   - **Identity is server-assigned.** `id`, `userId`, and `createdAt` are set by this service and
 *     overwritten on every write, never read from the payload. A JSON import round-trips those fields
 *     (§11 step 3 requires export → re-import to be identical), so the payload *does* carry them — and
 *     honouring them would be a straight authorization hole: a crafted `userId` would write into
 *     another user's partition through a port that scopes by the argument, not the body.
 *   - **Validation happens before persistence, with cross-checks.** `validateBrand` needs the layout
 *     registry (do these `slotKey`s exist?) and the user's asset ids (does this background still
 *     exist?). Both are things only this layer can supply, which is why validation cannot live in the
 *     schema module alone.
 *   - **Nothing is partially applied** (§12). An invalid config throws `InvalidBrandConfig` with
 *     field-level issues and writes nothing.
 *
 * ## Why `compileTheme` is exposed here rather than called by consumers
 *
 * A renderer or exporter must never see a `BrandDefinition` — only `DesignTokens` (see
 * `lib/brand/types.ts`). Routing every appearance read through `themeFor` keeps that true, and it means
 * contrast repair happens once per request rather than once per consumer, with the notices surfaced
 * rather than recomputed and dropped.
 */

import type { AssetStore, BrandRepository, DeckRepository } from "@/lib/ports";
import type { AssetMeta, ReadableAsset, ResolvedAsset } from "@/lib/domain/asset";
import { checkAssetBytes } from "@/lib/domain/asset-bytes";
import { imageSize } from "@/lib/layouts/background";
import type { BrandDefinition, BrandSummary, DesignTokens, LayoutTemplate } from "@/lib/brand/types";
import {
  type BrandInput, type LayoutLookup, describeIssues, validateBrand, validateBrandInput,
} from "@/lib/brand/brand-schema";
import { compileTheme } from "@/lib/brand/theme";
import { BrandInUse, BrandNotFound, InvalidBrandConfig } from "@/lib/errors/errors";
import { findLayout } from "@/lib/layouts/registry";
import { resolveRenderPlan, templatedLayoutIds } from "@/lib/layouts/render-mode";

export interface BrandServiceDeps {
  brands: BrandRepository;
  /** Needed for the delete guard (`BrandInUse`) — a referenced brand must not vanish under a deck. */
  decks: DeckRepository;
  assets: AssetStore;
  /** The registry seen through the injected port — `brand-schema.ts` cannot import it (circular). */
  layouts: LayoutLookup;
  now: () => number;
  newId: () => string;
}

/**
 * What an upload may ASSERT about itself, as opposed to what is stored.
 *
 * `contentType` is a plain `string` and optional, not `AssetMimeType`. That is the type system carrying
 * the security decision: a browser derives the multipart content type from a filename extension, so it is
 * a claim to be checked (`checkAssetBytes`), and typing it as the narrow union would mean some caller had
 * already been trusted to narrow it — which is precisely the step that must not happen outside this
 * service. The stored type is this method's return path, never its input.
 *
 * `width`/`height` are likewise a fallback, used only for formats whose bytes carry no dimensions.
 */
export type AssetUploadMeta = Omit<AssetMeta, "createdAt" | "contentType"> & { contentType?: string };

/** Zones + background, resolved for one layout. What the preview and the exporter both consume (§8). */
export interface ResolvedTemplate {
  layoutId: string;
  mode: "templated" | "token-styled";
  zones: LayoutTemplate["zones"];
  zonesCustomized: boolean;
  backgroundAssetId?: string;
}

export class BrandService {
  constructor(private readonly deps: BrandServiceDeps) {}

  /* ─────────────────────────────── reads ─────────────────────────────── */

  /**
   * Absence becomes `BrandNotFound` HERE, not in the repository. The ports return `null` so both impls
   * behave identically (`lib/ports/repositories.ts`); choosing what absence *means* is this layer's
   * call, and it is the same call for every backend.
   */
  async get(userId: string, brandId: string): Promise<BrandDefinition> {
    const brand = await this.deps.brands.get(userId, brandId);
    if (!brand) throw BrandNotFound(brandId);
    return brand;
  }

  list(userId: string): Promise<BrandSummary[]> {
    return this.deps.brands.list(userId);
  }

  /** The only appearance input any renderer or exporter should receive. */
  async themeFor(userId: string, brandId: string): Promise<{ brand: BrandDefinition; tokens: DesignTokens }> {
    const brand = await this.get(userId, brandId);
    return { brand, tokens: compileTheme(brand) };
  }

  /**
   * Read an asset's bytes as a stream, for the `/api/assets/:id` serving route.
   *
   * Both asset stores return `/api/assets/{assetId}` from `resolveUrl` with **no userId in the path** —
   * deliberately, so a serving URL cannot be used to probe another user's partition. That makes the
   * scoping entirely this call's `userId` argument: the route resolves the principal and passes it, and
   * an id belonging to someone else raises `AssetNotFound` from the store rather than 403, so the URL
   * space cannot be enumerated to learn which ids exist.
   *
   * It lives on `BrandService` because assets are brand assets — this is the layer that already owns the
   * `AssetStore` port — and it exists at all because the facade may not touch a port directly (§5). Note
   * it does NOT go through `resolveOrSkip`: a *serving* request for missing bytes is a 404, not something
   * to silently degrade the way a render path does.
   */
  getAssetStream(userId: string, assetId: string): Promise<ReadableAsset> {
    return this.deps.assets.getStream(userId, assetId);
  }

  /**
   * Zone resolution for one layout, through the shared resolver (§8). Routed via the service so the
   * preview endpoint and the exporter cannot each grow their own copy of "brand template or default?".
   */
  async resolveTemplate(userId: string, brandId: string, layoutId: string): Promise<ResolvedTemplate> {
    const brand = await this.get(userId, brandId);
    const layout = findLayout(layoutId);
    // A layout id from a URL is untrusted input, so this is a validation failure, not an internal error.
    if (!layout) {
      throw InvalidBrandConfig([`layoutId: isn't a layout this app knows about`]);
    }
    const plan = resolveRenderPlan(brand, layout);
    return {
      layoutId,
      mode: plan.mode,
      zones: plan.zones,
      zonesCustomized: plan.zonesCustomized,
      ...(plan.backgroundAssetId !== undefined ? { backgroundAssetId: plan.backgroundAssetId } : {}),
    };
  }

  /* ─────────────────────────────── writes ─────────────────────────────── */

  /**
   * Create. `input` is the editable surface only (`brandInputSchema`) — no ids, no timestamps.
   *
   * Defaults come from the schema, not from this method: a brand created with `{}` is a complete,
   * valid, on-brand-by-construction default rather than a half-populated record, and there is exactly
   * one place those defaults live.
   */
  async create(userId: string, input: unknown): Promise<BrandDefinition> {
    const validated = await this.validateInput(userId, input);
    const at = new Date(this.deps.now()).toISOString();
    const brand: BrandDefinition = {
      ...validated,
      id: this.deps.newId(),
      userId,
      createdAt: at,
      updatedAt: at,
    };
    return this.deps.brands.create(userId, brand);
  }

  /**
   * Full replace of the editable surface (the editor and JSON import both submit whole configs).
   *
   * `createdAt` is carried over from the stored brand rather than taken from the payload, and `id`
   * comes from the path — so a body claiming a different brand cannot redirect the write.
   */
  async update(userId: string, brandId: string, input: unknown): Promise<BrandDefinition> {
    const existing = await this.get(userId, brandId);
    const validated = await this.validateInput(userId, input);
    const next: BrandDefinition = {
      ...validated,
      id: existing.id,
      userId,
      createdAt: existing.createdAt,
      updatedAt: new Date(this.deps.now()).toISOString(),
    };
    return this.deps.brands.update(userId, brandId, next);
  }

  /**
   * JSON import (SPEC §5). Accepts a complete exported config — including `id`/timestamps, because a
   * round-tripped export carries them and rejecting them would make export → re-import fail (§11).
   *
   * The ids are still ignored for *targeting*: an import either creates a new brand or replaces the one
   * named in the path. The payload's `id`/`userId` never decide which record is written.
   */
  async importConfig(userId: string, input: unknown, brandId?: string): Promise<BrandDefinition> {
    // Validate as a complete definition so an exported file's extra fields are accepted, then hand the
    // editable subset to the normal create/update path — one write path, one set of guarantees.
    const validation = validateBrand(
      // Fill in whatever the payload lacks so a hand-written import (no ids) validates as a definition.
      this.withPlaceholderIdentity(input),
      { layouts: this.deps.layouts, knownAssetIds: await this.knownAssetIds(userId) },
    );
    if (!validation.ok) throw InvalidBrandConfig(describeIssues(validation.issues));

    const { id: _id, userId: _userId, createdAt: _createdAt, updatedAt: _updatedAt, ...editable } =
      validation.value;
    return brandId === undefined
      ? this.create(userId, editable)
      : this.update(userId, brandId, editable);
  }

  /**
   * Delete, guarded. A brand referenced by any deck cannot be deleted (§11 step 11) — every one of
   * those decks would otherwise render against a brand that no longer exists.
   *
   * The count is read from deck *summaries*, which is why `DeckSummary` carries `brandId`: the
   * alternative is loading every deck's full meta to answer one question.
   */
  async delete(userId: string, brandId: string): Promise<void> {
    await this.get(userId, brandId);   // 404 rather than a silent no-op on an unknown id.

    const decks = await this.deps.decks.list(userId);
    const referencing = decks.filter((d) => d.brandId === brandId);
    if (referencing.length > 0) throw BrandInUse(brandId, referencing.length);

    await this.deps.brands.delete(userId, brandId);
  }

  /* ─────────────────────────────── assets ─────────────────────────────── */

  /**
   * Store an uploaded image and, when it is a layout background, attach it to that layout's template.
   *
   * Attaching here rather than in a second request is deliberate: a background asset that no template
   * references is invisible to the user but still counts against their storage, and the two-step
   * version leaves exactly that garbage behind whenever the second call fails.
   *
   * `layoutId` is checked against the registry BEFORE the bytes are stored — otherwise a typo leaves an
   * orphan asset that nothing will ever clean up.
   *
   * ## Two fields are taken from the BYTES, not from `meta`
   *
   * `contentType` and `width`/`height` are re-derived here, and that is a security boundary rather than
   * tidiness. An upload's declared content type comes from a filename extension, and its dimensions from
   * whatever the client chose to send:
   *
   *   - `checkAssetBytes` decides the stored content type from the file's own signature and rejects
   *     anything outside SPEC §5's allowlist or any SVG carrying active content. `/api/assets/:id` serves
   *     these bytes under the stored type, so a claim honoured here becomes a document the browser
   *     executes in this origin. Placing the check in the service — not the route — is what makes
   *     `lib/domain/asset.ts`'s "SVG is sanitized before it is ever stored" true of *every* caller,
   *     including the fixture script.
   *   - Dimensions drive the letterbox decision (`placeBackground`) and therefore the amber badge (§12).
   *     A client claiming 1920×1080 for a 4:3 image would silently get a stretched export with no
   *     warning. `imageSize` is preferred when the bytes carry readable dimensions, and the declared
   *     values are the fallback for formats where they do not (SVG, which has no intrinsic pixel size —
   *     the exporter already treats a dimensionless asset as full-bleed).
   *
   * The size limit is NOT here: `MAX_ASSET_MB` is config, and it must be applied at the HTTP edge before
   * the body is buffered, which no service can do (see `lib/domain/asset-bytes.ts`'s header).
   */
  async addAsset(
    userId: string,
    brandId: string,
    data: Uint8Array,
    meta: AssetUploadMeta,
  ): Promise<{ assetId: string; brand: BrandDefinition }> {
    const brand = await this.get(userId, brandId);

    if (meta.kind === "background") {
      if (meta.layoutId === undefined) {
        throw InvalidBrandConfig(["layoutId: is required for a background image"]);
      }
      if (!findLayout(meta.layoutId)) {
        throw InvalidBrandConfig(["layoutId: isn't a layout this app knows about"]);
      }
    }

    const contentType = checkAssetBytes(data, meta.contentType);
    const intrinsic = imageSize(data);

    const { assetId } = await this.deps.assets.put(userId, meta.kind, data, {
      ...meta,
      contentType,
      ...(intrinsic ?? {}),
      createdAt: new Date(this.deps.now()).toISOString(),
    });

    // The template's zones are seeded from the layout's `defaultZones` when this is the first
    // customization — §4's registry-seeding rule, and what makes the zone table non-empty on open.
    const templates = meta.kind === "background" && meta.layoutId !== undefined
      ? this.withBackground(brand, meta.layoutId, assetId)
      : brand.templates;
    const logo = meta.kind === "logo" ? { ...brand.logo, light: assetId } : brand.logo;

    const updated = await this.deps.brands.update(userId, brandId, {
      ...brand,
      templates,
      ...(logo !== undefined ? { logo } : {}),
      updatedAt: new Date(this.deps.now()).toISOString(),
    });
    return { assetId, brand: updated };
  }

  /**
   * Detach an asset from the brand and delete the bytes.
   *
   * Detach FIRST. If the delete fails, the brand is merely missing a background (it falls back to
   * token-styled, which renders fine); the other order leaves the brand pointing at bytes that are
   * gone, which `validateBrand`'s asset cross-check then reports as an error on every subsequent save.
   */
  async removeAsset(userId: string, brandId: string, assetId: string): Promise<BrandDefinition> {
    const brand = await this.get(userId, brandId);

    const templates = Object.fromEntries(
      Object.entries(brand.templates).map(([layoutId, template]) => {
        if (template.backgroundAssetId !== assetId) return [layoutId, template];
        const { backgroundAssetId: _dropped, ...rest } = template;
        return [layoutId, rest];
      }),
    );
    const logo = brand.logo
      ? {
        ...(brand.logo.light !== undefined && brand.logo.light !== assetId ? { light: brand.logo.light } : {}),
        ...(brand.logo.dark !== undefined && brand.logo.dark !== assetId ? { dark: brand.logo.dark } : {}),
      }
      : undefined;

    const updated = await this.deps.brands.update(userId, brandId, {
      ...brand,
      templates,
      ...(logo && Object.keys(logo).length > 0 ? { logo } : { logo: undefined }),
      updatedAt: new Date(this.deps.now()).toISOString(),
    });
    await this.deps.assets.delete(userId, assetId);
    return updated;
  }

  /**
   * Resolve this brand's backgrounds for a set of layouts, plus its logos — exactly `ExportRequest`'s
   * `backgroundsByLayoutId` / `logos` shape (`lib/ports/exporter.ts`).
   *
   * Two decisions the exporter depends on:
   *
   *   - **Deduplicated by asset id.** §1.1/C3 measured that pptxgenjs does NOT deduplicate identical
   *     media (611 KB / 15 parts → 146 KB / 1 part in the probe). Several layouts commonly share one
   *     background, so resolving the bytes once per *asset* rather than once per *layout* is what makes
   *     the one-master-per-distinct-background optimization possible at all.
   *   - **A missing asset is skipped, not fatal.** The layout then exports token-styled, which is a
   *     complete slide. Failing the whole export because one background's bytes went missing would
   *     turn a cosmetic problem into no deck at all.
   */
  async resolveRenderAssets(
    userId: string, brand: BrandDefinition, layoutIds: readonly string[],
  ): Promise<{ backgroundsByLayoutId: Record<string, ResolvedAsset>; logos?: { light?: ResolvedAsset; dark?: ResolvedAsset } }> {
    const wanted = new Map<string, string[]>();   // assetId → layoutIds using it
    for (const layoutId of new Set(layoutIds)) {
      const assetId = brand.templates[layoutId]?.backgroundAssetId;
      if (assetId === undefined) continue;
      wanted.set(assetId, [...(wanted.get(assetId) ?? []), layoutId]);
    }

    const backgroundsByLayoutId: Record<string, ResolvedAsset> = {};
    await Promise.all([...wanted].map(async ([assetId, forLayouts]) => {
      const resolved = await this.resolveOrSkip(userId, assetId);
      if (!resolved) return;
      // The SAME object for every layout sharing this asset — object identity is how the exporter
      // recognises the distinct set without comparing bytes.
      for (const layoutId of forLayouts) backgroundsByLayoutId[layoutId] = resolved;
    }));

    const [light, dark] = await Promise.all([
      brand.logo?.light !== undefined ? this.resolveOrSkip(userId, brand.logo.light) : undefined,
      brand.logo?.dark !== undefined ? this.resolveOrSkip(userId, brand.logo.dark) : undefined,
    ]);
    const logos = {
      ...(light ? { light } : {}),
      ...(dark ? { dark } : {}),
    };

    return {
      backgroundsByLayoutId,
      ...(Object.keys(logos).length > 0 ? { logos } : {}),
    };
  }

  /* ─────────────────────────────── internals ─────────────────────────────── */

  /**
   * Resolve one asset with bytes, or `undefined` if it is gone.
   *
   * Swallowing the error is the point, and it is narrow: this is only ever called for an id the brand
   * already references, so "absent" means the bytes were deleted out from under a valid config — the
   * `AssetNotFound` case the caller has a good answer for (skip it, render token-styled).
   */
  private async resolveOrSkip(userId: string, assetId: string): Promise<ResolvedAsset | undefined> {
    try {
      return await this.deps.assets.resolve(userId, assetId, { withBytes: true });
    } catch {
      return undefined;
    }
  }

  /**
   * Validate the editable surface with both cross-checks wired. Throws rather than returning a result:
   * every caller here is a write path, and a write path has nothing useful to do with issues except
   * refuse — the *editor* gets field-level issues through the route's schema, before it reaches here.
   */
  private async validateInput(userId: string, input: unknown): Promise<BrandInput> {
    const validation = validateBrandInput(input, {
      layouts: this.deps.layouts,
      knownAssetIds: await this.knownAssetIds(userId),
    });
    if (!validation.ok) throw InvalidBrandConfig(describeIssues(validation.issues));
    return validation.value;
  }

  /**
   * The asset ids `validateBrand` cross-checks against.
   *
   * Built from the *other* brands' references plus this user's stored assets. An empty set would be
   * wrong in a specific way: it makes every background reference look dangling, so an update that
   * touches nothing but the brand name would fail validation.
   */
  private async knownAssetIds(userId: string): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    for (const summary of await this.deps.brands.list(userId)) {
      for (const role of ["light", "dark"] as const) {
        const id = summary.logo?.[role];
        if (id !== undefined) ids.add(id);
      }
      // Summaries carry templated layout ids but not the asset ids behind them, so the full config is
      // needed for backgrounds. Only for brands that actually have templates.
      if (summary.templatedLayoutIds.length > 0) {
        const full = await this.deps.brands.get(userId, summary.id);
        for (const template of Object.values(full?.templates ?? {})) {
          if (template.backgroundAssetId !== undefined) ids.add(template.backgroundAssetId);
        }
      }
    }
    return ids;
  }

  /** Seed a template from the layout's `defaultZones` on first customization (§4). */
  private withBackground(
    brand: BrandDefinition, layoutId: string, assetId: string,
  ): Record<string, LayoutTemplate> {
    const existing = brand.templates[layoutId];
    const zones = existing && existing.zones.length > 0
      ? existing.zones
      : (findLayout(layoutId)?.defaultZones ?? []).map((z) => ({ ...z }));
    return { ...brand.templates, [layoutId]: { backgroundAssetId: assetId, zones } };
  }

  /**
   * Let a hand-written import (no `id`/timestamps) validate as a complete definition. The values are
   * discarded immediately afterwards — see `importConfig`.
   */
  private withPlaceholderIdentity(input: unknown): unknown {
    if (typeof input !== "object" || input === null) return input;
    const at = new Date(this.deps.now()).toISOString();
    return {
      id: "imported",
      userId: "imported",
      createdAt: at,
      updatedAt: at,
      ...input,
    };
  }
}

/** `BrandSummary.templatedLayoutIds` uses the same rule the resolver does — see `render-mode.ts`. */
export { templatedLayoutIds };
