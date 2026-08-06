/**
 * CLAUDE.md §2 step 3 — the image-luminance PORT.
 *
 * Sampling an uploaded image's mean luminance needs a raster decoder, which is a native module and
 * server-only. `BrandService` may not import one (§5: services stay IO-free), and `lib/brand` may not
 * either — the brand editor imports it into the client bundle. So the one decode in the app sits behind
 * this interface, implemented in `lib/adapters` where native dependencies are allowed and wired in the
 * factory like every other backend.
 *
 * It exists as a port rather than a util for a second reason: it is the seam a future S3 deployment
 * changes. Sampling is currently done in-process at upload time; a deployment that pushes it to a Lambda
 * or reads a precomputed value off object metadata swaps this implementation and nothing else.
 *
 * ## Why the return is nullable rather than throwing
 *
 * A background whose luminance cannot be determined must still be usable — an undecodable image is a
 * cosmetic unknown, not a failed upload, and the upload has already passed `checkAssetBytes` (which is the
 * check that actually matters for safety). Callers treat `null` as "no information" and fall back to the
 * brand's declared `colors.background`, which is the pre-existing behaviour.
 */

import type { BackgroundLuminance } from "@/lib/brand/background-luminance";

export interface ImageLuminancePort {
  /**
   * Mean alpha-weighted WCAG relative luminance of these bytes, or `null` when they cannot be decoded.
   *
   * `Uint8Array`, not `Buffer`, for the same reason `AssetStore.put` takes one: no Node-only type in a
   * port signature.
   */
  sample(bytes: Uint8Array): Promise<BackgroundLuminance | null>;
}
