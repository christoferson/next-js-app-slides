/**
 * §8 shared percent -> inches math. The spike uses the SAME function the real
 * exporter and browser preview will consume, so the fidelity check is meaningful.
 */
export const SLIDE_16x9 = { name: "16x9", width: 10, height: 5.625 } as const;

export interface SlotZone {
  slotKey: string;
  x: number; y: number; w: number; h: number; // percent 0..100
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
}

export interface ZoneBox { x: number; y: number; w: number; h: number } // inches

export function zoneToInches(
  zone: Pick<SlotZone, "x" | "y" | "w" | "h">,
  slide: { width: number; height: number } = SLIDE_16x9,
): ZoneBox {
  return {
    x: (zone.x / 100) * slide.width,
    y: (zone.y / 100) * slide.height,
    w: (zone.w / 100) * slide.width,
    h: (zone.h / 100) * slide.height,
  };
}

/** OOXML unit: 914400 EMU per inch. Used to assert what pptxgenjs actually wrote. */
export const EMU_PER_INCH = 914400;
export const toEmu = (inches: number) => Math.round(inches * EMU_PER_INCH);
