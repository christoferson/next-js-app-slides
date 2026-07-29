/**
 * The §8 "one shared util, two consumers" — percent zones → the units each renderer needs.
 *
 * Promoted from `scripts/zone-math.ts`, which the §1.1 spike used to assert what pptxgenjs actually
 * wrote. Keeping the *same* function is the whole point: the spike proved the percent→inches→EMU
 * chain is exact (0 EMU deviation, three independent renderers), and that proof only transfers to
 * production if production runs the same code. Reimplementing it in the exporter would silently
 * void the verification.
 *
 * Nothing here imports pptxgenjs or React — both the browser preview and `toPptx` consume it.
 */

/** SPEC fixes 16:9 at 10 × 5.625 in, matching the `defineLayout` call the spike verified. */
export const SLIDE_16x9 = { name: "16x9", width: 10, height: 5.625 } as const;

export interface SlideSize {
  width: number;
  height: number;
}

/** Inches — pptxgenjs's native unit. */
export interface ZoneBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Percent of the slide, 0–100. The stored form; see `SlotZone` in `lib/brand/types.ts`. */
export interface ZonePercent {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function zoneToInches(zone: ZonePercent, slide: SlideSize = SLIDE_16x9): ZoneBox {
  return {
    x: (zone.x / 100) * slide.width,
    y: (zone.y / 100) * slide.height,
    w: (zone.w / 100) * slide.width,
    h: (zone.h / 100) * slide.height,
  };
}

/** OOXML's unit. 914400 EMU per inch — used by the export-time geometry assertions. */
export const EMU_PER_INCH = 914400;

export const toEmu = (inches: number): number => Math.round(inches * EMU_PER_INCH);

/** Inches → CSS percent. The preview positions zones directly from the stored percents. */
export const zoneToCssPercent = (zone: ZonePercent): Record<"left" | "top" | "width" | "height", string> => ({
  left: `${zone.x}%`,
  top: `${zone.y}%`,
  width: `${zone.w}%`,
  height: `${zone.h}%`,
});

export const POINTS_PER_INCH = 72;

/**
 * Point size → `cqh` (1cqh = 1% of the container's height), so the preview scales with its frame
 * while staying numerically tied to the SAME point size the PPTX gets.
 *
 * Why not `pt` in CSS: a browser point is a fixed physical unit, so a 32pt title would render at
 * one absolute size regardless of how large the preview canvas is — a thumbnail and a full-screen
 * canvas would show completely different layouts, and neither would match the export. Expressing it
 * as a fraction of slide height makes the preview a true scale model: `type.title` is the single
 * source of truth and both consumers derive from it, which is what §8 requires.
 *
 * Requires the slide frame to set `container-type: size`.
 */
export const ptToCqh = (points: number, slide: SlideSize = SLIDE_16x9): number =>
  (points / (slide.height * POINTS_PER_INCH)) * 100;
