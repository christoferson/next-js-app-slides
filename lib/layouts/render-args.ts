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

/**
 * What this builder needs of a background, as opposed to what the exporter happens to have.
 *
 * The exporter passes a full `ResolvedAsset` (it needs the bytes to embed). The browser preview has no
 * bytes at all — it renders the image via a `url` in a CSS `background-image` — and only ever knows the
 * `luminance` the server sampled at upload.
 *
 * Typing the parameter as the intersection of those two needs is what lets both call the SAME builder
 * without a cast. The alternative was for the preview to assert `as ResolvedAsset` over an object holding
 * one number, which would compile while stating something false — and the next person to add a field here
 * would have no warning that one of the two callers cannot supply it.
 */
export interface BackgroundForRender {
  /** Sampled at upload. Absent means "no information": the tokens are left alone. */
  luminance?: number;
}

export interface RenderArgsInput {
  slots: SlotValues;
  /** Straight from `compileTheme` — this function applies the per-background adjustment. */
  tokens: DesignTokens;
  /** Straight from `resolveZones`. */
  zones: SlotZone[];
  /**
   * Present in Templated mode only. Its `luminance` (sampled at upload) is what drives the adjustment;
   * an asset without one leaves the tokens untouched.
   *
   * Its mere PRESENCE is also what `isTemplated` reads to suppress a layout's own ornaments, so a caller
   * must pass it whenever the slide has a background — even one whose luminance is unknown.
   */
  background?: BackgroundForRender;
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
    //
    // The widening to `ResolvedAsset` is confined to this ONE line, and is safe because of what reads the
    // field: `isTemplated` tests presence, and no `FallbackRenderer` touches the bytes — a React renderer
    // paints the image through CSS, never from a buffer. Only `toPptx` needs bytes, and only the exporter
    // calls that, always with a real asset. Keeping the cast here rather than at each call site means the
    // preview needs none, and this comment is the single place the reasoning has to hold.
    ...(background ? { background: background as ResolvedAsset } : {}),
  };
}
