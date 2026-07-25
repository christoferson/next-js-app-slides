/**
 * Background placement math — shared by the browser preview and the PPTX exporter (§8).
 *
 * Why this exists instead of pptxgenjs `sizing: {type:'contain'|'cover'}`:
 * the library computes its aspect ratios from the DECLARED w/h, not the image's
 * intrinsic pixels (dist/pptxgen.cjs.js ImageSizingXml + call site ~L5560), so
 * `contain` cannot letterbox and a mismatched box emits NEGATIVE <a:srcRect>
 * values — invalid OOXML crop. Verified in scripts/verify-pptx-probe3.ts (probe G).
 */
export type BackgroundFit = "contain" | "cover" | "stretch";

export interface Placement {
  x: number; y: number; w: number; h: number; // inches
  letterboxed: boolean;                        // drives the amber quality badge
  cropped: boolean;
}

const ASPECT_TOLERANCE = 0.005; // ~0.9% — treat 1920x1081 as 16:9

export function placeBackground(
  img: { width: number; height: number },   // intrinsic pixels
  slide: { width: number; height: number }, // inches
  fit: BackgroundFit = "contain",
): Placement {
  const imgAspect = img.width / img.height;
  const slideAspect = slide.width / slide.height;
  const matches = Math.abs(imgAspect - slideAspect) <= ASPECT_TOLERANCE * slideAspect;

  if (matches || fit === "stretch") {
    return { x: 0, y: 0, w: slide.width, h: slide.height, letterboxed: false, cropped: !matches };
  }

  if (fit === "contain") {
    const wider = imgAspect > slideAspect;
    const w = wider ? slide.width : slide.height * imgAspect;
    const h = wider ? slide.width / imgAspect : slide.height;
    return { x: (slide.width - w) / 2, y: (slide.height - h) / 2, w, h, letterboxed: true, cropped: false };
  }

  // cover: fill the slide, overflow centred (PowerPoint clips at slide bounds)
  const wider = imgAspect > slideAspect;
  const w = wider ? slide.height * imgAspect : slide.width;
  const h = wider ? slide.height : slide.width / imgAspect;
  return { x: (slide.width - w) / 2, y: (slide.height - h) / 2, w, h, letterboxed: false, cropped: true };
}

/** Reads intrinsic size from a PNG/JPEG buffer without an image library. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG: IHDR at fixed offset
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan SOF markers
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      const len = buf.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      o += 2 + len;
    }
  }
  return null; // SVG / unknown — caller must supply dimensions or treat as stretch
}
