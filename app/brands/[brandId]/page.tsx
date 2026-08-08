"use client";

/**
 * The brand editor (SPEC §5, §7) — colours, fonts, tone, per-layout backgrounds, and the numeric zone
 * table with its live preview.
 *
 * ## The screen §8 is written about
 *
 * "The user trusts the live preview; the export must match it." This is where that trust is established:
 * the user types `x: 8` into a table cell and believes the PPTX will place the title there. That holds
 * because the preview below the table renders through `SlidePreview` → `resolveZones` → `zoneToCssPercent`,
 * and the exporter renders through `resolveZones` → `zoneToInches` — one resolver, one set of percentages,
 * two conversions. This page does no geometry arithmetic of its own, and must not acquire any.
 *
 * The zone table edits a DRAFT brand held in this component, and the preview reads that same draft. So
 * edits reflect immediately (§12's first frontend note) without a round trip, and without a second copy of
 * the resolution rule — `resolveZones` is called with the draft rather than the saved brand.
 *
 * ## What is deliberately NOT enforced here
 *
 * Zone bounds. `slotZoneSchema` rejects `x + w > 100` with the error on `w`, and the server is the one
 * owner of that rule; a client-side clamp would be a second, subtly different implementation, and it would
 * fight the user mid-edit (typing `w: 60` into a zone at `x: 50` has to be possible on the way to moving
 * `x`). Out-of-bounds numbers are therefore *marked* — the row shows the overflow — and rejected on save
 * with the server's own field-level message.
 *
 * ## Save is a full replace
 *
 * `PUT /api/brands/:id` replaces the editable surface wholesale (see the route's note), so Save sends the
 * complete draft. Nothing here sends a partial config, and nothing applies a mutation optimistically that
 * could change `tokens`: contrast repair runs server-side in `compileTheme`, so after every save the
 * response's brand AND tokens replace the draft together. A preview showing repaired colours from one
 * revision over zones from another is the §8 drift this whole design exists to prevent.
 *
 * ## Amber badges are never suppressed (§12)
 *
 * Three appear on this screen: `tokens.notices` (contrast repair, unmapped font), the letterbox warning
 * for a non-16:9 background, and the unreadable-text-over-background warning. All three are computed from
 * server-supplied facts — `ResolvedTemplate.backgroundSize` and `backgroundLuminance` — because the browser
 * cannot read pixel dimensions or sample luminance out of a CSS background image.
 */

import { use, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Download, Trash2, Upload } from "lucide-react";
import type {
  BrandDefinition, BrandFonts, BrandTone, DesignTokens, LayoutTemplate, SlotZone,
} from "@/lib/brand/types";
import type { FontDescriptor } from "@/lib/brand/fonts";
import type { ToneDescriptor } from "@/lib/brand/tones";
import type { LayoutSummary } from "@/lib/layouts/registry";
import { unreadableOverBackground } from "@/lib/brand/background-luminance";
import { placeBackground } from "@/lib/layouts/background";
import { resolveZones } from "@/lib/layouts/render-mode";
import { sampleSlots } from "@/lib/layouts/sample-content";
import { ApiError, api } from "@/lib/client/api";
import { useResource } from "@/components/use-resource";
import { JsonImportField } from "@/components/brand/json-import";
import {
  Button, Card, Empty, ErrorNote, Field, Flag, Input, Select, Textarea, cn,
} from "@/components/ui/primitives";
import { SlidePreview } from "@/components/preview/slide-preview";

/**
 * `GET /api/brands/:id` plus the three registries, in the shape the wire delivers them.
 *
 * Declared structurally rather than imported from the facade: §5 forbids `app/**` importing
 * `lib/facade`, and these fields are the wire contract. `ResolvedTemplate`'s fields are re-declared for
 * the same reason.
 */
interface EditorData {
  brand: BrandDefinition;
  tokens: DesignTokens;
  layouts: LayoutSummary[];
  fonts: { fonts: FontDescriptor[]; all: FontDescriptor[] };
  tones: { tones: ToneDescriptor[]; defaultBannedWords: string[] };
  /** One per layout the brand has templated — the letterbox and luminance facts only the server has. */
  templates: {
    layoutId: string;
    backgroundAssetId?: string;
    backgroundLuminance?: number;
    backgroundSize?: { width: number; height: number };
  }[];
}

/** The editable surface `brandInputSchema` accepts — what Save sends, and what the JSON export shows. */
type BrandDraft = Pick<BrandDefinition, "name" | "colors" | "fonts" | "logo" | "tone" | "templates">;

const COLOR_KEYS = [
  "primary", "secondary", "accent", "background", "surface", "textOnLight", "textOnDark",
] as const;

const ALIGNS = ["left", "center", "right"] as const;
const VALIGNS = ["top", "middle", "bottom"] as const;

export default function BrandEditorPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = use(params);

  /**
   * One loader, four requests. Brand + tokens + resolved templates arrive TOGETHER from
   * `GET /api/brands/:id` — see that route's note on why they must not be separate reads — and the three
   * registries are immutable-per-deploy and cached by their routes, so batching them costs nothing and
   * gives the screen a single loading state rather than four. A font picker that populates a beat after
   * the palette is a worse experience than a slightly later page.
   */
  const { data, error: loadError, reload } = useResource(
    useCallback(async (): Promise<EditorData> => {
      const [theme, layouts, fonts, tones] = await Promise.all([
        api.brands.get<Pick<EditorData, "brand" | "tokens" | "templates">>(brandId),
        api.registry.layouts<{ layouts: LayoutSummary[] }>(),
        api.registry.fonts<EditorData["fonts"]>(),
        api.registry.tones<EditorData["tones"]>(),
      ]);
      return { ...theme, layouts: layouts.layouts, fonts, tones };
    }, [brandId]),
  );

  const [draft, setDraft] = useState<BrandDraft | undefined>();
  const [actionError, setActionError] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [selectedLayoutId, setSelectedLayoutId] = useState<string | undefined>();

  const saved = data?.brand;
  /**
   * The draft when one exists, else the server's copy. Every control reads THIS, so an unsaved edit and a
   * freshly loaded brand render through identical code — the alternative (seeding draft state from an
   * effect on load) is the pattern this codebase avoids everywhere else, and it desynchronizes the moment
   * a save returns a normalized value.
   */
  const current: BrandDraft | undefined = draft ?? (saved ? editable(saved) : undefined);
  const dirty = draft !== undefined;

  const edit = (patch: Partial<BrandDraft>): void => {
    setSavedAt(undefined);
    setDraft((existing) => {
      const base = existing ?? (saved ? editable(saved) : undefined);
      if (!base) return existing;
      return { ...base, ...patch };
    });
  };

  /** Run a mutation with one busy key and one error sink, as every other screen does. */
  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setActionError(undefined);
    try {
      await action();
    } catch (cause) {
      if (cause instanceof ApiError) setActionError(cause);
      else throw cause;
    } finally {
      setBusy(undefined);
    }
  };

  const save = (): Promise<void> => run("save", async () => {
    if (!current) return;
    await api.brands.update<BrandDefinition>(brandId, current);
    // Reload rather than `set` the response: the save changes `tokens` (contrast repair) and can change
    // what `resolveTemplate` reports, and the whole point of §8 is that those travel together.
    setDraft(undefined);
    setSavedAt(new Date().toISOString());
    reload();
  });

  const upload = (file: File, meta: { kind: "logo" | "background"; layoutId?: string }): Promise<void> =>
    run(`upload:${meta.layoutId ?? "logo"}`, async () => {
      // The upload ATTACHES server-side (`BrandService.addAsset` seeds zones from `defaultZones`), so an
      // unsaved draft would be silently overwritten by the reload below. Saving first is the honest order:
      // it is also what makes the seeded zone table the one the user then edits.
      if (dirty) await api.brands.update<BrandDefinition>(brandId, current);
      await api.brands.upload(brandId, file, meta);
      setDraft(undefined);
      reload();
    });

  const detach = (assetId: string, key: string): Promise<void> => run(`detach:${key}`, async () => {
    if (dirty) await api.brands.update<BrandDefinition>(brandId, current);
    await api.brands.removeAsset(brandId, assetId);
    setDraft(undefined);
    reload();
  });

  const importConfig = (parsed: unknown): Promise<void> => run("import", async () => {
    // Replaces THIS brand — `PUT :id/import`, not the collection POST, so the file cannot silently
    // create a duplicate the user then has to find and delete.
    await api.brands.importInto<BrandDefinition>(brandId, parsed);
    setDraft(undefined);
    reload();
  });

  if (!data || !current || !saved) {
    return loadError
      ? <ErrorNote message={loadError.message} issues={loadError.issues} onRetry={reload} />
      : <Empty>Loading…</Empty>;
  }

  const error = actionError ?? loadError;
  const selected = data.layouts.find((l) => l.id === selectedLayoutId) ?? data.layouts[0];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link href="/brands" className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink">
          <ChevronLeft aria-hidden className="size-3.5" />
          Brands
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{current.name}</h1>
            <p className="text-sm text-ink-soft">
              Colours, fonts, and tone apply to every deck on this brand. Zones apply per layout.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs text-flag">Unsaved changes</span>}
            {savedAt !== undefined && !dirty && <span className="text-xs text-ink-soft">Saved</span>}
            <Button variant="primary" onClick={() => void save()} disabled={busy !== undefined || !dirty}>
              {busy === "save" ? "Saving…" : "Save brand"}
            </Button>
          </div>
        </div>
      </header>

      {error && <ErrorNote message={error.message} issues={error.issues} />}

      {/* Brand-level amber badges, straight from the compiled theme. Never filtered (§12). */}
      {data.tokens.notices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.tokens.notices.map((notice) => (
            <Flag key={`${notice.kind}-${notice.message}`} title={notice.message}>
              {notice.kind === "contrast-repaired" ? "contrast repaired" : "font unavailable"}
            </Flag>
          ))}
        </div>
      )}
      {dirty && (
        <p className="text-xs text-ink-soft">
          Contrast and font warnings are recomputed by the server — save to refresh them.
        </p>
      )}

      <IdentitySection
        draft={current}
        fonts={data.fonts}
        tones={data.tones}
        onChange={edit}
      />

      <LogoSection
        draft={current}
        busy={busy}
        onUpload={(file) => void upload(file, { kind: "logo" })}
        onDetach={(assetId) => void detach(assetId, "logo")}
      />

      {selected && (
        <TemplateSection
          layouts={data.layouts}
          layout={selected}
          draft={current}
          tokens={data.tokens}
          templates={data.templates}
          busy={busy}
          onSelect={setSelectedLayoutId}
          onChange={edit}
          onUpload={(file) => void upload(file, { kind: "background", layoutId: selected.id })}
          onDetach={(assetId) => void detach(assetId, selected.id)}
        />
      )}

      <JsonSection brand={saved} busy={busy} onImport={(parsed) => void importConfig(parsed)} />
    </div>
  );
}

/** The stored brand reduced to what `brandInputSchema` accepts — ids and timestamps are the server's. */
function editable(brand: BrandDefinition): BrandDraft {
  return {
    name: brand.name,
    colors: brand.colors,
    fonts: brand.fonts,
    // Spread-with-optional: `logo` absent and `logo: undefined` are different to a `strictObject`.
    ...(brand.logo !== undefined ? { logo: brand.logo } : {}),
    tone: brand.tone,
    templates: brand.templates,
  };
}

/* ─────────────────────────────── identity: name, colours, fonts, tone ─────────────────────────────── */

function IdentitySection(
  { draft, fonts, tones, onChange }: {
    draft: BrandDraft;
    fonts: EditorData["fonts"];
    tones: EditorData["tones"];
    onChange: (patch: Partial<BrandDraft>) => void;
  },
) {
  return (
    <Card className="space-y-5 p-4">
      <Field label="Name" hint="Up to 80 characters.">
        <Input value={draft.name} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>

      <div>
        <h2 className="mb-2 text-sm font-medium">Colours</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {COLOR_KEYS.map((key) => (
            <ColorField
              key={key}
              label={key}
              value={draft.colors[key]}
              onChange={(hex) => onChange({ colors: { ...draft.colors, [key]: hex } })}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-soft">
          Text colours are paired with each surface and adjusted server-side if the contrast would fail
          accessibility — a repair shows as an amber badge above rather than being applied silently.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FontPicker
          label="Heading font"
          value={draft.fonts.heading}
          fonts={fonts}
          onChange={(id) => onChange({ fonts: { ...draft.fonts, heading: id } })}
        />
        <FontPicker
          label="Body font"
          value={draft.fonts.body}
          fonts={fonts}
          onChange={(id) => onChange({ fonts: { ...draft.fonts, body: id } })}
        />
      </div>

      <ToneEditor
        tone={draft.tone}
        tones={tones}
        onChange={(tone) => onChange({ tone })}
      />
    </Card>
  );
}

/**
 * A colour, editable as a swatch OR as text.
 *
 * Both, because neither alone is enough: `<input type="color">` cannot express "paste the hex from our
 * brand guidelines", and a text field alone makes picking a shade guesswork. The text field accepts
 * whatever the user types and normalizes only on save — the server canonicalizes `#fff` → `FFFFFF`
 * (`brand-schema.ts`'s note), so normalizing here too would be a second implementation of that rule.
 */
function ColorField(
  { label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void },
) {
  // The swatch input requires `#RRGGBB`; stored values are `#`-less canonical hex.
  const swatch = /^[0-9A-Fa-f]{6}$/.test(value) ? `#${value}` : "#000000";
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={swatch}
          onChange={(e) => onChange(e.target.value.slice(1).toUpperCase())}
          className="size-9 shrink-0 cursor-pointer rounded border border-line bg-surface p-0.5"
          aria-label={`${label} colour picker`}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </div>
    </Field>
  );
}

/**
 * The font picker — selectable faces, plus this brand's current face even when it is gated.
 *
 * A brand may already reference a `gated` font (gating is a *picker* policy, not a validity rule — see
 * `lib/brand/fonts.ts`), and omitting it from the list would silently reset the user's font to whatever
 * the browser picked as the first option the moment they touched anything else. It is therefore rendered
 * as a disabled option with its `note` visible, so the state is legible and one-way: keep it, or move to
 * a ratified face.
 */
function FontPicker(
  { label, value, fonts, onChange }: {
    label: string; value: string; fonts: EditorData["fonts"]; onChange: (id: string) => void;
  },
) {
  const selectable = fonts.fonts;
  const current = fonts.all.find((f) => f.id === value);
  const isGated = current !== undefined && !selectable.some((f) => f.id === current.id);

  return (
    <Field label={label} {...(isGated && current.note !== undefined ? { hint: current.note } : {})}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {isGated && (
          <option value={current.id} disabled>
            {current.displayName} — not offered for new brands
          </option>
        )}
        {selectable.map((font) => (
          <option key={font.id} value={font.id}>{font.displayName}</option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Tone: a registry voice, plus free-text traits and banned words.
 *
 * `voice` is a closed set on purpose — it is the ONE brand field that reaches a prompt (§7), so the text
 * sent to the model is authored by us. The `promptFragment` is shown verbatim for the same reason the
 * registry route serves it: the user should be able to read exactly what steers the model.
 *
 * Traits and banned words are comma-separated text rather than chip widgets. They are short lists edited
 * rarely, and a comma-separated field is directly pasteable from a brand guidelines doc — which is how
 * these actually arrive.
 */
function ToneEditor(
  { tone, tones, onChange }: {
    tone: BrandTone; tones: EditorData["tones"]; onChange: (tone: BrandTone) => void;
  },
) {
  const voice = tones.tones.find((t) => t.id === tone.voice);

  return (
    <div className="space-y-3">
      <Field label="Voice" hint={voice?.description}>
        <Select value={tone.voice} onChange={(e) => onChange({ ...tone, voice: e.target.value })}>
          {tones.tones.map((t) => (
            <option key={t.id} value={t.id}>{t.displayName}</option>
          ))}
        </Select>
      </Field>

      {voice && (
        <p className="rounded-md border border-line bg-canvas p-2.5 text-xs text-ink-soft">
          <span className="font-medium">Sent to the model: </span>
          {voice.promptFragment}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Traits" hint="Comma-separated. Up to 12, 40 characters each.">
          <Input
            value={tone.traits.join(", ")}
            onChange={(e) => onChange({ ...tone, traits: splitList(e.target.value) })}
            placeholder="direct, quantified, warm"
          />
        </Field>
        <Field label="Banned words" hint="Comma-separated. The model is told to avoid these.">
          <Input
            value={tone.bannedWords.join(", ")}
            onChange={(e) => onChange({ ...tone, bannedWords: splitList(e.target.value) })}
            placeholder="synergy, leverage, disrupt"
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * `"a, b,, c "` → `["a", "b", "c"]`.
 *
 * Empty entries are dropped rather than sent: the schema requires each entry be at least one character
 * after trimming, so a trailing comma while typing would otherwise turn into a validation error on save
 * for something the user was in the middle of doing.
 */
const splitList = (raw: string): string[] =>
  raw.split(",").map((part) => part.trim()).filter((part) => part !== "");

/* ─────────────────────────────── logo ─────────────────────────────── */

function LogoSection(
  { draft, busy, onUpload, onDetach }: {
    draft: BrandDraft; busy: string | undefined;
    onUpload: (file: File) => void; onDetach: (assetId: string) => void;
  },
) {
  const logoId = draft.logo?.light;
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-medium">Logo</h2>
        <p className="text-xs text-ink-soft">PNG, JPEG, or SVG. Placed by layouts that declare a slot for it.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {logoId !== undefined && (
          // A plain `<img>`, not `next/image`: `/api/assets/:id` is an authenticated, user-scoped route, and
          // the optimizer fetches source images from its own server context — so it would either fail to
          // authenticate or, worse, cache one user's logo under a URL derived only from the asset id.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={api.assetUrl(logoId)}
            alt="Brand logo"
            className="h-12 rounded border border-line bg-surface object-contain p-1"
          />
        )}
        <FilePicker
          label={logoId === undefined ? "Upload logo" : "Replace logo"}
          busy={busy === "upload:logo"}
          disabled={busy !== undefined}
          onPick={onUpload}
        />
        {logoId !== undefined && (
          <Button
            variant="danger"
            size="sm"
            disabled={busy !== undefined}
            onClick={() => onDetach(logoId)}
          >
            <Trash2 aria-hidden className="size-3.5" />
            Remove
          </Button>
        )}
      </div>
    </Card>
  );
}

/* ─────────────────────────────── templates: zones + background ─────────────────────────────── */

function TemplateSection(
  { layouts, layout, draft, tokens, templates, busy, onSelect, onChange, onUpload, onDetach }: {
    layouts: LayoutSummary[];
    layout: LayoutSummary;
    draft: BrandDraft;
    tokens: DesignTokens;
    templates: EditorData["templates"];
    busy: string | undefined;
    onSelect: (layoutId: string) => void;
    onChange: (patch: Partial<BrandDraft>) => void;
    onUpload: (file: File) => void;
    onDetach: (assetId: string) => void;
  },
) {
  const template = draft.templates[layout.id];
  const resolved = templates.find((t) => t.layoutId === layout.id);

  /**
   * THE §8 line. Both this preview and `toPptx` get their zones from `resolveZones`, and the argument
   * here is the DRAFT — so a number typed into the table is on screen before any round trip, without a
   * second copy of the brand-template-or-default rule.
   *
   * `resolveZones` takes only `Pick<BrandDefinition, "templates">`, which is exactly why a draft can be
   * passed: the resolver never needed a whole persisted brand.
   */
  const zones = useMemo(
    () => resolveZones({ templates: draft.templates }, layout).zones,
    [draft.templates, layout],
  );

  const customized = (draft.templates[layout.id]?.zones.length ?? 0) > 0;
  const slots = useMemo(() => sampleSlots(layout.slots), [layout.slots]);

  /**
   * Write the whole zone list back as this layout's template.
   *
   * A template REPLACES the layout's defaults wholesale (SPEC §5, and `resolveZones`' own note on why
   * merging would be worse), so the first edit to an uncustomized layout persists the full resolved list
   * — not just the row that changed. Anything else would save a partial template that `crossCheck`
   * correctly rejects for missing a required slot's zone.
   */
  const writeZones = (next: SlotZone[]): void => {
    const existing = draft.templates[layout.id];
    const updated: LayoutTemplate = {
      ...(existing?.backgroundAssetId !== undefined
        ? { backgroundAssetId: existing.backgroundAssetId }
        : {}),
      zones: next,
    };
    onChange({ templates: { ...draft.templates, [layout.id]: updated } });
  };

  const setZone = (slotKey: string, patch: Partial<SlotZone>): void =>
    writeZones(zones.map((z) => (z.slotKey === slotKey ? { ...z, ...patch } : z)));

  /**
   * Drop this layout's customization entirely, so it falls back to `defaultZones`.
   *
   * The template KEY is removed rather than its `zones` emptied. An empty array would validate as a
   * template that positions nothing, and `crossCheck` would reject it for missing every required slot's
   * zone — while `resolveZones` treats a zero-length list as uncustomized anyway. Removing the key says
   * what is meant. The background is preserved if there is one: resetting positions is not the same
   * request as detaching an image.
   */
  const resetZones = (): void => {
    const existing = draft.templates[layout.id];
    const rest = Object.fromEntries(
      Object.entries(draft.templates).filter(([id]) => id !== layout.id),
    );
    onChange({
      templates: existing?.backgroundAssetId !== undefined
        ? { ...rest, [layout.id]: { backgroundAssetId: existing.backgroundAssetId, zones: [] } }
        : rest,
    });
  };

  const backgroundUrl = template?.backgroundAssetId !== undefined
    ? api.assetUrl(template.backgroundAssetId)
    : undefined;

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Layout" hint={layout.description}>
          <Select value={layout.id} onChange={(e) => onSelect(e.target.value)}>
            {layouts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.displayName}
                {draft.templates[l.id]?.backgroundAssetId !== undefined ? " · templated" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-2">
          <FilePicker
            label={backgroundUrl === undefined ? "Upload background" : "Replace background"}
            busy={busy === `upload:${layout.id}`}
            disabled={busy !== undefined}
            onPick={onUpload}
          />
          {template?.backgroundAssetId !== undefined && (
            <Button
              variant="danger"
              size="sm"
              disabled={busy !== undefined}
              onClick={() => onDetach(template.backgroundAssetId!)}
            >
              <Trash2 aria-hidden className="size-3.5" />
              Remove background
            </Button>
          )}
        </div>
      </div>

      <BackgroundWarnings tokens={tokens} resolved={resolved} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Zones</h2>
            <Button size="sm" variant="ghost" onClick={resetZones} disabled={!customized}>
              Reset to layout defaults
            </Button>
          </div>
          <ZoneTable
            zones={zones}
            slots={layout.slots}
            onChange={setZone}
          />
          <p className="text-xs text-ink-soft">
            Percentages of the slide, not inches — the export converts them exactly. A box that runs past
            an edge is marked here and rejected on save.
          </p>
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-medium">Preview</h2>
          {/* The §8 twin of the exported slide: same zones, same tokens, same painter. */}
          <SlidePreview
            brand={{ templates: draft.templates }}
            tokens={tokens}
            layoutId={layout.id}
            slots={slots}
            {...(backgroundUrl !== undefined
              ? {
                background: {
                  url: backgroundUrl,
                  ...(resolved?.backgroundLuminance !== undefined
                    ? { luminance: resolved.backgroundLuminance }
                    : {}),
                  // `contain` mirrors the exporter's documented letterbox choice (§8) — but only when the
                  // image is actually non-16:9, because `placeBackground` snaps a near-16:9 image to
                  // full-bleed and a `contain` preview of one would show hairline bars the export has not.
                  ...(letterboxed(resolved) ? { contain: true } : {}),
                },
              }
              : {})}
          />
          <p className="text-xs text-ink-soft">
            Placeholder text sized to each slot&apos;s character budget, so a zone that is too small shows
            it here rather than in the exported deck.
          </p>
        </div>
      </div>
    </Card>
  );
}

/** Whether this background will be letterboxed on export — the §12 badge condition, computed once. */
function letterboxed(resolved: EditorData["templates"][number] | undefined): boolean {
  const size = resolved?.backgroundSize;
  // No intrinsic dimensions (SVG) means nothing to letterbox against; the exporter treats it as
  // full-bleed, and `placeBackground` is not consulted at all.
  return size !== undefined && placeBackground(size).letterboxed;
}

/**
 * The two background badges §12 requires on this screen.
 *
 * Both are computed from server-supplied facts through the SAME functions the export path uses —
 * `placeBackground` for the letterbox decision and `unreadableOverBackground` for the contrast one — so
 * the warning cannot disagree with what the exporter does.
 */
function BackgroundWarnings(
  { tokens, resolved }: { tokens: DesignTokens; resolved: EditorData["templates"][number] | undefined },
) {
  const size = resolved?.backgroundSize;
  const isLetterboxed = letterboxed(resolved);
  const unreadable = resolved?.backgroundLuminance !== undefined
    && unreadableOverBackground(tokens.pairs.onBackground.fg, resolved.backgroundLuminance);

  if (!isLetterboxed && !unreadable) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {isLetterboxed && size && (
        <Flag
          title={
            `This image is ${size.width}×${size.height}, which is not 16:9. It will be centred with bars `
            + "in the brand's background colour rather than stretched — a 16:9 image avoids them."
          }
        >
          letterboxed · {size.width}×{size.height}
        </Flag>
      )}
      {unreadable && (
        <Flag
          title={
            "The brand's text colour would be hard to read over this image. The server adjusts it for "
            + "rendering, but a background with more even contrast is the better fix."
          }
        >
          background contrast
        </Flag>
      )}
    </div>
  );
}

/**
 * The numeric zone table — §12's "numeric edits reflect in the live preview immediately".
 *
 * One row per resolved zone, in the layout's own slot order rather than the zone array's, so the table
 * reads the same way the slide does and a reordered brand template does not shuffle the rows.
 *
 * Out-of-bounds values are marked, not blocked — see the page header for why the server owns that rule.
 */
function ZoneTable(
  { zones, slots, onChange }: {
    zones: SlotZone[];
    slots: LayoutSummary["slots"];
    onChange: (slotKey: string, patch: Partial<SlotZone>) => void;
  },
) {
  const ordered = slots
    .map((spec) => zones.find((z) => z.slotKey === spec.key))
    .filter((zone): zone is SlotZone => zone !== undefined);
  // A zone whose slot the layout no longer declares — reachable from a stored brand. Shown last rather
  // than hidden: `crossCheck` will reject it on save, so silently omitting it would make that error
  // unexplainable.
  const orphans = zones.filter((z) => !slots.some((s) => s.key === z.slotKey));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-ink-soft">
          <tr>
            <th scope="col" className="py-1 pr-2 font-medium">Slot</th>
            {(["x", "y", "w", "h"] as const).map((axis) => (
              <th key={axis} scope="col" className="py-1 pr-2 font-medium">{axis} %</th>
            ))}
            <th scope="col" className="py-1 pr-2 font-medium">Align</th>
            <th scope="col" className="py-1 font-medium">V-align</th>
          </tr>
        </thead>
        <tbody>
          {[...ordered, ...orphans].map((zone) => {
            const spec = slots.find((s) => s.key === zone.slotKey);
            const overflowX = zone.x + zone.w > 100;
            const overflowY = zone.y + zone.h > 100;
            return (
              <tr key={zone.slotKey} className="border-t border-line">
                <th scope="row" className="py-1.5 pr-2 font-normal">
                  <span title={spec?.description ?? "This slot is not on this layout."}>
                    {zone.slotKey}
                  </span>
                  {spec?.required === true && <span className="ml-1 text-red-600" title="Required">*</span>}
                  {spec === undefined && <Flag title="This layout has no such slot.">unknown slot</Flag>}
                </th>
                {(["x", "y", "w", "h"] as const).map((axis) => (
                  <td key={axis} className="py-1 pr-2">
                    <NumberCell
                      label={`${zone.slotKey} ${axis}`}
                      value={zone[axis]}
                      invalid={(axis === "w" && overflowX) || (axis === "h" && overflowY)
                        || (axis === "x" && overflowX) || (axis === "y" && overflowY)}
                      onChange={(value) => onChange(zone.slotKey, { [axis]: value })}
                    />
                  </td>
                ))}
                <td className="py-1 pr-2">
                  <SelectCell
                    label={`${zone.slotKey} align`}
                    value={zone.align}
                    options={ALIGNS}
                    onChange={(align) => onChange(zone.slotKey, { align })}
                  />
                </td>
                <td className="py-1">
                  <SelectCell
                    label={`${zone.slotKey} vertical align`}
                    value={zone.valign}
                    options={VALIGNS}
                    onChange={(valign) => onChange(zone.slotKey, { valign })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One numeric zone cell.
 *
 * A blank or non-numeric entry keeps the previous value rather than sending `NaN`: `percent` requires a
 * finite number, so a field emptied on the way to retyping it would otherwise be a validation error for
 * a keystroke. Same reasoning as the briefing form's slide count.
 */
function NumberCell(
  { label, value, invalid, onChange }: {
    label: string; value: number; invalid: boolean; onChange: (value: number) => void;
  },
) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step={0.5}
      min={0}
      max={100}
      value={value}
      aria-label={label}
      aria-invalid={invalid}
      onChange={(e) => {
        if (!Number.isNaN(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);
      }}
      className={cn(
        "w-16 rounded border bg-surface px-1.5 py-1 text-xs text-ink",
        invalid ? "border-flag text-flag" : "border-line",
      )}
      {...(invalid ? { title: "This box runs past the edge of the slide." } : {})}
    />
  );
}

function SelectCell<T extends string>(
  { label, value, options, onChange }: {
    label: string; value: T; options: readonly T[]; onChange: (value: T) => void;
  },
) {
  return (
    <Select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as T)}
      // Compact: this sits inside the zone table's dense rows, so it overrides the shared padding.
      className="w-auto rounded px-1 text-xs"
    >
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </Select>
  );
}

/* ─────────────────────────────── JSON export / import ─────────────────────────────── */

/**
 * Export and re-import (§11 step 3, §12).
 *
 * Export shows the SAVED brand, not the draft — the round-trip guarantee is about what the server stored,
 * and a file exported from unsaved edits would re-import as something the user never saved.
 *
 * The import control itself is `JsonImportField`, shared with the gallery's create-from-JSON flow. The two
 * differ only in their target (replace this brand vs create a new one); when the gallery's flow was built,
 * keeping a second copy of the parse/clear/error behaviour here would have been the same mistake as the
 * eleven hand-copied field class strings — three of which had silently drifted.
 */
function JsonSection(
  { brand, busy, onImport }: {
    brand: BrandDefinition; busy: string | undefined; onImport: (parsed: unknown) => void;
  },
) {
  const exported = useMemo(() => JSON.stringify(brand, null, 2), [brand]);

  const download = (): void => {
    // A blob URL rather than a data URI: a brand config with several templates exceeds what some browsers
    // accept in a URL, and the blob is revoked immediately after the click.
    const url = URL.createObjectURL(new Blob([exported], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `brand-${brand.name.replace(/[^a-zA-Z0-9-_]+/g, "-").toLowerCase()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Config JSON</h2>
          <p className="text-xs text-ink-soft">
            Export to share this brand; import to replace it. Round-trips exactly.
          </p>
        </div>
        <Button size="sm" onClick={download}>
          <Download aria-hidden className="size-3.5" />
          Export JSON
        </Button>
      </div>

      <details>
        <summary className="cursor-pointer text-xs text-ink-soft hover:text-ink">
          Show the saved config
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2.5 text-[11px] leading-relaxed">
          {exported}
        </pre>
      </details>

      <JsonImportField
        label="Import"
        hint="Replaces every field of this brand. Nothing is applied if it is invalid."
        submitLabel="Replace this brand"
        pendingLabel="Importing…"
        busy={busy !== undefined}
        onSubmit={onImport}
      />
    </Card>
  );
}

/* ─────────────────────────────── file input ─────────────────────────────── */

/**
 * A file input styled as a button.
 *
 * `accept` mirrors SPEC §5's allowlist as a *hint* only — the server decides from the file's own
 * signature (`checkAssetBytes`), and an `accept` attribute is trivially bypassed, so treating it as
 * enforcement would be a security mistake rather than a convenience.
 *
 * The input is cleared after each pick so choosing the same file twice fires `change` again — otherwise a
 * failed upload cannot be retried with the identical file.
 */
function FilePicker(
  { label, busy, disabled, onPick }: {
    label: string; busy: boolean; disabled: boolean; onPick: (file: File) => void;
  },
) {
  return (
    <label
      className={cn(
        "inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface",
        "px-2.5 text-xs font-medium text-ink hover:bg-canvas",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <Upload aria-hidden className="size-3.5" />
      {busy ? "Uploading…" : label}
      <input
        type="file"
        accept="image/png,image/jpeg,image/svg+xml"
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onPick(file);
        }}
      />
    </label>
  );
}
