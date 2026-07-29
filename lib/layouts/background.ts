/**
 * Background placement math — the second §8 shared util, promoted from `scripts/letterbox.ts`
 * (table-tested there across 7 aspect cases, and proven to serialize without negative `srcRect`).
 *
 * Why this exists at all instead of pptxgenjs's `sizing: {type:'contain'|'cover'}` — §1.1/C2:
 * the library derives its aspect ratios from the DECLARED `w`/`h`, not the image's intrinsic pixels,
 * so `contain` does not letterbox (it stretches) and a mismatched box emits **negative** `<a:srcRect>`
 * crop values, which is invalid OOXML. `sizing` is unusable; this is the replacement.
 *
 * Documented choice for §8: **`contain`** (pillarbox/letterbox, never distort), and `letterboxed`
 * drives the amber quality badge (§12) so the user is told rather than shown a surprise.
 */

import { SLIDE_16x9, type SlideSize } from "@/lib/layouts/zone-math";

export type BackgroundFit = "contain" | "cover" | "stretch";

export interface Placement {
  /** Inches. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Bars are visible — the brand's background does not fill the slide. Amber badge (§12). */
  letterboxed: boolean;
  /** Part of the image falls outside the slide and will be clipped. */
  cropped: boolean;
}

/** ~0.5% of the slide aspect. Treats 1920×1081 as 16:9; sub-1% distortion is the deliberate trade. */
const ASPECT_TOLERANCE = 0.005;

export function placeBackground(
  /** Intrinsic pixel dimensions — NOT the box we intend to draw into (that's C2's mistake). */
  img: { width: number; height: number },
  slide: SlideSize = SLIDE_16x9,
  fit: BackgroundFit = "contain",
): Placement {
  const imgAspect = img.width / img.height;
  const slideAspect = slide.width / slide.height;
  const matches = Math.abs(imgAspect - slideAspect) <= ASPECT_TOLERANCE * slideAspect;

  // Near-16:9 snaps to full-bleed: a 1px bar would look like a rendering bug, not a design.
  if (matches || fit === "stretch") {
    return { x: 0, y: 0, w: slide.width, h: slide.height, letterboxed: false, cropped: !matches };
  }

  if (fit === "contain") {
    const wider = imgAspect > slideAspect;
    const w = wider ? slide.width : slide.height * imgAspect;
    const h = wider ? slide.width / imgAspect : slide.height;
    return {
      x: (slide.width - w) / 2, y: (slide.height - h) / 2, w, h,
      letterboxed: true, cropped: false,
    };
  }

  // cover: fill the slide, overflow centred (PowerPoint clips at the slide bounds).
  const wider = imgAspect > slideAspect;
  const w = wider ? slide.height * imgAspect : slide.width;
  const h = wider ? slide.height : slide.width / imgAspect;
  return {
    x: (slide.width - w) / 2, y: (slide.height - h) / 2, w, h,
    letterboxed: false, cropped: true,
  };
}

/**
 * Whether this asset may be used as a `defineSlideMaster` background.
 *
 * §1.1/C3: masters cut deck size ~4× by deduplicating media (611 KB → 146 KB over 15 slides), but a
 * master background ALWAYS stretches to the slide (`<a:stretch><a:fillRect/>`, no `srcRect`). So a
 * non-16:9 asset must fall back to a slide-level `addImage` with `placeBackground`, forfeiting dedup
 * for that one asset rather than distorting it.
 */
export const canUseAsMaster = (
  img: { width: number; height: number }, slide: SlideSize = SLIDE_16x9,
): boolean => {
  const slideAspect = slide.width / slide.height;
  return Math.abs(img.width / img.height - slideAspect) <= ASPECT_TOLERANCE * slideAspect;
};

/**
 * Intrinsic pixel size from PNG/JPEG bytes, with no image dependency.
 *
 * `null` for SVG and anything unrecognized — the caller must then treat the asset as full-bleed
 * (there is nothing to letterbox against) rather than guessing dimensions.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: \x89PNG signature, then IHDR width/height at fixed offsets 16/20.
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: walk the marker chain to the first Start-Of-Frame.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) { o += 1; continue; }
      const marker = bytes[o + 1]!;
      const len = view.getUint16(o + 2);
      // SOF0..SOF15 carry the dimensions; C4 (DHT), C8 (JPG) and CC (DAC) are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(o + 5), width: view.getUint16(o + 7) };
      }
      if (len <= 0) return null; // malformed length would loop forever
      o += 2 + len;
    }
  }

  return null;
}
