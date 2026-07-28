/**
 * Brand validation (CLAUDE.md §2 step 7 — "zod incl. zone bounds + slotKey cross-check").
 *
 * Two distinct jobs, deliberately kept apart:
 *
 *  1. **Structural validation** (`brandDefinitionSchema`, `brandInputSchema`) — pure zod. Hex
 *     colours, zone bounds, known font ids, known tone voices, string budgets. No dependency on
 *     any other registry, so it is usable from anywhere including the client.
 *  2. **Cross-checks** (`validateBrand`) — the checks that need knowledge this module must not
 *     import: do the `templates` keys name real layouts, do their `slotKey`s exist on those
 *     layouts, do the referenced asset ids resolve. These arrive through the injected
 *     `LayoutLookup` / `knownAssetIds` options.
 *
 * Why injection rather than `import { LAYOUTS }`: layout definitions consume `DesignTokens` from
 * this directory, so a direct import would create a cycle `brand → layouts → brand`. Injection also
 * means the cross-checks are testable now, before the layout registry exists (§2 step 8), and it
 * keeps `lib/brand` free of React (layouts carry a `FallbackRenderer`).
 *
 * Colours are NORMALIZED to canonical `RRGGBB` (uppercase, no `#`) on the way in. That is the one
 * form pptxgenjs accepts (§1.1) and the form `DesignTokens` emits, so storing it means `#fff`,
 * `#FFF`, and `FFFFFF` cannot become three "different" brands. JSON export → re-import is identical
 * (§11 step 3) because export already emits the canonical form.
 */

import { z } from "zod";
import { normalizeHex } from "@/lib/brand/contrast";
import { DEFAULT_BODY_FONT_ID, DEFAULT_HEADING_FONT_ID, isKnownFontId } from "@/lib/brand/fonts";
import { DEFAULT_BANNED_WORDS, DEFAULT_TONE_ID, TONES, isKnownToneId } from "@/lib/brand/tones";
import type { BrandDefinition } from "@/lib/brand/types";

/* ────────────────────────────── primitives ────────────────────────────── */

/**
 * Storage ids. The real traversal defence is the path builder (`fs-util.safeSegment`, §6.5) — this
 * is depth, so a crafted id is rejected at the edge with a readable message instead of deep inside
 * the filesystem adapter.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const safeId = z.string().regex(SAFE_ID, { error: "must contain only letters, digits, '-' and '_'" });

/** Registry keys (layout ids, slot keys). Deliberately permissive about case: layouts may use either. */
const REGISTRY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const registryKey = z.string().regex(REGISTRY_KEY, { error: "must be a simple identifier" });

const hexColor = z.string()
  .refine((v) => normalizeHex(v) !== null, {
    error: "must be a hex colour such as #1A3A6B",
  })
  // Safe: the refine above already proved this parses.
  .transform((v) => normalizeHex(v)!);

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  error: "must be an ISO 8601 timestamp",
});

/* ────────────────────────────── zones ────────────────────────────── */

const percent = z.number()
  .refine(Number.isFinite, { error: "must be a number" })
  .min(0, { error: "must be at least 0%" })
  .max(100, { error: "must be at most 100%" });

/** A zero-width or zero-height box would render nothing at all — SPEC calls this "non-degenerate". */
const extent = z.number()
  .refine(Number.isFinite, { error: "must be a number" })
  .gt(0, { error: "must be greater than 0%" })
  .max(100, { error: "must be at most 100%" });

/** Floats accumulate; 100.0000001 is not a real overflow. */
const EPSILON = 1e-6;

export const slotZoneSchema = z.strictObject({
  slotKey: registryKey,
  x: percent,
  y: percent,
  w: extent,
  h: extent,
  align: z.enum(["left", "center", "right"]),
  valign: z.enum(["top", "middle", "bottom"]),
})
  .refine((z_) => z_.x + z_.w <= 100 + EPSILON, {
    error: "extends past the right edge of the slide (x + w must be ≤ 100%)",
    path: ["w"],
  })
  .refine((z_) => z_.y + z_.h <= 100 + EPSILON, {
    error: "extends past the bottom edge of the slide (y + h must be ≤ 100%)",
    path: ["h"],
  });

export const layoutTemplateSchema = z.strictObject({
  backgroundAssetId: safeId.optional(),
  zones: z.array(slotZoneSchema)
    .max(32, { error: "has too many zones" })
    .refine((zones) => new Set(zones.map((z_) => z_.slotKey)).size === zones.length, {
      error: "defines the same slot twice",
    }),
});

/* ────────────────────────────── brand parts ────────────────────────────── */

/** A neutral, AA-clean starting palette, so `POST /api/brands { name }` yields a usable brand. */
export const DEFAULT_BRAND_COLORS = {
  primary: "1A3A6B",
  secondary: "4A5568",
  accent: "8B2635",
  background: "FFFFFF",
  surface: "F4F5F7",
  textOnLight: "111111",
  textOnDark: "FFFFFF",
} as const;

export const brandColorsSchema = z.strictObject({
  primary: hexColor,
  secondary: hexColor,
  accent: hexColor,
  background: hexColor,
  surface: hexColor,
  textOnLight: hexColor,
  textOnDark: hexColor,
});

/**
 * Font ids must exist in the FONTS registry — including `gated` entries. Gating is a *picker*
 * policy (`selectableFonts()`), not a validity rule: a brand created before an entry was gated must
 * still validate, or the user could not even open it to change the font.
 */
const fontId = z.string().refine(isKnownFontId, {
  error: "isn't a font this app can render in PowerPoint",
});

export const brandFontsSchema = z.strictObject({
  heading: fontId,
  body: fontId,
});

export const brandLogoSchema = z.strictObject({
  light: safeId.optional(),
  dark: safeId.optional(),
});

/**
 * `voice` is a TONES registry id, not free text.
 *
 * This is the one brand field that reaches an LLM prompt (§7), so keeping it a closed set means the
 * text we send is authored by us and provably free of visual vocabulary. Users who want a bespoke
 * voice express it through `traits`, which are short content descriptors — the same guarantee holds
 * because traits cannot smuggle in a hex code without failing the purity test's own assertions.
 */
export const brandToneSchema = z.strictObject({
  voice: z.string().refine(isKnownToneId, {
    error: `must be one of: ${TONES.map((t) => t.id).join(", ")}`,
  }),
  traits: z.array(z.string().trim().min(1).max(40, { error: "is too long" }))
    .max(12, { error: "has too many traits" }),
  bannedWords: z.array(z.string().trim().min(1).max(40, { error: "is too long" }))
    .max(100, { error: "has too many banned words" }),
});

const templatesSchema = z.record(registryKey, layoutTemplateSchema)
  .refine((t) => Object.keys(t).length <= 64, { error: "customizes too many layouts" });

/** The editable surface: what a create/update request or a JSON import may set. */
export const brandInputSchema = z.strictObject({
  name: z.string().trim().min(1, { error: "is required" }).max(80, { error: "is too long" }),
  colors: brandColorsSchema.default(DEFAULT_BRAND_COLORS),
  fonts: brandFontsSchema.default({
    heading: DEFAULT_HEADING_FONT_ID,
    body: DEFAULT_BODY_FONT_ID,
  }),
  logo: brandLogoSchema.optional(),
  tone: brandToneSchema.default({
    voice: DEFAULT_TONE_ID,
    traits: [],
    bannedWords: [...DEFAULT_BANNED_WORDS],
  }),
  templates: templatesSchema.default({}),
});

export type BrandInput = z.infer<typeof brandInputSchema>;

/**
 * A complete persisted brand. Used to validate what comes back off disk and what a JSON import
 * supplies wholesale — a round-tripped export includes `id`/timestamps, and rejecting them would
 * make export→import fail. The service still overwrites `id`/`userId`/`createdAt`, so these fields
 * being present in the payload is not a way to write into another user's brand.
 */
export const brandDefinitionSchema = brandInputSchema.extend({
  id: safeId,
  userId: safeId,
  createdAt: isoDate,
  updatedAt: isoDate,
});

/* ────────────────────────────── cross-checks ────────────────────────────── */

/** What the layout registry must tell us. Injected — see the header for why it isn't imported. */
export interface LayoutLookup {
  /** `undefined` when no layout has that id. */
  layout(layoutId: string): { slotKeys: readonly string[]; requiredSlotKeys: readonly string[] } | undefined;
}

export interface BrandValidationOptions {
  layouts?: LayoutLookup;
  /** Asset ids known to exist for this user. Omit to skip the "assets resolve" check. */
  knownAssetIds?: ReadonlySet<string>;
}

/** `path` is dotted so the brand editor can highlight the offending field (§12). */
export interface BrandIssue {
  path: string;
  message: string;
}

export type BrandValidation =
  | { ok: true; value: BrandDefinition }
  | { ok: false; issues: BrandIssue[] };

const formatPath = (path: readonly PropertyKey[]): string =>
  path.map((p) => (typeof p === "number" ? `[${p}]` : String(p)))
    .join(".")
    .replace(/\.\[/g, "[");

/** zod issues → field-level readable messages. */
export function toIssues(error: z.ZodError): BrandIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

/**
 * Cross-registry checks. Split out so the brand editor can run structural validation on every
 * keystroke and these only on save (they need the layout registry and an asset listing).
 */
function crossCheck(brand: BrandDefinition, options: BrandValidationOptions): BrandIssue[] {
  const issues: BrandIssue[] = [];
  const { layouts, knownAssetIds } = options;

  for (const [layoutId, template] of Object.entries(brand.templates)) {
    const base = `templates.${layoutId}`;

    if (layouts) {
      const layout = layouts.layout(layoutId);
      if (!layout) {
        issues.push({ path: base, message: "isn't a layout this app knows about" });
        // Without a layout there is nothing to check slot keys against; the asset check still runs.
      } else {
        const known = new Set(layout.slotKeys);
        template.zones.forEach((zone, index) => {
          if (!known.has(zone.slotKey)) {
            issues.push({
              path: `${base}.zones[${index}].slotKey`,
              message: `isn't a slot on the "${layoutId}" layout`,
            });
          }
        });
        // A template REPLACES the layout's defaultZones wholesale (SPEC §5 zone resolution), so an
        // omitted required slot means that content would have nowhere to go — silently invisible.
        const placed = new Set(template.zones.map((z_) => z_.slotKey));
        for (const required of layout.requiredSlotKeys) {
          if (!placed.has(required)) {
            issues.push({
              path: `${base}.zones`,
              message: `is missing a zone for the required "${required}" slot`,
            });
          }
        }
      }
    }

    if (knownAssetIds && template.backgroundAssetId !== undefined
      && !knownAssetIds.has(template.backgroundAssetId)) {
      issues.push({
        path: `${base}.backgroundAssetId`,
        message: "refers to an image that no longer exists",
      });
    }
  }

  if (knownAssetIds && brand.logo) {
    for (const role of ["light", "dark"] as const) {
      const id = brand.logo[role];
      if (id !== undefined && !knownAssetIds.has(id)) {
        issues.push({ path: `logo.${role}`, message: "refers to an image that no longer exists" });
      }
    }
  }

  return issues;
}

/**
 * Validate a complete brand: structure first, then cross-registry checks.
 *
 * Returns a result rather than throwing so callers can decide (a route maps to
 * `InvalidBrandConfig`; the editor renders per-field messages). Nothing is partially applied — on
 * any issue the caller gets no `value` at all (§12).
 */
export function validateBrand(input: unknown, options: BrandValidationOptions = {}): BrandValidation {
  const parsed = brandDefinitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error) };

  const value = parsed.data as BrandDefinition;
  const issues = crossCheck(value, options);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/** Same, for the editable subset (create/update request bodies). */
export function validateBrandInput(
  input: unknown, options: BrandValidationOptions = {},
): { ok: true; value: BrandInput } | { ok: false; issues: BrandIssue[] } {
  const parsed = brandInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error) };

  // Cross-checks only read fields the input already carries; the id/timestamps are irrelevant here.
  const issues = crossCheck(
    { ...parsed.data, id: "pending", userId: "pending", createdAt: "", updatedAt: "" },
    options,
  );
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: parsed.data };
}

/** `"colors.primary: must be a hex colour such as #1A3A6B"` — for logs and `InvalidBrandConfig`. */
export const describeIssues = (issues: readonly BrandIssue[]): string[] =>
  issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
