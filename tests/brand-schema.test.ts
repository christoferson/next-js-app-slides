/**
 * §2 step 7 — `brand-schema.ts` ("zod incl. zone bounds + slotKey cross-check").
 *
 * SPEC §5 names the exact acceptance for JSON import: "hex colors, zones 0–100 non-degenerate,
 * `slotKey`s exist on the layout, assets resolve" — one describe block each. §12 adds "invalid
 * config → field-level readable zod errors, nothing partially applied", which is asserted directly.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND_COLORS, brandDefinitionSchema, brandInputSchema, describeIssues,
  slotZoneSchema, validateBrand, validateBrandInput,
} from "@/lib/brand/brand-schema";
import type { LayoutLookup } from "@/lib/brand/brand-schema";
import { DEFAULT_TONE_ID } from "@/lib/brand/tones";
import { AT, makeBrand } from "@/tests/fixtures";
import type { BrandDefinition } from "@/lib/brand/types";

/** A valid brand as it would arrive from a JSON import (registry ids the schema accepts). */
const validBrand = (over: Partial<BrandDefinition> = {}): BrandDefinition =>
  makeBrand({
    id: "01JQ0000000000000000000000",
    userId: "user-a",
    fonts: { heading: "georgia", body: "verdana" },
    tone: { voice: DEFAULT_TONE_ID, traits: ["direct"], bannedWords: ["synergy"] },
    templates: {
      title: {
        backgroundAssetId: "asset-bg-title",
        zones: [
          { slotKey: "title", x: 8, y: 12, w: 60, h: 20, align: "left", valign: "top" },
          { slotKey: "subtitle", x: 8, y: 42, w: 42, h: 12, align: "left", valign: "top" },
        ],
      },
    },
    ...over,
  });

/** Stands in for the layout registry (§2 step 8) — injected, per the schema's design. */
const layouts: LayoutLookup = {
  layout: (id) =>
    id === "title"
      ? { slotKeys: ["title", "subtitle", "eyebrow"], requiredSlotKeys: ["title"] }
      : id === "bullets"
        ? { slotKeys: ["title", "items"], requiredSlotKeys: ["title", "items"] }
        : undefined,
};

const paths = (r: { ok: false; issues: { path: string }[] } | { ok: true }): string[] =>
  r.ok ? [] : r.issues.map((i) => i.path);

describe("hex colours", () => {
  it("accepts and canonicalizes every form a user or import can produce", () => {
    const r = validateBrand(validBrand({
      colors: {
        primary: "#1a3a6b", secondary: "#456", accent: "8B2635",
        background: "#FFF", surface: "  #f4f5f7  ",
        textOnLight: "111111", textOnDark: "#ffffff",
      },
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Canonical RRGGBB, uppercase, no '#' — pptxgenjs's only accepted form (§1.1).
    for (const v of Object.values(r.value.colors)) expect(v).toMatch(/^[0-9A-F]{6}$/);
    expect(r.value.colors.primary).toBe("1A3A6B");
    expect(r.value.colors.secondary).toBe("445566");
  });

  it("rejects anything that isn't a hex colour, naming the field", () => {
    for (const bad of ["red", "rgb(1,2,3)", "#GGGGGG", "#FF00A", "#FF00AA80", "", "1A3A6B "]) {
      const r = validateBrand(validBrand({
        colors: { ...DEFAULT_BRAND_COLORS, primary: bad },
      }));
      // Note: trailing space IS accepted (parseHex trims) — assert only the truly invalid ones.
      if (bad === "1A3A6B ") { expect(r.ok, bad).toBe(true); continue; }
      expect(r.ok, bad).toBe(false);
      expect(paths(r), bad).toContain("colors.primary");
    }
  });

  it("requires every colour in the palette", () => {
    const { primary: _drop, ...partial } = DEFAULT_BRAND_COLORS;
    const r = validateBrand(validBrand({ colors: partial as never }));
    expect(r.ok).toBe(false);
    expect(paths(r)).toContain("colors.primary");
  });

  it("survives a JSON export → re-import round trip unchanged (§11 step 3)", () => {
    const once = validateBrand(validBrand());
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = validateBrand(JSON.parse(JSON.stringify(once.value)));
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.value).toEqual(once.value);
  });
});

describe("zone bounds — 0–100 non-degenerate", () => {
  const zone = { slotKey: "title", x: 10, y: 10, w: 30, h: 20, align: "left", valign: "top" } as const;

  it("accepts a zone inside the slide", () => {
    expect(slotZoneSchema.safeParse(zone).success).toBe(true);
  });

  it("accepts a full-bleed zone exactly filling the slide", () => {
    expect(slotZoneSchema.safeParse({ ...zone, x: 0, y: 0, w: 100, h: 100 }).success).toBe(true);
  });

  it("rejects degenerate width or height", () => {
    for (const patch of [{ w: 0 }, { h: 0 }, { w: -5 }, { h: -1 }]) {
      const r = slotZoneSchema.safeParse({ ...zone, ...patch });
      expect(r.success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("rejects coordinates outside 0–100", () => {
    for (const patch of [{ x: -1 }, { y: -0.5 }, { x: 101 }, { y: 100.5 }, { w: 120 }]) {
      const r = slotZoneSchema.safeParse({ ...zone, ...patch });
      expect(r.success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("rejects a box that overflows the slide edge", () => {
    // Individually in range, but together they place content off-canvas.
    expect(slotZoneSchema.safeParse({ ...zone, x: 80, w: 30 }).success).toBe(false);
    expect(slotZoneSchema.safeParse({ ...zone, y: 90, h: 20 }).success).toBe(false);
    // Exactly flush against the edge is fine, including with float drift.
    expect(slotZoneSchema.safeParse({ ...zone, x: 70, w: 30 }).success).toBe(true);
    expect(slotZoneSchema.safeParse({ ...zone, x: 33.33, w: 66.67 }).success).toBe(true);
  });

  it("rejects non-finite numbers rather than emitting NaN coordinates", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "10" as never]) {
      expect(slotZoneSchema.safeParse({ ...zone, x: bad }).success, String(bad)).toBe(false);
    }
  });

  it("rejects unknown align/valign values", () => {
    expect(slotZoneSchema.safeParse({ ...zone, align: "justify" }).success).toBe(false);
    expect(slotZoneSchema.safeParse({ ...zone, valign: "centre" }).success).toBe(false);
  });

  it("rejects two zones for the same slot in one template", () => {
    const r = validateBrand(validBrand({
      templates: {
        title: {
          zones: [
            { slotKey: "title", x: 0, y: 0, w: 50, h: 10, align: "left", valign: "top" },
            { slotKey: "title", x: 0, y: 20, w: 50, h: 10, align: "left", valign: "top" },
          ],
        },
      },
    }));
    expect(r.ok).toBe(false);
    expect(paths(r)).toContain("templates.title.zones");
  });

  it("reports the offending zone by index so the editor can highlight the row", () => {
    const r = validateBrand(validBrand({
      templates: {
        title: {
          zones: [
            { slotKey: "title", x: 0, y: 0, w: 50, h: 10, align: "left", valign: "top" },
            { slotKey: "subtitle", x: 0, y: 20, w: 0, h: 10, align: "left", valign: "top" },
          ],
        },
      },
    }));
    expect(r.ok).toBe(false);
    expect(paths(r)).toContain("templates.title.zones[1].w");
  });
});

describe("slotKey cross-check against the layout registry", () => {
  it("passes when every slotKey exists on the layout", () => {
    expect(validateBrand(validBrand(), { layouts }).ok).toBe(true);
  });

  it("rejects a slotKey the layout doesn't define", () => {
    const r = validateBrand(validBrand({
      templates: {
        title: {
          zones: [
            { slotKey: "title", x: 0, y: 0, w: 50, h: 10, align: "left", valign: "top" },
            { slotKey: "footnote", x: 0, y: 20, w: 50, h: 10, align: "left", valign: "top" },
          ],
        },
      },
    }), { layouts });
    expect(r.ok).toBe(false);
    expect(paths(r)).toEqual(["templates.title.zones[1].slotKey"]);
    expect(describeIssues(r.ok ? [] : r.issues)[0]).toContain('"title" layout');
  });

  it("rejects a template for a layout that doesn't exist", () => {
    const r = validateBrand(validBrand({
      templates: { pie_chart: { zones: [] } },
    }), { layouts });
    expect(r.ok).toBe(false);
    expect(paths(r)).toContain("templates.pie_chart");
  });

  it("rejects a template that omits a required slot's zone", () => {
    // A template replaces defaultZones wholesale, so an omitted required slot renders nothing.
    const r = validateBrand(validBrand({
      templates: {
        bullets: {
          zones: [{ slotKey: "title", x: 0, y: 0, w: 50, h: 10, align: "left", valign: "top" }],
        },
      },
    }), { layouts });
    expect(r.ok).toBe(false);
    expect(describeIssues(r.ok ? [] : r.issues).join("\n")).toContain('required "items" slot');
  });

  it("skips the cross-check entirely when no registry is supplied", () => {
    // Structural validation must not require the layout registry — the editor validates on keystroke.
    const r = validateBrand(validBrand({
      templates: {
        made_up: {
          zones: [{ slotKey: "nonsense", x: 0, y: 0, w: 10, h: 10, align: "left", valign: "top" }],
        },
      },
    }));
    expect(r.ok).toBe(true);
  });
});

describe("assets resolve", () => {
  const known = new Set(["asset-bg-title", "asset-logo"]);

  it("accepts references to assets that exist", () => {
    const r = validateBrand(validBrand({ logo: { light: "asset-logo" } }), { layouts, knownAssetIds: known });
    expect(r.ok).toBe(true);
  });

  it("rejects a background asset that no longer exists", () => {
    const r = validateBrand(validBrand({
      templates: {
        title: {
          backgroundAssetId: "asset-deleted",
          zones: [{ slotKey: "title", x: 0, y: 0, w: 50, h: 10, align: "left", valign: "top" }],
        },
      },
    }), { layouts, knownAssetIds: known });
    expect(r.ok).toBe(false);
    expect(paths(r)).toEqual(["templates.title.backgroundAssetId"]);
  });

  it("rejects a dangling logo reference, naming the role", () => {
    const r = validateBrand(validBrand({ logo: { light: "asset-logo", dark: "gone" } }), {
      layouts, knownAssetIds: known,
    });
    expect(r.ok).toBe(false);
    expect(paths(r)).toEqual(["logo.dark"]);
  });

  it("skips the asset check when no listing is supplied", () => {
    expect(validateBrand(validBrand(), { layouts }).ok).toBe(true);
  });
});

describe("fonts and tone", () => {
  it("accepts ratified and gated registry ids alike", () => {
    // Gating is a picker policy; an existing brand using a gated font must still validate.
    for (const heading of ["georgia", "cambria", "segoe_ui"]) {
      const r = validateBrand(validBrand({ fonts: { heading, body: "verdana" } }));
      expect(r.ok, heading).toBe(true);
    }
  });

  it("rejects a raw family name or a dropped registry id", () => {
    for (const heading of ["Georgia", "Comic Sans MS", "aptos", ""]) {
      const r = validateBrand(validBrand({ fonts: { heading, body: "verdana" } }));
      expect(r.ok, heading).toBe(false);
      expect(paths(r), heading).toContain("fonts.heading");
    }
  });

  it("rejects a tone voice outside the TONES registry, and lists the valid ones", () => {
    const r = validateBrand(validBrand({
      tone: { voice: "sassy", traits: [], bannedWords: [] },
    }));
    expect(r.ok).toBe(false);
    expect(paths(r)).toContain("tone.voice");
    expect(describeIssues(r.ok ? [] : r.issues)[0]).toContain("consultative");
  });

  it("bounds traits and banned words so a prompt can't be stuffed", () => {
    const long = "x".repeat(41);
    expect(validateBrand(validBrand({
      tone: { voice: DEFAULT_TONE_ID, traits: [long], bannedWords: [] },
    })).ok).toBe(false);
    expect(validateBrand(validBrand({
      tone: { voice: DEFAULT_TONE_ID, traits: Array.from({ length: 13 }, (_, i) => `t${i}`), bannedWords: [] },
    })).ok).toBe(false);
    expect(validateBrand(validBrand({
      tone: { voice: DEFAULT_TONE_ID, traits: [], bannedWords: Array.from({ length: 101 }, (_, i) => `w${i}`) },
    })).ok).toBe(false);
  });
});

describe("identity and hygiene", () => {
  it("requires a non-empty name and trims it", () => {
    expect(validateBrand(validBrand({ name: "   " })).ok).toBe(false);
    const r = validateBrand(validBrand({ name: "  Acme  " }));
    expect(r.ok && r.value.name).toBe("Acme");
  });

  it("rejects an over-long name", () => {
    expect(validateBrand(validBrand({ name: "n".repeat(81) })).ok).toBe(false);
  });

  it("rejects crafted ids before they can reach a path builder", () => {
    for (const id of ["../../etc/passwd", "..", "a/b", "a\\b", "C:\\Windows", "x\u0000y", ""]) {
      expect(validateBrand(validBrand({ id })).ok, JSON.stringify(id)).toBe(false);
      expect(validateBrand(validBrand({ userId: id })).ok, JSON.stringify(id)).toBe(false);
    }
    for (const assetId of ["../../secret", "a/b"]) {
      const r = validateBrand(validBrand({ logo: { light: assetId } }));
      expect(r.ok, assetId).toBe(false);
      expect(paths(r)).toContain("logo.light");
    }
  });

  it("rejects unknown fields instead of silently dropping them", () => {
    // A typo'd key in a hand-edited JSON import must be reported, not ignored.
    const r = validateBrand({ ...validBrand(), colours: {} });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(validateBrand(validBrand({ createdAt: "yesterday" })).ok).toBe(false);
    expect(validateBrand(validBrand({ createdAt: AT })).ok).toBe(true);
  });

  it("reports every problem at once, with a path per field (§12)", () => {
    const r = validateBrand(validBrand({
      name: "",
      colors: { ...DEFAULT_BRAND_COLORS, primary: "nope", accent: "also-nope" },
      fonts: { heading: "aptos", body: "verdana" },
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(paths(r).sort()).toEqual(["colors.accent", "colors.primary", "fonts.heading", "name"]);
    for (const issue of r.issues) expect(issue.message.length).toBeGreaterThan(3);
  });

  it("applies nothing at all when any field is invalid", () => {
    const r = validateBrand(validBrand({ colors: { ...DEFAULT_BRAND_COLORS, primary: "nope" } }));
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("value");
  });
});

describe("brandInputSchema — the create/update surface", () => {
  it("needs only a name, defaulting to a usable AA-clean brand", () => {
    const r = validateBrandInput({ name: "Minimal" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.colors).toEqual(DEFAULT_BRAND_COLORS);
    expect(r.value.tone.voice).toBe(DEFAULT_TONE_ID);
    expect(r.value.tone.bannedWords.length).toBeGreaterThan(0);
    expect(r.value.templates).toEqual({});
  });

  it("does not accept identity fields as part of the editable surface", () => {
    // The service owns id/userId/timestamps; accepting them here would let a client aim a write.
    expect(brandInputSchema.safeParse({ name: "X", userId: "user-b" }).success).toBe(false);
    expect(brandInputSchema.safeParse({ name: "X", id: "whatever" }).success).toBe(false);
  });

  it("still runs the cross-checks", () => {
    const r = validateBrandInput({
      name: "X",
      templates: {
        title: {
          zones: [{ slotKey: "ghost", x: 0, y: 0, w: 10, h: 10, align: "left", valign: "top" }],
        },
      },
    }, { layouts });
    expect(r.ok).toBe(false);
    expect(paths(r)).toContain("templates.title.zones[0].slotKey");
  });

  it("keeps the full schema stricter than the input schema on identity", () => {
    // The definition schema DOES require them — that's how a re-import round-trips.
    expect(brandDefinitionSchema.safeParse({ name: "X" }).success).toBe(false);
  });
});
