/**
 * `PptxExporter` — the §2 step 13 implementation of the `Exporter` port (SPEC §12).
 *
 * This is the ONE file in the app that imports pptxgenjs. Everything above it — layouts, the painter,
 * the services — talks to the narrow `PptxTarget` interface (`lib/layouts/types.ts`), which is what
 * keeps `lib/layouts` importable from the brand editor and keeps §5's boundary lint free of per-file
 * exemptions.
 *
 * ## Written around the five §1.1 constraints, not against them
 *
 * Every one of these was measured, not assumed (`VERIFICATION.md` §1.1):
 *
 *  - **C1** `fit:'shrink'` never shrinks, and its mere presence flips overflow from spill to clip in
 *    LibreOffice. Truncation is `validate.ts`'s job and `fit` is pinned to `'none'` in `pptx-text.ts`.
 *    Nothing here re-opens that.
 *  - **C2** native `sizing:{contain|cover}` derives its aspect from the DECLARED box, so it distorts
 *    and can emit negative `<a:srcRect>`. `placeBackground` computes explicit geometry instead;
 *    `PptxImageOptions.sizing` is typed `never` so it cannot come back.
 *  - **C3** pptxgenjs does NOT deduplicate identical media (611 KB / 15 parts → 146 KB / 1 part in the
 *    probe). Hence `masterFor`: one `defineSlideMaster` per *distinct* background, keyed on the
 *    OBJECT IDENTITY that `BrandService.resolveRenderAssets` deliberately preserves. A master
 *    background always stretches, though, so a non-16:9 asset falls back to a slide-level `addImage`
 *    — forfeiting dedup for that one asset rather than distorting it.
 *  - **C4** the library validates nothing: a missing image throws at `write()`, an out-of-slide box is
 *    written as given. So a background with no bytes is skipped (the slide renders token-styled, which
 *    is a complete slide) rather than being handed over to fail the whole export.
 *  - **C5** a shape-level `align` collapses bullet runs into one paragraph unless every item carries
 *    `breakLine`. `bulletRuns` stamps it; `assertBulletParagraphs` below is the export-time backstop
 *    that fires even if a future layout bypasses the shared helper.
 *
 * ## Why the C5 backstop is a boundary check rather than a re-count
 *
 * The adapter is the last code the runs pass through before serialization, so it can assert the exact
 * condition C5 turns on: *of the runs in this text box that carry a bullet, all of them must carry
 * `breakLine`*. `scripts/verify-pptx-paragraphs.ts` confirmed that equivalence directly — 3 bullet
 * runs with `breakLine` serialize as 3 `<a:p>`, the same 3 without it as 1 (with the other two items'
 * text silently merged into the first paragraph).
 *
 * A count comparison against `paintPptx`'s `listParagraphs` was the original plan, but `toPptx`
 * returns `void`, so every layout discards that value — and deriving the expected count here from
 * `slots` instead would be wrong for `stats`, whose list slots render as card text rather than
 * bullets. The boundary check needs no per-layout knowledge and is strictly stronger for the actual
 * defect. `tests/pptx-exporter.test.ts` additionally asserts the *serialized* paragraph counts across
 * all eight seed layouts, which is the proof CLAUDE.md §1.1 asked for.
 */

import pptxgen from "pptxgenjs";
import type { ResolvedAsset } from "@/lib/domain/asset";
import type { Slide } from "@/lib/domain/deck";
import type { DesignTokens } from "@/lib/brand/types";
import type { ExportRequest, ExportResult, Exporter } from "@/lib/ports/exporter";
import type {
  PptxImageOptions, PptxShapeOptions, PptxTarget, PptxTextOptions, PptxTextRun, SlideLayout,
} from "@/lib/layouts/types";
import { UnknownLayout } from "@/lib/errors/errors";
import { canUseAsMaster, imageSize, placeBackground } from "@/lib/layouts/background";
import { assertParagraphCount } from "@/lib/layouts/pptx-text";
import { findLayout, LAYOUTS } from "@/lib/layouts/registry";
import { buildRenderArgs } from "@/lib/layouts/render-args";
import { resolveZones } from "@/lib/layouts/render-mode";
import { SLIDE_16x9, zoneToInches } from "@/lib/layouts/zone-math";
import { relativeLuminance, parseHex } from "@/lib/brand/contrast";
import { exportFilename } from "@/lib/util/filename";

/** OOXML's own content type for a .pptx package — what the download route sets. */
export const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Where a logo goes, in slide percent, when the deck is token-styled.
 *
 * Exported as a constant precisely because §8 requires the preview to place it identically: the
 * browser twin (step 16) must consume THIS, not a hand-copied pair of numbers. Height is fixed and
 * width derives from the image's intrinsic aspect, so the logo is never distorted (C2's lesson applied
 * to a second image).
 */
export const LOGO_BOX = { right: 6, bottom: 6, heightPct: 9 } as const;

/** Fallback aspect when the bytes carry no readable dimensions (SVG) — square, and documented. */
const DEFAULT_LOGO_ASPECT = 1;

export class PptxExporter implements Exporter {
  readonly format = "pptx";

  async export(request: ExportRequest): Promise<ExportResult> {
    const pptx = new pptxgen();
    pptx.defineLayout(SLIDE_16x9);
    pptx.layout = SLIDE_16x9.name;

    // Document properties, so the file does not open as "PowerPoint Presentation" in a recent-files
    // list. `title` is the deck's, not the brand's — the brand is the look, the deck is the document.
    //
    // Verified where each of these lands, rather than assumed: `title`/`subject`/`author` become
    // `dc:title`/`dc:subject`/`dc:creator` in `docProps/core.xml`, and `company` becomes `Company` in
    // `docProps/app.xml`. Without `author`, pptxgenjs credits itself as the creator.
    pptx.title = request.deck.title;
    pptx.company = request.brand.name;
    pptx.author = request.brand.name;
    pptx.subject = request.deck.briefing?.topic ?? request.deck.title;

    const masters = new MasterRegistry(pptx);

    // Slides in stored order. `ExportService` already sorts, but an exporter that depended on its
    // caller's ordering would silently reorder a deck the day someone hands it a raw repository list.
    const ordered = [...request.slides].sort((a, b) => a.order - b.order);

    for (const [index, slide] of ordered.entries()) {
      this.addSlide(pptx, masters, request, slide, index);
    }

    // `nodebuffer` verified on the pinned 4.0.1 in §1.1 — the API name has moved across versions, so
    // this is a checked fact rather than an assumption.
    const buffer = await pptx.write({ outputType: "nodebuffer" });

    return {
      bytes: toBytes(buffer),
      contentType: PPTX_CONTENT_TYPE,
      filename: exportFilename(request.deck, "pptx"),
    };
  }

  /* ─────────────────────────────── one slide ─────────────────────────────── */

  private addSlide(
    pptx: pptxgen, masters: MasterRegistry, request: ExportRequest, slide: Slide, index: number,
  ): void {
    const layout = layoutOf(slide.layoutId);
    const { tokens } = request;

    // Hard own-property lookup: `layoutId` reaches here from stored data, and `backgrounds["toString"]`
    // under a bare index would resolve to a function off the prototype chain and be treated as an
    // asset. Same hole `ExportService.export` closes for formats.
    const background = usableBackground(request.backgroundsByLayoutId, slide.layoutId);

    // THE strategy decision, made by data in one place (`resolveRenderPlan`'s rule): a background
    // asset present ⇒ Templated. The exporter does not re-derive it from `brand.templates` — a second
    // copy of that rule is how the canvas and the export end up disagreeing about the same deck.
    const master = background ? masters.masterFor(background) : undefined;

    const target = pptx.addSlide(master !== undefined ? { masterName: master } : {});

    if (master === undefined) {
      // Token-styled, OR templated with a non-16:9 asset. The solid colour goes down first either
      // way: it is the backdrop the letterbox bars show, and it is what `placeBackground` centres in.
      target.background = { color: tokens.colors.background };
      if (background) placeAtSlideLevel(target, background);
    }

    const zones = resolveZones(request.brand, layout).zones;
    const adapter = new SlideTarget(target, `slide ${index + 1} (${layout.id})`);

    // Through `buildRenderArgs`, never assembled inline — it is what applies the background-luminance
    // adjustment to `pairs.onBackground`, and the preview builds its args the same way. A second
    // construction site here would reintroduce dark-text-on-a-dark-background for the export alone,
    // which is the §8 divergence class exactly.
    layout.toPptx(adapter, buildRenderArgs({
      slots: slide.slots,
      tokens,
      zones,
      ...(background ? { background } : {}),
    }));

    // Logos are suppressed in Templated mode for the same reason accent rules are: a brand background
    // almost always contains the logo already, and stamping a second one on top is exactly the
    // off-brand-by-accident outcome the template system exists to prevent (see `title.tsx`).
    if (!background) placeLogo(adapter, request, tokens);

    if (slide.speakerNotes !== undefined && slide.speakerNotes.trim() !== "") {
      adapter.addNotes(slide.speakerNotes);
    }
  }
}

/* ─────────────────────────────── the PptxTarget adapter ─────────────────────────────── */

/**
 * The only place a `PptxTarget` call becomes a pptxgenjs call.
 *
 * It exists to keep pptxgenjs out of `lib/layouts`, and it earns its keep a second time by being the
 * chokepoint where C5 can be enforced regardless of which layout wrote the runs.
 */
class SlideTarget implements PptxTarget {
  constructor(
    private readonly slide: pptxgen.Slide,
    /** Names the slide in an assertion message. Never contains slot content. */
    private readonly context: string,
  ) {}

  addText(runs: PptxTextRun[], options: PptxTextOptions): void {
    assertBulletParagraphs(this.context, runs, options);
    this.slide.addText(runs, options);
  }

  addImage(options: PptxImageOptions): void {
    this.slide.addImage(options);
  }

  addShape(shape: "rect" | "line", options: PptxShapeOptions): void {
    this.slide.addShape(shape, options);
  }

  addNotes(text: string): void {
    this.slide.addNotes(text);
  }
}

/**
 * §1.1/C5's export-time backstop.
 *
 * Of the runs carrying a bullet, every one must also carry `breakLine`; otherwise pptxgenjs's
 * `if (align) … else if (bullet) …` grouping puts them all in ONE paragraph and items 2..n lose their
 * bullet, their numbering, and their indent — while their text is still present, so the deck opens
 * looking populated. Verified both directions in `scripts/verify-pptx-paragraphs.ts`.
 *
 * A throw is right here even though this layer otherwise degrades gracefully: this is an authoring
 * bug in our own layout code, not hostile input, and the alternative is shipping the user a deck whose
 * lists have silently run together.
 */
function assertBulletParagraphs(
  context: string, runs: readonly PptxTextRun[], options: PptxTextOptions,
): void {
  const bulleted = runs.filter((run) => run.options?.bullet !== undefined && run.options.bullet !== false);
  if (bulleted.length === 0) return;

  const withBreak = bulleted.filter((run) => run.options?.breakLine === true);
  assertParagraphCount(
    `${context} text box at x:${options.x.toFixed(2)}in y:${options.y.toFixed(2)}in`,
    bulleted.length,
    withBreak.length,
  );
}

/* ─────────────────────────────── backgrounds (C3) ─────────────────────────────── */

/**
 * One `defineSlideMaster` per DISTINCT background.
 *
 * Keyed by object identity, which is not an optimization detail but the contract
 * `BrandService.resolveRenderAssets` upholds on purpose: it hands the SAME `ResolvedAsset` object to
 * every layout sharing an asset, so the distinct set is knowable without comparing bytes.
 * `tests/export-service.test.ts` asserts that identity with `toBe`, precisely so this map works.
 */
class MasterRegistry {
  private readonly names = new Map<ResolvedAsset, string>();

  constructor(private readonly pptx: pptxgen) {}

  /** A master name for this asset, or `undefined` if it must be placed at slide level instead. */
  masterFor(asset: ResolvedAsset): string | undefined {
    const existing = this.names.get(asset);
    if (existing !== undefined) return existing;

    // A master background always stretches to the slide (`<a:stretch><a:fillRect/>`, no `srcRect` —
    // probe N). A non-16:9 asset would therefore be distorted, so it gives up dedup instead.
    if (!fitsSlide(asset)) return undefined;

    const name = `bg-${this.names.size + 1}`;
    // Base64, not a path: `AssetStore` never returns a filesystem path (§6.4), and probe M confirmed a
    // `data:`-style master background works and still produces exactly one media part.
    this.pptx.defineSlideMaster({ title: name, background: { data: dataUri(asset) } });
    this.names.set(asset, name);
    return name;
  }
}

/**
 * A full-bleed-or-letterboxed image at slide level — the non-16:9 fallback.
 *
 * `placeBackground` computes explicit geometry (C2); `contain` is the documented §8 choice, so a 4:3
 * brand image is pillarboxed against the token background rather than stretched. The `letterboxed`
 * flag it returns already drives the brand editor's amber badge, so the user was warned before export.
 */
function placeAtSlideLevel(slide: pptxgen.Slide, asset: ResolvedAsset): void {
  const size = intrinsicSize(asset);
  const box = size
    ? placeBackground(size, SLIDE_16x9, "contain")
    // No readable dimensions (SVG): there is nothing to letterbox against, so full-bleed is the only
    // honest placement — `background.ts` documents exactly this fallback for its `null` return.
    : { x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height };

  slide.addImage({ data: dataUri(asset), x: box.x, y: box.y, w: box.w, h: box.h });
}

/**
 * A background that can actually be embedded, or `undefined`.
 *
 * C4: pptxgenjs validates nothing, so an asset with no bytes throws at `write()` — i.e. the whole
 * export fails at the very end. Skipping it degrades that slide to token-styled, which is a complete
 * slide, and matches `resolveRenderAssets`' own decision to skip an asset whose bytes went missing.
 */
function usableBackground(
  backgrounds: Record<string, ResolvedAsset>, layoutId: string,
): ResolvedAsset | undefined {
  if (!Object.hasOwn(backgrounds, layoutId)) return undefined;
  const asset = backgrounds[layoutId];
  return asset?.bytes !== undefined && asset.bytes.byteLength > 0 ? asset : undefined;
}

/**
 * Intrinsic pixels: the stored metadata first, then the bytes themselves.
 *
 * Both paths matter. The metadata is authoritative when present, but an upload that predates
 * dimension capture — or an `AssetStore` that does not populate it — would otherwise silently take
 * the "unknown size" branch and full-bleed a 4:3 image.
 */
function intrinsicSize(asset: ResolvedAsset): { width: number; height: number } | null {
  if (asset.width !== undefined && asset.height !== undefined
      && asset.width > 0 && asset.height > 0) {
    return { width: asset.width, height: asset.height };
  }
  return asset.bytes ? imageSize(asset.bytes) : null;
}

/** Unknown dimensions ⇒ treat as full-bleed, which is what a master background does anyway. */
const fitsSlide = (asset: ResolvedAsset): boolean => {
  const size = intrinsicSize(asset);
  return size === null || canUseAsMaster(size, SLIDE_16x9);
};

/** pptxgenjs's `data` form, verified in probe M: `image/png;base64,…` (no `data:` prefix). */
function dataUri(asset: ResolvedAsset): string {
  return `${asset.contentType};base64,${Buffer.from(asset.bytes ?? new Uint8Array()).toString("base64")}`;
}

/* ─────────────────────────────── logo ─────────────────────────────── */

/**
 * Bottom-right logo on token-styled slides (SPEC §13: "brand fonts/colors, logo").
 *
 * The variant is chosen by the background's luminance rather than by a user setting: the light logo is
 * the one designed to sit on a dark surface, and the whole point of `compileTheme`'s contrast work is
 * that legibility is computed, not guessed. When a brand supplies only one variant, that one is used —
 * a logo in the wrong variant is a visible imperfection; a missing logo reads as a broken export.
 */
function placeLogo(target: PptxTarget, request: ExportRequest, tokens: DesignTokens): void {
  const logo = pickLogo(request.logos, tokens.colors.background);
  if (!logo || logo.bytes === undefined || logo.bytes.byteLength === 0) return;

  const size = intrinsicSize(logo);
  const aspect = size ? size.width / size.height : DEFAULT_LOGO_ASPECT;
  const h = (LOGO_BOX.heightPct / 100) * SLIDE_16x9.height;
  const w = h * aspect;

  target.addImage({
    data: dataUri(logo),
    // From the bottom-right corner in, so the inset reads the same at any slide size.
    x: SLIDE_16x9.width - (LOGO_BOX.right / 100) * SLIDE_16x9.width - w,
    y: SLIDE_16x9.height - (LOGO_BOX.bottom / 100) * SLIDE_16x9.height - h,
    w,
    h,
  });
}

/** Light logo on a dark background, dark on light; whichever exists when only one does. */
export function pickLogo(
  logos: ExportRequest["logos"], backgroundHex: string,
): ResolvedAsset | undefined {
  if (!logos) return undefined;
  const rgb = parseHex(backgroundHex);
  // 0.5 is the midpoint of `relativeLuminance`'s own scale, not a tuned constant. An unparseable
  // colour cannot happen downstream of `compileTheme`, but defaulting to `light` if it did keeps the
  // brighter mark on what would then be an unknown surface.
  const dark = rgb === null || relativeLuminance(rgb) < 0.5;
  return (dark ? logos.light ?? logos.dark : logos.dark ?? logos.light) ?? undefined;
}

/* ─────────────────────────────── small helpers ─────────────────────────────── */

/**
 * A stored `layoutId` that is not in the registry.
 *
 * `UnknownLayout` rather than the registry's own `requireLayout` throw: this is reachable by exporting
 * a deck whose slides were written when a layout existed and is now gone, and a 400 naming the known
 * layouts is a readable answer where an internal 500 is not.
 */
function layoutOf(layoutId: string): SlideLayout {
  const layout = findLayout(layoutId);
  if (!layout) throw UnknownLayout(layoutId, LAYOUTS.map((l) => l.id));
  return layout;
}

/**
 * `write()` is typed `string | ArrayBuffer | Blob | Uint8Array`; `outputType: 'nodebuffer'` yields a
 * Buffer, which IS a `Uint8Array`. Narrowed by check rather than by cast so a future version returning
 * something else fails loudly here instead of producing a corrupt download.
 */
function toBytes(output: string | ArrayBuffer | Blob | Uint8Array): Uint8Array {
  if (output instanceof Uint8Array) return output;
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  throw new Error(
    `pptxgenjs write({outputType:'nodebuffer'}) returned ${typeof output}, not a buffer — `
    + "the API has changed and §1.1's verification no longer holds.",
  );
}

/** Re-exported so `zoneToInches`' role in this file is greppable from the §8 side. */
export { zoneToInches };
