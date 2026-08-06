/**
 * `ImageLuminancePort` over `sharp` — the one raster decode in the app.
 *
 * ## Why sharp and not `@napi-rs/canvas` (CLAUDE.md §0.1, §14)
 *
 * The first implementation of this port used `@napi-rs/canvas`. It was replaced for two reasons, both
 * found by probing rather than review, and either one alone is disqualifying:
 *
 *   1. **`loadImage` SEGFAULTS on a short buffer — it does not throw.** A `try/catch` cannot contain a
 *      native memory fault, so the whole Node process dies. The trigger is length, not structure:
 *      **≤40 bytes crashes, ≥41 survives**. That boundary is the PNG signature (8) plus a complete IHDR
 *      chunk (25) = 33 bytes, after which the decoder reads the *next* chunk's 8-byte length+type header
 *      without bounds-checking it. Confirmed from both directions: a 24-byte body with a genuine IEND
 *      appended (36 bytes total, structurally terminated) still crashed, while 32+IEND (44 bytes) decoded
 *      fine. A structural or header-parse guard would therefore NOT have closed it — only a length check
 *      would have, and a length check is a guess about one decoder's internals.
 *
 *      Reachable from an HTTP upload: `POST /api/brands/:id/assets` hands these bytes straight here, so a
 *      40-byte body was a remote process kill. `tests/brand-service.test.ts` uploads a 4-byte fixture and
 *      took out five vitest workers, which is how it surfaced.
 *
 *   2. **`@napi-rs/canvas` is a devDependency**, and this adapter is reachable from `lib/container.ts`,
 *      which every route imports. A production install (`npm ci --omit=dev`) would fail at module load on
 *      the first request. sharp is Next.js's own image dependency and present in a production install.
 *
 * ## Verified on sharp 0.34.5 / libvips 8.17.3, not assumed (§0.1)
 *
 *   - **Every hostile input throws catchably.** The 4-byte signature (`unsupported image format`), a
 *     33- and a 40-byte truncation (`corrupt header: pngload_buffer: end of stream`), a 200-byte
 *     truncation, empty (`Input Buffer is empty`), and plain text. No crash, no zeroed image — so the
 *     `null` path below is a real catch. This is the property that made sharp the choice; it is the whole
 *     point of the swap.
 *   - **All three SPEC §5 formats decode.** PNG (`fixtures/bg-16x9.png` → 960×540, mean R 36.7) and JPEG
 *     natively, and **SVG is rasterized** (a 160×90 `<svg>` with a `#0B0B14` rect → `rgb(10,10,19)`,
 *     alpha 248 at the sampled corner — libvips antialiases the rect edge, which is why the corner is not
 *     exactly opaque and why the mean, not a single pixel, is what this returns).
 *   - **Byte-identical output across calls** on the same input — `compileTheme`'s determinism contract
 *     (§8) reaches into this number, so it was checked rather than presumed.
 *   - **A fully transparent PNG yields alpha 0 at every sample**, so the `weight === 0` guard below is
 *     reachable and correct.
 *   - Warm decode+resize of a 960×540 PNG: **~7 ms**. Runs once per upload, never per render.
 *
 * ## Why it downsamples to a fixed grid
 *
 * The image is resized to 32×32 and averaged over its 1024 pixels rather than its original millions:
 *
 *   1. **Determinism at a fixed cost.** A fixed grid means the same image yields the same number
 *      regardless of its resolution, and bounds the work an upload can ask for.
 *   2. libvips does the box-filter averaging in native code, faster than walking full-size pixel data and
 *      to the same answer.
 *   3. 1024 samples is far more than enough for a *mean* — the question is "is this image broadly dark or
 *      broadly light", not a histogram.
 *
 * `fit: "fill"` deliberately: this ignores aspect ratio, which is right because every source pixel should
 * contribute to the mean. `fit: "cover"` would crop the edges out of the average entirely.
 *
 * A mean, not a median or a centre-weighted sample: text can be placed in any zone (zones are
 * user-editable), so no region is more "behind the text" than another. See
 * `lib/brand/background-luminance.ts` for what is done with the number.
 */

import sharp from "sharp";
import type { BackgroundLuminance } from "@/lib/brand/background-luminance";
import { relativeLuminance } from "@/lib/brand/contrast";
import type { ImageLuminancePort } from "@/lib/ports/image-luminance";

/** Sample grid edge. 32×32 = 1024 samples; see the header for why a fixed grid rather than full size. */
const GRID = 32;

/**
 * Ceiling on the DECODED pixel count, independent of the upload's byte size.
 *
 * sharp defaults `limitInputPixels` to 0x3FFF × 0x3FFF (~268 megapixels); this lowers it. A few hundred KB
 * of PNG can decode to gigabytes of pixels, so the byte-size limit the upload route enforces
 * (`maxAssetBytes`) is not a bound on the work done here. 40 MP is far above any legitimate 16:9 brand
 * background (a 4K one is 8.3 MP) and still bounds a decompression bomb into a catchable throw rather than
 * a memory spike.
 */
const MAX_INPUT_PIXELS = 40_000_000;

export class SharpImageLuminance implements ImageLuminancePort {
  async sample(bytes: Uint8Array): Promise<BackgroundLuminance | null> {
    let data: Buffer;
    try {
      // `ensureAlpha` so the stride is always 4 regardless of whether the source had an alpha channel —
      // probed: a 3-channel JPEG and a 4-channel PNG both come back `channels: 4` with it.
      const raw = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
        .resize(GRID, GRID, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      data = raw.data;
    } catch {
      // Probed: every undecodable, truncated, empty, or oversized input lands here. `null` means "no
      // information" (see the port's header) and the caller keeps using the brand's declared background
      // colour — the behaviour that predates this port. An unreadable image is a cosmetic unknown, not a
      // failed upload: the asset still stores and still renders.
      return null;
    }

    // Alpha-weighted: a logo-style PNG that is 90% transparent should be described by its visible pixels.
    // Weighting by alpha rather than skipping transparent pixels keeps a semi-transparent wash counted in
    // proportion to how much of it will actually be seen.
    let weighted = 0;
    let weight = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
      const alpha = data[i + 3]! / 255;
      if (alpha === 0) continue;
      // `contrast.ts`'s function, not a local copy of the curve: the whole point of this number is to be
      // compared against `relativeLuminance(brand.colors.background)`, and two implementations of the same
      // curve could drift into comparing values from slightly different scales.
      const l = relativeLuminance({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]! });
      weighted += l * alpha;
      weight += alpha;
    }

    // A fully transparent image carries no luminance information — not "black". Returning 0 here would
    // make `divergesFrom` see a black surface and flip text to white over whatever is actually behind it.
    if (weight === 0) return null;

    return { mean: weighted / weight };
  }
}
