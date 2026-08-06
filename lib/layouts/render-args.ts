/**
 * The ONE way to build a `RenderArgs` — §8's shared-consumer rule applied to the whole render input.
 *
 * `resolveZones` already guarantees the preview and the exporter agree on *geometry*, and `SlotPaint`
 * that they agree on *which token* each slot paints with. This closes the third gap: they must also
 * agree on what those tokens ARE, once the background behind the text is known.
 *
 * ## Why a builder rather than each consumer assembling the object
 *
 * `RenderArgs` is a plain interface, so the exporter and the preview each construct one — and the
 * background-luminance adjustment (`lib/brand/background-luminance.ts`) has to be applied to `tokens`
 * before a layout ever sees them, because layouts read `args.tokens` directly and several
 * (`stats`, `quote`) bypass `paintPreview`/`paintPptx` entirely. An adjustment applied inside the
 * painters would therefore be silently skipped by exactly the layouts that build their own boxes.
 *
 * Applying it here instead means a layout cannot opt out, cannot forget, and needs no change at all: by
 * the time `toPptx` or a `FallbackRenderer` runs, `args.tokens.pairs.onBackground.fg` is already the
 * colour that is legible over *this slide's* background. That is the same construction `paint.tsx` uses
 * for `SlotPaint` — make the correct thing the only reachable thing, rather than a rule to remember.
 *
 * Both consumers MUST route through this. A second construction site that skips it reintroduces the
 * §2-step-15 defect for its own renderer only, which is the §8 divergence class in its purest form.
 */

import { tokensForBackground } from "@/lib/brand/background-luminance";
import type { DesignTokens, SlotZone } from "@/lib/brand/types";
import type { ResolvedAsset } from "@/lib/domain/asset";
import type { SlotValues } from "@/lib/domain/slots";
import type { RenderArgs } from "@/lib/layouts/types";

export interface RenderArgsInput {
  slots: SlotValues;
  /** Straight from `compileTheme` — this function applies the per-background adjustment. */
  tokens: DesignTokens;
  /** Straight from `resolveZones`. */
  zones: SlotZone[];
  /**
   * Present in Templated mode only. Its `luminance` (sampled at upload) is what drives the adjustment;
   * an asset without one leaves the tokens untouched.
   */
  background?: ResolvedAsset;
}

/**
 * Assemble the render input, adjusting `pairs.onBackground` for the background image's luminance.
 *
 * `tokensForBackground` returns the SAME tokens object when there is nothing to adjust — no background, no
 * sampled luminance, or an image whose luminance agrees with `colors.background` — so a token-styled slide
 * pays nothing and its `tokens` stay referentially identical to the compiled ones.
 */
export function buildRenderArgs(input: RenderArgsInput): RenderArgs {
  const { slots, tokens, zones, background } = input;
  return {
    slots,
    zones,
    tokens: tokensForBackground(
      tokens,
      background?.luminance !== undefined ? { mean: background.luminance } : undefined,
    ),
    // Presence is what `isTemplated` reads to suppress a layout's own ornaments, so it is preserved
    // exactly — including for the non-16:9 fallback, which still carries the brand's imagery.
    ...(background ? { background } : {}),
  };
}
