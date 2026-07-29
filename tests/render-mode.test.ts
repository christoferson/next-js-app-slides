/**
 * The Strategy resolver and the two §8 shared utils it feeds.
 *
 * SPEC §6 requires the templated/token-styled decision be made "inside one strategy resolver — never
 * branched at call sites", and §8 requires the browser preview and `toPptx` to consume the *same* zone
 * resolution. Both are properties of this file, so this is where they get asserted:
 *
 *  - a background asset, not customized zones, is what makes a layout templated;
 *  - a brand template REPLACES the defaults wholesale (merging would resurrect a deliberately removed
 *    zone, and the brand editor could then never express "this layout has no subtitle");
 *  - the returned zones are a fresh copy, because a mutation would corrupt the registry for the whole
 *    process — every later deck in the same server would render with one deck's edits.
 */

import { describe, expect, it } from "vitest";
import type { BrandDefinition, SlotZone } from "@/lib/brand/types";
import { makeBrand } from "./fixtures";
import { LAYOUTS } from "@/lib/layouts/registry";
import { bulletsLayout } from "@/lib/layouts/defs/bullets";
import { titleLayout } from "@/lib/layouts/defs/title";
import { resolveRenderPlan, resolveZones, templatedLayoutIds, zoneFor } from "@/lib/layouts/render-mode";
import { placeBackground, canUseAsMaster, imageSize } from "@/lib/layouts/background";
import { SLIDE_16x9 } from "@/lib/layouts/zone-math";

/** `makeBrand` ships a `title` template; every case here states its own, so start from none. */
const brandWith = (templates: BrandDefinition["templates"]): BrandDefinition =>
  makeBrand({ templates });

/** Deliberately asymmetric, per CLAUDE.md §8's fixture instruction — off-centre catches lazy math. */
const CUSTOM: SlotZone[] = [
  { slotKey: "title", x: 8, y: 12, w: 60, h: 22, align: "left", valign: "top" },
  { slotKey: "items", x: 8, y: 40, w: 60, h: 44, align: "left", valign: "top" },
];

describe("resolveZones", () => {
  it("falls back to the layout's defaults with no brand at all", () => {
    const { zones, customized } = resolveZones(undefined, bulletsLayout);
    expect(zones).toEqual(bulletsLayout.defaultZones);
    expect(customized).toBe(false);
  });

  it("falls back to the defaults when the brand has no template for this layout", () => {
    const { zones, customized } = resolveZones(brandWith({}), bulletsLayout);
    expect(zones).toEqual(bulletsLayout.defaultZones);
    expect(customized).toBe(false);
  });

  it("uses the brand's zones when it has them", () => {
    const brand = brandWith({ bullets: { zones: CUSTOM } });
    const { zones, customized } = resolveZones(brand, bulletsLayout);
    expect(zones).toEqual(CUSTOM);
    expect(customized).toBe(true);
  });

  it("REPLACES the defaults wholesale rather than merging per slot", () => {
    // `bullets` has a `takeaway`; a template that omits it must not have one restored. Merging would
    // make "this layout does not show a takeaway" inexpressible in the brand editor.
    expect(bulletsLayout.slots.some((s) => s.key === "takeaway")).toBe(true);
    const { zones } = resolveZones(brandWith({ bullets: { zones: CUSTOM } }), bulletsLayout);
    expect(zoneFor(zones, "takeaway")).toBeUndefined();
    expect(zones).toHaveLength(CUSTOM.length);
  });

  it("treats an empty zone array as no customization", () => {
    // Otherwise a template saved with zero zones would render a blank slide (§13) rather than defaults.
    const { zones, customized } = resolveZones(brandWith({ bullets: { zones: [] } }), bulletsLayout);
    expect(zones).toEqual(bulletsLayout.defaultZones);
    expect(customized).toBe(false);
  });

  it("returns a fresh array of fresh zones — the registry is not mutable through it", () => {
    const first = resolveZones(undefined, bulletsLayout);
    first.zones[0]!.x = 999;
    first.zones.pop();

    const second = resolveZones(undefined, bulletsLayout);
    expect(second.zones).toEqual(bulletsLayout.defaultZones);
    expect(second.zones[0]!.x).not.toBe(999);
  });

  it("copies the brand's zones too, so an edit cannot write back into stored config", () => {
    const brand = brandWith({ bullets: { zones: CUSTOM } });
    resolveZones(brand, bulletsLayout).zones[0]!.x = 999;
    expect(CUSTOM[0]!.x).toBe(8);
  });

  it("resolves for every seed layout without a gap", () => {
    for (const layout of LAYOUTS) {
      const { zones } = resolveZones(brandWith({}), layout);
      expect(zones.length, layout.id).toBeGreaterThan(0);
    }
  });
});

describe("resolveRenderPlan", () => {
  it("is token-styled with no brand", () => {
    const plan = resolveRenderPlan(undefined, titleLayout);
    expect(plan.mode).toBe("token-styled");
    expect(plan.backgroundAssetId).toBeUndefined();
  });

  it("is templated when a background asset is present", () => {
    const brand = brandWith({ title: { backgroundAssetId: "a1", zones: CUSTOM } });
    const plan = resolveRenderPlan(brand, titleLayout);
    expect(plan.mode).toBe("templated");
    expect(plan.backgroundAssetId).toBe("a1");
  });

  it("stays token-styled when a brand customizes zones but supplies no background", () => {
    // The distinction the resolver exists for: a brand may reposition slots while still wanting the
    // token-styled look. Keying the mode off zones would silently take that away.
    const plan = resolveRenderPlan(brandWith({ title: { zones: CUSTOM } }), titleLayout);
    expect(plan.mode).toBe("token-styled");
    expect(plan.zonesCustomized).toBe(true);
  });

  it("reports zones and customization alongside the mode, so callers never re-resolve", () => {
    const brand = brandWith({ title: { backgroundAssetId: "a1", zones: CUSTOM } });
    expect(resolveRenderPlan(brand, titleLayout).zones).toEqual(CUSTOM);
    expect(resolveRenderPlan(brandWith({}), titleLayout).zonesCustomized).toBe(false);
  });

  it("keys off the layout being rendered, not any templated layout", () => {
    const brand = brandWith({ title: { backgroundAssetId: "a1", zones: CUSTOM } });
    expect(resolveRenderPlan(brand, bulletsLayout).mode).toBe("token-styled");
  });

  it("agrees with resolveZones — one decision, not two", () => {
    const brand = brandWith({ bullets: { backgroundAssetId: "a1", zones: CUSTOM } });
    expect(resolveRenderPlan(brand, bulletsLayout).zones)
      .toEqual(resolveZones(brand, bulletsLayout).zones);
  });
});

describe("zoneFor", () => {
  it("finds a slot's zone", () => {
    expect(zoneFor(CUSTOM, "title")).toBe(CUSTOM[0]);
  });

  it("returns undefined for a slot this layout places nowhere", () => {
    expect(zoneFor(CUSTOM, "takeaway")).toBeUndefined();
  });

  it("returns undefined rather than throwing on an empty zone list", () => {
    expect(zoneFor([], "title")).toBeUndefined();
  });
});

describe("templatedLayoutIds", () => {
  it("lists only layouts with a background asset", () => {
    const brand = brandWith({
      title: { backgroundAssetId: "a1", zones: CUSTOM },
      bullets: { zones: CUSTOM },
    });
    expect(templatedLayoutIds(brand)).toEqual(["title"]);
  });

  it("sorts, so a gallery card's list is stable across saves", () => {
    const brand = brandWith({
      quote: { backgroundAssetId: "a3", zones: CUSTOM },
      agenda: { backgroundAssetId: "a1", zones: CUSTOM },
      title: { backgroundAssetId: "a2", zones: CUSTOM },
    });
    expect(templatedLayoutIds(brand)).toEqual(["agenda", "quote", "title"]);
  });

  it("is empty for a brand with no templates", () => {
    expect(templatedLayoutIds(brandWith({}))).toEqual([]);
  });

  it("uses the same rule the resolver does, so a card cannot claim an unrenderable template", () => {
    const brand = brandWith({
      title: { backgroundAssetId: "a1", zones: CUSTOM },
      bullets: { zones: CUSTOM },
    });
    for (const layout of LAYOUTS) {
      const claimed = templatedLayoutIds(brand).includes(layout.id);
      expect(claimed, layout.id).toBe(resolveRenderPlan(brand, layout).mode === "templated");
    }
  });
});

describe("placeBackground — §1.1/C2's replacement for sizing", () => {
  it("makes a 16:9 image full-bleed with no bars", () => {
    expect(placeBackground({ width: 1920, height: 1080 })).toEqual({
      x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height, letterboxed: false, cropped: false,
    });
  });

  it("snaps a near-16:9 image to full-bleed rather than showing a 1px bar", () => {
    // A sub-1% bar reads as a rendering bug. `cropped` still records the trade honestly.
    const placed = placeBackground({ width: 1920, height: 1081 });
    expect(placed.letterboxed).toBe(false);
    expect(placed.w).toBe(SLIDE_16x9.width);
    expect(placed.cropped).toBe(false);
  });

  it("pillarboxes a 4:3 image, centred, without distorting it", () => {
    const placed = placeBackground({ width: 1600, height: 1200 });
    expect(placed.h).toBeCloseTo(SLIDE_16x9.height, 10);
    expect(placed.w).toBeCloseTo(SLIDE_16x9.height * (4 / 3), 10);
    expect(placed.x).toBeCloseTo((SLIDE_16x9.width - placed.w) / 2, 10);
    expect(placed.y).toBe(0);
    expect(placed.letterboxed).toBe(true);
    expect(placed.cropped).toBe(false);
  });

  it("letterboxes an ultra-wide image with bars top and bottom", () => {
    const placed = placeBackground({ width: 2560, height: 800 });
    expect(placed.w).toBe(SLIDE_16x9.width);
    expect(placed.h).toBeCloseTo(SLIDE_16x9.width / (2560 / 800), 10);
    expect(placed.x).toBe(0);
    expect(placed.y).toBeGreaterThan(0);
    expect(placed.letterboxed).toBe(true);
  });

  it("preserves the source aspect ratio in every contain case", () => {
    // The whole reason `sizing:{type:'contain'}` was unusable — it stretched. This is the assertion
    // that says our replacement does not.
    for (const img of [
      { width: 1600, height: 1200 }, { width: 2560, height: 800 }, { width: 1080, height: 1920 },
      { width: 1000, height: 1000 },
    ]) {
      const placed = placeBackground(img);
      expect(placed.w / placed.h, `${img.width}×${img.height}`)
        .toBeCloseTo(img.width / img.height, 6);
    }
  });

  it("covers by overflowing the slide, centred, and says so", () => {
    const placed = placeBackground({ width: 1600, height: 1200 }, SLIDE_16x9, "cover");
    expect(placed.w).toBeGreaterThanOrEqual(SLIDE_16x9.width);
    expect(placed.h).toBeGreaterThanOrEqual(SLIDE_16x9.height);
    expect(placed.cropped).toBe(true);
    expect(placed.letterboxed).toBe(false);
  });

  it("centres the overflow in cover mode, so the crop is symmetric", () => {
    const placed = placeBackground({ width: 1080, height: 1920 }, SLIDE_16x9, "cover");
    expect(placed.x + placed.w / 2).toBeCloseTo(SLIDE_16x9.width / 2, 10);
    expect(placed.y + placed.h / 2).toBeCloseTo(SLIDE_16x9.height / 2, 10);
  });

  it("stretches only when explicitly asked, and flags the distortion as a crop", () => {
    const placed = placeBackground({ width: 1600, height: 1200 }, SLIDE_16x9, "stretch");
    expect(placed).toMatchObject({ x: 0, y: 0, w: SLIDE_16x9.width, h: SLIDE_16x9.height });
    expect(placed.cropped).toBe(true);
  });

  it("never emits a negative offset in contain mode — negative srcRect is invalid OOXML (C2)", () => {
    for (const img of [
      { width: 1600, height: 1200 }, { width: 2560, height: 800 }, { width: 1080, height: 1920 },
      { width: 3, height: 1000 }, { width: 1000, height: 3 },
    ]) {
      const placed = placeBackground(img);
      expect(placed.x, `${img.width}×${img.height}`).toBeGreaterThanOrEqual(0);
      expect(placed.y, `${img.width}×${img.height}`).toBeGreaterThanOrEqual(0);
      expect(placed.w).toBeLessThanOrEqual(SLIDE_16x9.width + 1e-9);
      expect(placed.h).toBeLessThanOrEqual(SLIDE_16x9.height + 1e-9);
    }
  });

  it("letterboxed is exactly the amber-badge condition (§12)", () => {
    // The flag must mean "bars are visible", not "the aspect differed" — a near-16:9 asset differs but
    // shows no bars, and badging it would train the user to ignore the badge.
    expect(placeBackground({ width: 1920, height: 1081 }).letterboxed).toBe(false);
    expect(placeBackground({ width: 1600, height: 1200 }).letterboxed).toBe(true);
  });
});

describe("canUseAsMaster — §1.1/C3's dedup gate", () => {
  it("accepts 16:9 assets at any resolution", () => {
    expect(canUseAsMaster({ width: 1920, height: 1080 })).toBe(true);
    expect(canUseAsMaster({ width: 3840, height: 2160 })).toBe(true);
    expect(canUseAsMaster({ width: 1280, height: 720 })).toBe(true);
  });

  it("rejects anything that would be stretched by a master background", () => {
    expect(canUseAsMaster({ width: 1600, height: 1200 })).toBe(false);
    expect(canUseAsMaster({ width: 2560, height: 800 })).toBe(false);
  });

  it("agrees with placeBackground about which assets are full-bleed", () => {
    // The two must not disagree: a master path taken for an asset `placeBackground` would letterbox is
    // exactly the silent distortion C3 warns about.
    for (const img of [
      { width: 1920, height: 1080 }, { width: 1920, height: 1081 }, { width: 1600, height: 1200 },
      { width: 2560, height: 800 }, { width: 1080, height: 1920 },
    ]) {
      const label = `${img.width}×${img.height}`;
      expect(canUseAsMaster(img), label).toBe(!placeBackground(img).letterboxed);
    }
  });
});

describe("imageSize", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("reads JPEG dimensions from the first SOF marker", () => {
    expect(imageSize(jpeg(1600, 1200))).toEqual({ width: 1600, height: 1200 });
  });

  it("skips non-frame markers on the way to SOF", () => {
    // 0xFFC4 (DHT) is in the SOF numeric range but is not a frame header; reading it as one yields
    // garbage dimensions, which would silently letterbox a perfectly good 16:9 background.
    expect(imageSize(jpeg(1920, 1080, { withDht: true }))).toEqual({ width: 1920, height: 1080 });
  });

  it("returns null for SVG rather than guessing", () => {
    expect(imageSize(new TextEncoder().encode('<svg viewBox="0 0 16 9"></svg>'))).toBeNull();
  });

  it("returns null for unrecognized and truncated bytes", () => {
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
    expect(imageSize(png(1920, 1080).slice(0, 20))).toBeNull();
  });

  it("terminates on a malformed JPEG rather than looping", () => {
    // A zero segment length would advance the cursor by 0 forever. Hostile input, and a hang in an
    // upload handler is a denial of service rather than a bad image.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(bytes)).toBeNull();
  });

  it("reads from a correctly offset view, not the whole underlying buffer", () => {
    // `Buffer.subarray` shares its parent's ArrayBuffer with a non-zero byteOffset; a DataView built
    // without that offset reads the wrong bytes entirely.
    const source = png(800, 600);
    const padded = new Uint8Array(source.length + 8);
    padded.set(source, 8);
    expect(imageSize(padded.subarray(8))).toEqual({ width: 800, height: 600 });
  });
});

/** Minimal PNG: signature + IHDR length/type/width/height. Enough for `imageSize`. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);   // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Minimal JPEG: SOI, optional DHT decoy, then SOF0 carrying the dimensions. */
function jpeg(width: number, height: number, options: { withDht?: boolean } = {}): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (options.withDht) parts.push(0xff, 0xc4, 0x00, 0x06, 0, 0, 0, 0);
  parts.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  );
  return new Uint8Array(parts);
}
