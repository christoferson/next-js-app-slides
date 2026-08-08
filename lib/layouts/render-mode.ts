/**
 * Render-mode Strategy resolver (SPEC §6, CLAUDE.md §2 step 8).
 *
 * The whole point is that this decision is made in ONE place, **by data**:
 *   - `Templated` — the brand supplies a background asset for this layout → full-bleed image, slot
 *     content placed in the resolved zones.
 *   - `TokenStyled` — it does not → the layout's own token-styled path.
 *
 * SPEC: *"Selected by data … inside one strategy resolver — never branched at call sites."* Every
 * `if (brand.templates[layoutId])` written elsewhere is a bug: the canvas and the exporter would each
 * carry their own copy of the rule, and they would eventually disagree about the same deck.
 *
 * `resolveZones` lives here too because it is the same decision seen from the other side — the brand
 * template supplies zones or the layout's defaults do — and §8 requires the preview and `toPptx` to
 * share one resolver so the export matches what the user approved.
 */

import type { BrandDefinition, SlotZone } from "@/lib/brand/types";
import type { SlideLayout } from "@/lib/layouts/types";

export type RenderMode = "templated" | "token-styled";

export interface RenderPlan {
  mode: RenderMode;
  /** Set only in `templated` mode; the caller resolves it through `AssetStore`. */
  backgroundAssetId?: string;
  /** Brand template zones when present, else the layout's `defaultZones`. Never empty. */
  zones: SlotZone[];
  /** True when the zones came from the brand rather than the registry — drives "reset to default". */
  zonesCustomized: boolean;
}

/**
 * Zone resolution, SPEC §5: `brand.templates[layoutId].zones` → else `layout.defaultZones`.
 *
 * A brand template **replaces** the defaults wholesale rather than merging per slot. Merging looks
 * friendlier but is worse: a user who deliberately removes a zone would silently get the default
 * back, and the brand editor could then never express "this layout does not show a subtitle".
 * `brand-schema.ts` therefore rejects a template that omits a required slot's zone, which is what
 * makes wholesale replacement safe.
 *
 * Returns a fresh array — a caller must not be able to mutate the registry's `defaultZones`.
 *
 * Both parameters are `Pick`s of what this function actually reads, and that is load-bearing rather than
 * fastidious. The brand editor resolves zones for a DRAFT brand (unsaved, so no `id`/timestamps) against a
 * `LayoutSummary` from `/api/registry/layouts` (which carries `slots` and `defaultZones` but no
 * `FallbackRenderer` or `toPptx`, neither being serializable). Declaring the full `SlideLayout` would force
 * that screen to cast — and a cast at the one call site §8 is written about is exactly where a type lie
 * could later hide a real mismatch.
 */
export function resolveZones(
  brand: Pick<BrandDefinition, "templates"> | undefined,
  layout: Pick<SlideLayout, "id" | "defaultZones">,
): { zones: SlotZone[]; customized: boolean } {
  const template = brand?.templates[layout.id];
  if (template && template.zones.length > 0) {
    return { zones: template.zones.map((z) => ({ ...z })), customized: true };
  }
  return { zones: layout.defaultZones.map((z) => ({ ...z })), customized: false };
}

/**
 * The single strategy decision. Templated requires a background asset — zones alone are not enough,
 * since a brand may customize positions while still wanting the token-styled look.
 */
export function resolveRenderPlan(
  brand: Pick<BrandDefinition, "templates"> | undefined,
  layout: SlideLayout,
): RenderPlan {
  const { zones, customized } = resolveZones(brand, layout);
  const backgroundAssetId = brand?.templates[layout.id]?.backgroundAssetId;

  return backgroundAssetId !== undefined
    ? { mode: "templated", backgroundAssetId, zones, zonesCustomized: customized }
    : { mode: "token-styled", zones, zonesCustomized: customized };
}

/** Zone for one slot, or `undefined` if this layout/brand places nothing there. */
export const zoneFor = (zones: readonly SlotZone[], slotKey: string): SlotZone | undefined =>
  zones.find((z) => z.slotKey === slotKey);

/**
 * Which layouts a brand has templated — the gallery's `BrandSummary.templatedLayoutIds`, computed
 * with the same "background present" rule the resolver uses, so a card cannot claim a template that
 * would not actually render as one.
 */
export const templatedLayoutIds = (brand: Pick<BrandDefinition, "templates">): string[] =>
  Object.entries(brand.templates)
    .filter(([, t]) => t.backgroundAssetId !== undefined)
    .map(([layoutId]) => layoutId)
    .sort();
