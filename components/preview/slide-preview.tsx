/**
 * One slide, rendered in the browser — the §8 twin of `PptxExporter.addSlide`.
 *
 * ## Why this file is so thin
 *
 * Every decision it could get wrong was moved somewhere shared before step 16 began:
 *
 *  - **Geometry** — `resolveZones` decides brand-template-or-default; `zoneToCssPercent` converts. The
 *    exporter calls the same resolver and `zoneToInches`, from the same percentages.
 *  - **Slot painting** — the layout's own `FallbackRenderer`, built from its `SlotPaint[]` declaration, is
 *    the same data `toPptx` consumes (`lib/layouts/paint.tsx`).
 *  - **Text colour over a background image** — `buildRenderArgs`, which applies the luminance adjustment.
 *
 * So this component composes; it does not decide. Anything it decided independently would be a §8
 * divergence waiting to happen, which is why there is no geometry math and no colour logic below.
 *
 * ## The one thing it must not do
 *
 * Build `RenderArgs` by hand. The exporter routes through `buildRenderArgs` and so must this: it is what
 * adjusts `pairs.onBackground` for a dark background image, and a preview that skipped it would show a user
 * dark-on-dark text for a deck that exports correctly — the defect recorded in VERIFICATION.md, in reverse.
 */

"use client";

import { useMemo } from "react";
import type { DesignTokens } from "@/lib/brand/types";
import type { SlotValues } from "@/lib/domain/slots";
import { buildRenderArgs } from "@/lib/layouts/render-args";
import { findLayout } from "@/lib/layouts/registry";
import { resolveZones } from "@/lib/layouts/render-mode";
import { SlideFrame } from "@/lib/layouts/preview";
import type { BrandDefinition } from "@/lib/brand/types";

export interface SlidePreviewProps {
  /**
   * Only the templates, which is all `resolveZones` reads.
   *
   * Narrowed deliberately: the brand editor previews an UNSAVED draft — that is what makes a zone edit
   * appear immediately (§12) — and a draft has no `id`, `userId`, or timestamps. Asking for the full
   * definition would force that screen to cast a draft into one, putting a type lie at the exact call
   * site §8 is written about. It also documents the real contract: appearance comes from `tokens`, never
   * from the brand (`lib/brand/types.ts`).
   */
  brand: Pick<BrandDefinition, "templates">;
  tokens: DesignTokens;
  layoutId: string;
  slots: SlotValues;
  /**
   * Templated mode. `url` comes from `api.assetUrl(assetId)`; `luminance` is the value sampled at upload and
   * carried through `ResolvedTemplate.backgroundLuminance` — the preview cannot compute it (that needs a
   * native decoder) so it must be handed down.
   */
  background?: { url: string; luminance?: number; contain?: boolean };
}

export function SlidePreview({ brand, tokens, layoutId, slots, background }: SlidePreviewProps) {
  const layout = findLayout(layoutId);

  const args = useMemo(() => {
    if (!layout) return undefined;
    return buildRenderArgs({
      slots,
      tokens,
      zones: resolveZones(brand, layout).zones,
      // Passed as a `BackgroundForRender` — the builder needs only presence (to suppress a layout's own
      // ornaments, matching the exporter) and `luminance`. No cast: the preview genuinely has no bytes.
      ...(background
        ? { background: background.luminance !== undefined ? { luminance: background.luminance } : {} }
        : {}),
    });
  }, [brand, layout, slots, tokens, background]);

  // An unknown layout id is reachable from stored data (a deck written when a layout existed, now removed),
  // so it renders as a readable placeholder rather than an empty box or a thrown error — the same call
  // `PptxExporter` makes with `UnknownLayout`, at UI severity.
  if (!layout || !args) {
    return (
      <div
        className="flex aspect-video w-full items-center justify-center rounded border border-line bg-surface p-4 text-center text-sm text-ink-soft"
        role="img"
        aria-label={`Slide cannot be previewed: unknown layout ${layoutId}`}
      >
        This slide uses a layout this version of the app does not know about
        <br />
        <code className="text-xs">{layoutId}</code>
      </div>
    );
  }

  const Renderer = layout.FallbackRenderer;

  return (
    <SlideFrame
      tokens={args.tokens}
      {...(background
        ? { background: { url: background.url, ...(background.contain !== undefined ? { contain: background.contain } : {}) } }
        : {})}
    >
      <Renderer {...args} />
    </SlideFrame>
  );
}
