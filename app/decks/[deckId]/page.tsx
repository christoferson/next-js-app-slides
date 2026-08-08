"use client";

/**
 * The deck workspace (SPEC §9) — the screen where the whole pipeline becomes visible: briefing → outline →
 * generate (live) → edit → export.
 *
 * ## One aggregate read, not four
 *
 * Everything loads from `GET /api/decks/:id/workspace`. The facade composes deck + slides + brand + tokens +
 * templates there deliberately (see `StudioFacade.workspace`): four separate fetches can interleave with a
 * brand edit and produce a preview that matches nothing, and §8's guarantee is that the preview matches the
 * export. This screen therefore never assembles that payload itself, and re-reads the whole aggregate after
 * any mutation that could change tokens or zones.
 *
 * ## Generation is streamed, and the grid fills live
 *
 * `streamGeneration` is the single SSE choke point (§12). This component holds an `AbortController` so
 * navigating away or pressing Stop actually ends the job — §9's last row, "remaining slides stop; completed
 * slides persisted". A `slide-done` arrives before the next slide starts, so each arrival reloads the
 * aggregate rather than waiting for `deck-done`.
 *
 * ## Flags are never suppressed (§12)
 *
 * Every `slide.flags` entry renders as an amber `Flag`, and so do the brand's `tokens.notices` and the
 * background-luminance warning. A screen that filtered any of them would defeat the point of computing them.
 *
 * ## Five server capabilities that had no caller
 *
 * `decks.duplicateSlide`, `decks.removeSlide`, `decks.update` (title + brand swap), and `registry.models`
 * were all built, tested, and reachable from NO screen — the same shape as the `setSlideLayout` 405, which
 * hid in exactly that gap until a screen first called it. They are wired here, so §9's slide actions and
 * §13's "brand swap re-themes every slide with zero content change" are things a user can do rather than
 * things the API could do.
 *
 * The generation options (`density`, `includeSpeakerNotes`, `temperature`) are offered only because they are
 * plumbed end-to-end into `buildSlidePrompt`. `modelId` is NOT offered: nothing in the request schema accepts
 * one — which model runs is the server's decision from config — so a picker that appeared to choose would be
 * a lie. The models registry is surfaced read-only instead, with `verified: false` shown, since §1.2 measured
 * which ids this account can actually invoke.
 */

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Check, ChevronLeft, Copy, Download, Loader2, Pencil, Play, Square, Trash2, Wand2, X,
} from "lucide-react";
import type { BrandSummary } from "@/lib/brand/types";
import type { DeckMeta, Slide } from "@/lib/domain/deck";
import type { SlotValues } from "@/lib/domain/slots";
import type { BrandDefinition, DesignTokens } from "@/lib/brand/types";
import type { LayoutSummary } from "@/lib/layouts/registry";
import type { QualityFlag, StreamEvent } from "@/lib/stream/events";
import { unreadableOverBackground } from "@/lib/brand/background-luminance";
import { ApiError, api, streamGeneration } from "@/lib/client/api";
import { useResource } from "@/components/use-resource";
import {
  Button, Card, Empty, ErrorNote, Field, Flag, Input, Select, Textarea,
} from "@/components/ui/primitives";
import { SlidePreview } from "@/components/preview/slide-preview";
import { SlideGrid } from "@/components/workspace/slide-grid";
import { SlotEditor } from "@/components/workspace/slot-editor";

/**
 * Mirrors `StudioFacade`'s `WorkspaceView`. Declared structurally rather than imported: §5 forbids `app/**`
 * from importing `lib/facade`, and these fields are the wire contract.
 */
interface WorkspaceView {
  deck: DeckMeta;
  slides: Slide[];
  brand: BrandDefinition;
  tokens: DesignTokens;
  templates: {
    layoutId: string;
    mode: "templated" | "token-styled";
    zonesCustomized: boolean;
    backgroundAssetId?: string;
    backgroundLuminance?: number;
  }[];
  exportFormats: string[];
}

type Template = WorkspaceView["templates"][number];

/** `/api/registry/models` (SPEC §8). Read-only here — see the header on why there is no picker. */
interface ModelSummary {
  id: string;
  displayName: string;
  family: string;
  supportsTemperature: boolean;
  defaultTemperature?: number;
  verified: boolean;
}

/** SPEC §9's wizard step-4 options. Every field here reaches `buildSlidePrompt`; none is decorative. */
interface GenerateOptions {
  density: "concise" | "standard" | "detailed";
  includeSpeakerNotes: boolean;
  /** `undefined` = let the server use the model's default rather than sending a number we invented. */
  temperature: number | undefined;
}

const DEFAULT_OPTIONS: GenerateOptions = {
  density: "standard",
  includeSpeakerNotes: false,
  temperature: undefined,
};

/** Human text for each quality flag. The badge itself always shows; this is only its wording. */
const FLAG_TEXT: Record<QualityFlag, string> = {
  "trimmed": "Text was shortened to fit its box",
  "fallback": "Content came from the fallback renderer, not the model",
  "contrast-repaired": "A colour was adjusted to stay legible",
  "letterboxed": "A non-16:9 background was contained, not stretched",
};

export default function WorkspacePage({ params }: { params: Promise<{ deckId: string }> }) {
  const { deckId } = use(params);

  const { data, error: loadError, reload, set } = useResource(
    useCallback(async () => {
      // `brands` is the swap control's option list and `models` the generation panel's disclosure. Both are
      // small, cacheable reads that the screen cannot function without, so they join the aggregate rather
      // than arriving later and making the header change shape after first paint.
      const [workspace, registry, brands, models] = await Promise.all([
        api.decks.workspace<WorkspaceView>(deckId),
        api.registry.layouts<{ layouts: LayoutSummary[] }>(),
        api.brands.list<{ brands: BrandSummary[] }>(),
        api.registry.models<{ models: ModelSummary[]; defaultModelId: string }>(),
      ]);
      return {
        workspace,
        layouts: registry.layouts,
        brands: brands.brands,
        models: models.models,
        defaultModelId: models.defaultModelId,
      };
    }, [deckId]),
  );

  const [actionError, setActionError] = useState<ApiError | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [options, setOptions] = useState<GenerateOptions>(DEFAULT_OPTIONS);

  /** Live generation state; `undefined` when idle. */
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>();
  const abort = useRef<AbortController | undefined>(undefined);

  // Abort an in-flight generation when the user navigates away — otherwise the server keeps spending tokens
  // on a deck nobody is watching. §9's client-abort row is what makes this a requirement, not a nicety.
  useEffect(() => () => abort.current?.abort(), []);

  const view = data?.workspace;
  const layouts = data?.layouts ?? [];
  const brands = data?.brands ?? [];

  const selected = useMemo(
    () => view?.slides.find((s) => s.id === selectedId),
    [view, selectedId],
  );

  /** `SlidePreview`'s background prop for a layout, or `undefined` in token-styled mode. */
  const backgroundFor = useCallback((layoutId: string) => {
    const template = view?.templates.find((t) => t.layoutId === layoutId);
    if (!template?.backgroundAssetId) return undefined;
    return {
      url: api.assetUrl(template.backgroundAssetId),
      ...(template.backgroundLuminance !== undefined ? { luminance: template.backgroundLuminance } : {}),
    };
  }, [view]);

  /** Run a mutation with one busy key and one error sink. Reloads are the caller's choice. */
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

  const generateOutline = (): Promise<void> => run("outline", async () => {
    await api.decks.outline(deckId, {});
    reload();
  });

  /**
   * Start generation and consume the stream.
   *
   * Each terminal per-slide event reloads the aggregate. That is one extra request per slide, and it is the
   * right trade: the event carries only `{slideId, index, flags}`, so patching local state from it would mean
   * reconstructing slot content the client never received — inventing data to avoid a fetch.
   */
  const generate = async (): Promise<void> => {
    const controller = new AbortController();
    abort.current = controller;
    setActionError(undefined);
    setProgress({ done: 0, total: view?.deck.briefing?.targetSlideCount ?? 0 });

    const onEvent = (event: StreamEvent): void => {
      switch (event.type) {
        case "deck-start":
          setProgress({ done: 0, total: event.total });
          break;
        case "slide-done":
        case "slide-error":
          setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
          reload();
          break;
        case "fatal":
          // A `fatal` is data, not an exception (see `streamGeneration`): several slides may already have
          // succeeded, so it surfaces through the same ErrorNote without discarding them.
          setActionError(new ApiError(
            { code: event.code, message: event.message, retryable: event.retryable },
            200,
          ));
          break;
        default:
          break;   // slide-start, slide-delta, deck-done, ping — nothing to do beyond the reload above
      }
    };

    try {
      // Only non-default keys are sent. `generateSchema` is a `strictObject` whose fields are all optional,
      // so omitting one means "the server's default" — sending `temperature: undefined` explicitly would
      // serialize the key away anyway, but building the body this way keeps the intent legible.
      await streamGeneration(
        deckId,
        {
          density: options.density,
          includeSpeakerNotes: options.includeSpeakerNotes,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        },
        onEvent,
        controller.signal,
      );
      reload();
    } catch (cause) {
      // An abort is the user's own doing, not an error to report — but the deck did change, so reload.
      if (cause instanceof DOMException && cause.name === "AbortError") reload();
      else if (cause instanceof ApiError) setActionError(cause);
      else throw cause;
    } finally {
      abort.current = undefined;
      setProgress(undefined);
    }
  };

  const saveSlots = (slide: Slide, slots: SlotValues): Promise<void> =>
    run(`slide:${slide.id}`, async () => {
      await api.decks.updateSlide<Slide>(deckId, slide.id, { slots });
      // Reload rather than merging the response: `updateSlide` may truncate over-budget text and add a
      // `trimmed` flag, and the reloaded slide is what the export will use.
      reload();
    });

  const setLayout = (slide: Slide, layoutId: string): Promise<void> =>
    run(`slide:${slide.id}`, async () => {
      await api.decks.updateSlide<Slide>(deckId, slide.id, { layoutId });
      // A layout change can introduce a layout whose template/zones this screen has not resolved yet —
      // `templates` only covers the layouts the deck was using a moment ago.
      reload();
    });

  const regenerate = (slide: Slide, instruction: string): Promise<void> =>
    run(`slide:${slide.id}`, async () => {
      await api.decks.regenerateSlide(deckId, slide.id, instruction === "" ? {} : { instruction });
      reload();
    });

  const saveNotes = (slide: Slide, speakerNotes: string): Promise<void> =>
    run(`slide:${slide.id}`, async () => {
      // The empty string is a real value here, not a clear-to-absent: `patchSlideSchema` accepts it
      // deliberately because there is no other way to express "remove the notes".
      await api.decks.updateSlide<Slide>(deckId, slide.id, { speakerNotes });
      reload();
    });

  /**
   * Duplicate (§9's slide actions).
   *
   * The 201 response carries the new slide, and its id is used to select it — the copy is inserted directly
   * after the original, so without this the user has to find which of two identical thumbnails is the new
   * one. `reload` still runs because every later slide's `order` shifted by one.
   */
  const duplicate = (slide: Slide): Promise<void> =>
    run(`slide:${slide.id}`, async () => {
      const copy = await api.decks.duplicateSlide<Slide>(deckId, slide.id);
      reload();
      setSelectedId(copy.id);
    });

  /**
   * Delete a slide (§9).
   *
   * No confirmation dialog: the deck is regenerable, a single slide is cheap to lose, and a modal on every
   * delete trains people to dismiss modals. The selection is cleared first — a panel bound to a slide the
   * server no longer has would render stale content next to a grid that had moved on.
   */
  const removeSlide = (slide: Slide): Promise<void> =>
    run(`slide:${slide.id}`, async () => {
      await api.decks.removeSlide(deckId, slide.id);
      if (selectedId === slide.id) setSelectedId(undefined);
      reload();
    });

  const rename = (title: string): Promise<void> =>
    run("title", async () => {
      await api.decks.update<DeckMeta>(deckId, { title });
      reload();
    });

  /**
   * Brand swap (§13: "re-themes every slide with zero content change").
   *
   * `PATCH {brandId}` is not a meta write — the route routes it to `switchBrand` and answers with
   * `{deck, brand, tokens, templates}` rather than a bare `DeckMeta`, precisely so a client cannot end up
   * showing the new brand's NAME with the old brand's zones. That is the §8 divergence arriving through the
   * one action most likely to change every zone on screen, which is why this reloads the whole aggregate
   * instead of merging the response: the slides also need re-resolving against the new templates.
   */
  const swapBrand = (brandId: string): Promise<void> =>
    run("brand", async () => {
      await api.decks.update(deckId, { brandId });
      reload();
    });

  /**
   * Drag-reorder (§9, §12).
   *
   * Deliberately NOT routed through `run`: that helper sets a global `busy` key, which would disable the
   * whole grid for the length of the request and make a second drag impossible right after the first —
   * the interaction people actually perform when tidying a deck. `SlideGrid` already shows the dropped
   * position optimistically, so there is nothing to wait for visually.
   *
   * The response IS the authoritative list, so it replaces local state directly rather than triggering a
   * full aggregate reload: a reorder cannot change tokens, zones, or slot content — only `order` — so
   * re-reading the brand and templates would be a wasted round trip. `set` keeps the rest of the aggregate
   * untouched. On failure the grid falls back to `view.slides`, which is still the server's truth, so a
   * rejected permutation (`InvalidSlideOrder` from a stale client) visibly snaps back with the reason.
   */
  const reorder = async (orderedIds: string[]): Promise<void> => {
    setActionError(undefined);
    try {
      const { slides } = await api.decks.reorderSlides<{ slides: Slide[] }>(deckId, { orderedIds });
      data && set({ ...data, workspace: { ...data.workspace, slides } });
    } catch (cause) {
      if (cause instanceof ApiError) setActionError(cause);
      else throw cause;
    }
  };

  if (view === undefined) {
    return loadError
      ? <ErrorNote message={loadError.message} issues={loadError.issues} onRetry={reload} />
      : <Empty>Loading…</Empty>;
  }

  const error = actionError ?? loadError;
  const hasOutline = (view.deck.outline?.sections.length ?? 0) > 0;
  const generating = progress !== undefined;
  const ordered = [...view.slides].sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link href="/decks" className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink">
          <ChevronLeft aria-hidden className="size-3.5" />
          All decks
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <DeckTitle
              title={view.deck.title}
              busy={busy === "title"}
              onRename={(next) => void rename(next)}
            />
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-ink-soft">
              <BrandSwap
                brands={brands}
                currentId={view.deck.brandId}
                currentName={view.brand.name}
                busy={busy === "brand"}
                onSwap={(brandId) => void swapBrand(brandId)}
              />
              <span>· {view.slides.length} slide{view.slides.length === 1 ? "" : "s"} ·</span>
              <Link href={`/decks/${view.deck.id}/briefing`} className="underline">briefing</Link>
              {(view.deck.outline?.sections.length ?? 0) > 0 && (
                <>
                  <span>·</span>
                  <Link href={`/decks/${view.deck.id}/outline`} className="underline">outline</Link>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {generating
              ? (
                <Button variant="danger" onClick={() => abort.current?.abort()}>
                  <Square aria-hidden className="size-4" />
                  Stop
                </Button>
              )
              : (
                <Button
                  variant="primary"
                  onClick={() => void generate()}
                  disabled={!hasOutline || busy !== undefined}
                >
                  <Play aria-hidden className="size-4" />
                  Generate slides
                </Button>
              )}
            {view.slides.length > 0 && view.exportFormats.map((format) => (
              // A navigation, not a fetch: the browser handles `content-disposition` itself, which is why
              // this is an anchor rather than a Button building a blob.
              <a
                key={format}
                href={api.exportUrl(view.deck.id, format)}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3.5 text-sm font-medium hover:bg-canvas"
              >
                <Download aria-hidden className="size-4" />
                .{format}
              </a>
            ))}
          </div>
        </div>

        <BrandNotices tokens={view.tokens} templates={view.templates} />
      </header>

      {error && <ErrorNote message={error.message} issues={error.issues} />}

      {generating && (
        <Card className="flex items-center gap-3 p-3 text-sm">
          <Loader2 aria-hidden className="size-4 animate-spin text-ink-soft" />
          <span>
            Generating {progress.done}
            {progress.total > 0 && ` of ${progress.total}`} slide{progress.total === 1 ? "" : "s"}…
          </span>
        </Card>
      )}

      {!hasOutline && (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-medium">This deck has no outline yet</h2>
          <p className="text-sm text-ink-soft">
            {view.deck.briefing
              ? "Generate an outline from the briefing, then generate slides."
              : "Fill in the briefing first — the outline is generated from it."}
          </p>
          <div className="flex gap-2">
            <Link
              href={`/decks/${view.deck.id}/briefing`}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3.5 text-sm font-medium hover:bg-canvas"
            >
              {view.deck.briefing ? "Edit briefing" : "Add briefing"}
            </Link>
            {view.deck.briefing && (
              <Button variant="primary" onClick={() => void generateOutline()} disabled={busy !== undefined}>
                <Wand2 aria-hidden className="size-4" />
                {busy === "outline" ? "Working…" : "Generate outline"}
              </Button>
            )}
          </div>
        </Card>
      )}

      {hasOutline && !generating && (
        <GenerateOptionsPanel
          options={options}
          onChange={setOptions}
          models={data?.models ?? []}
          defaultModelId={data?.defaultModelId ?? ""}
        />
      )}

      {hasOutline && view.slides.length === 0 && !generating && (
        <Empty>Outline ready — press “Generate slides” to fill the deck.</Empty>
      )}

      {view.slides.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          {/*
            Ordered by `order`, the only field `reorderSlides` may rewrite. `SlideGrid` owns the drag
            interaction but holds no order state between drags — `ordered` stays the source of truth, which
            is why a rejected permutation snaps back to the server's answer rather than to a local guess.

            Reordering is disabled DURING generation: slides are being appended as the stream arrives, so a
            permutation computed from a partial deck would be rejected by the route anyway (it validates a
            full permutation), and the drag would fail for reasons the user cannot see.
          */}
          <SlideGrid
            items={ordered}
            keyOf={(slide) => slide.id}
            labelOf={(slide) => `Slide ${slide.order + 1}, ${slide.layoutId}`}
            onReorder={(orderedIds) => void reorder(orderedIds)}
            disabled={generating}
          >
            {(slide) => {
              const background = backgroundFor(slide.layoutId);
              return (
                <button
                  type="button"
                  onClick={() => setSelectedId(slide.id)}
                  aria-current={slide.id === selectedId}
                  className={
                    "block w-full space-y-1.5 rounded-lg border bg-surface p-1.5 text-left transition-colors "
                    + (slide.id === selectedId ? "border-ink" : "border-line hover:border-ink-soft")
                  }
                >
                  <SlidePreview
                    brand={view.brand}
                    tokens={view.tokens}
                    layoutId={slide.layoutId}
                    slots={slide.slots}
                    {...(background !== undefined ? { background } : {})}
                  />
                  <div className="flex flex-wrap items-center gap-1.5 px-1 pb-0.5">
                    <span className="text-xs text-ink-soft">{slide.order + 1}</span>
                    <span className="text-xs text-ink-soft">{slide.layoutId}</span>
                    {slide.flags.map((flag) => (
                      <Flag key={flag} title={FLAG_TEXT[flag]}>{flag}</Flag>
                    ))}
                    {slide.issue && <Flag title={slide.issue.message}>{slide.issue.reason}</Flag>}
                  </div>
                </button>
              );
            }}
          </SlideGrid>

          <aside className="lg:sticky lg:top-6 lg:self-start">
            {selected === undefined
              ? <Empty>Select a slide to edit it.</Empty>
              : (
                <SlidePanel
                  // The key is the reset mechanism: a different slide — or the SAME slide with newer server
                  // content, e.g. after a save truncated it — remounts the panel so its draft re-initializes
                  // from `slide.slots`. React's documented alternative to seeding state in an effect, and it
                  // avoids the extra render that pattern costs.
                  key={`${selected.id}:${selected.updatedAt}`}
                  slide={selected}
                  layouts={layouts}
                  busy={busy === `slide:${selected.id}`}
                  onSlots={(slots) => void saveSlots(selected, slots)}
                  onLayout={(layoutId) => void setLayout(selected, layoutId)}
                  onRegenerate={(instruction) => void regenerate(selected, instruction)}
                  onNotes={(notes) => void saveNotes(selected, notes)}
                  onDuplicate={() => void duplicate(selected)}
                  onDelete={() => void removeSlide(selected)}
                />
              )}
          </aside>
        </div>
      )}
    </div>
  );
}

/**
 * Brand-level amber badges (§12): contrast repairs, unmapped fonts, and the background-luminance warning.
 *
 * The luminance check runs HERE rather than server-side because it is a display question about the brand's
 * own declared colour, and `unreadableOverBackground` is pure — the same function the brand editor uses, on
 * the luminance `ResolvedTemplate` carries for exactly this purpose.
 */
function BrandNotices({ tokens, templates }: { tokens: DesignTokens; templates: Template[] }) {
  const unreadable = templates.filter((t) =>
    t.backgroundLuminance !== undefined
    && unreadableOverBackground(tokens.pairs.onBackground.fg, t.backgroundLuminance)
  );

  if (tokens.notices.length === 0 && unreadable.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tokens.notices.map((notice) => (
        <Flag key={notice.message} title={notice.message}>{notice.kind}</Flag>
      ))}
      {unreadable.map((t) => (
        <Flag
          key={t.layoutId}
          title={
            `On “${t.layoutId}”, the brand's text colour would be hard to read over this background image. `
            + "The export adjusts it automatically, and this preview shows the adjusted colour."
          }
        >
          background contrast · {t.layoutId}
        </Flag>
      ))}
    </div>
  );
}

/**
 * The deck title, inline-editable (§9's header).
 *
 * A read/edit toggle rather than an always-live input, for one reason: `PATCH {title}` on every keystroke
 * would be a write per character, and debouncing it introduces a window where navigating away loses the
 * last edit. An explicit commit makes "saved" unambiguous.
 *
 * The form's `onSubmit` is what makes Enter work, and Escape reverts — both are what people expect from an
 * inline rename, and neither is free with a bare input plus a button.
 */
function DeckTitle(
  { title, busy, onRename }: { title: string; busy: boolean; onRename: (title: string) => void },
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <h1 className="truncate text-xl font-semibold">{title}</h1>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Rename deck"
          onClick={() => { setDraft(title); setEditing(true); }}
        >
          <Pencil aria-hidden className="size-3.5" />
        </Button>
      </div>
    );
  }

  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    // An unchanged or emptied title is not a write. `title`'s schema rejects empty anyway, so sending it
    // would turn a no-op into a 400 the user cannot act on.
    if (next !== "" && next !== title) onRename(next);
  };

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => { event.preventDefault(); commit(); }}
    >
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }}
        disabled={busy}
        autoFocus
        aria-label="Deck title"
        className="max-w-xs text-lg font-semibold"
      />
      <Button size="sm" variant="primary" type="submit" disabled={busy} aria-label="Save title">
        <Check aria-hidden className="size-3.5" />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)} aria-label="Cancel rename">
        <X aria-hidden className="size-3.5" />
      </Button>
    </form>
  );
}

/**
 * The brand swap control (§13: "brand swap re-themes every slide with zero content change").
 *
 * Rendered as a `<select>` of the user's brands rather than a link to a picker, because the whole point is
 * that it is reversible in one gesture — the content does not change, so trying a brand and switching back
 * costs nothing.
 *
 * With only one brand there is nothing to swap to, so it renders as plain text. A disabled select showing a
 * single option invites a click that can never do anything.
 */
function BrandSwap(
  { brands, currentId, currentName, busy, onSwap }: {
    brands: readonly BrandSummary[];
    currentId: string;
    currentName: string;
    busy: boolean;
    onSwap: (brandId: string) => void;
  },
) {
  if (brands.length < 2) return <span>{currentName}</span>;

  return (
    <Select
      value={currentId}
      onChange={(event) => onSwap(event.target.value)}
      disabled={busy}
      aria-label="Brand"
      className="h-7 w-auto py-0 text-sm"
    >
      {brands.map((brand) => (
        <option key={brand.id} value={brand.id}>{brand.name}</option>
      ))}
      {/* The deck's brand may not be in the list if it was deleted between reads. Keeping it selectable
          means the control shows what the deck actually uses rather than silently displaying — and on the
          next change, writing — a different brand. */}
      {!brands.some((b) => b.id === currentId) && (
        <option value={currentId}>{currentName} (missing)</option>
      )}
    </Select>
  );
}

/**
 * SPEC §9's step-4 generation options.
 *
 * Every control here reaches the prompt: `density` selects a `DENSITY_GUIDANCE` block,
 * `includeSpeakerNotes` adds the notes field to the requested JSON shape, and `temperature` is
 * server-clamped per §8. A fourth control people expect — a model picker — is deliberately ABSENT:
 * `generateSchema` accepts no `modelId`, so the choice would not be honoured. The registry is shown
 * read-only instead, including `verified: false`, because §1.2 measured which ids this account can invoke and
 * a list that hid that would misrepresent what is available.
 *
 * Collapsed by default (`<details>`), since the defaults are the right answer for most decks and the panel
 * would otherwise push the grid down on every visit.
 */
function GenerateOptionsPanel(
  { options, onChange, models, defaultModelId }: {
    options: GenerateOptions;
    onChange: (next: GenerateOptions) => void;
    models: readonly ModelSummary[];
    defaultModelId: string;
  },
) {
  const active = models.find((m) => m.id === defaultModelId);
  // Only offered when the model that will actually run supports it — §8's "UI-gated" half. The server
  // clamps regardless, so this gate is about not showing a control that does nothing.
  const canSetTemperature = active?.supportsTemperature ?? false;

  return (
    <Card className="p-4">
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Generation options
          <span className="ml-2 font-normal text-ink-soft">
            {options.density}
            {options.includeSpeakerNotes && " · speaker notes"}
            {options.temperature !== undefined && ` · temp ${options.temperature.toFixed(1)}`}
          </span>
        </summary>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Density" hint="How much text each slide carries.">
            <Select
              value={options.density}
              onChange={(event) => onChange({
                ...options,
                density: event.target.value as GenerateOptions["density"],
              })}
            >
              <option value="concise">Concise</option>
              <option value="standard">Standard</option>
              <option value="detailed">Detailed</option>
            </Select>
          </Field>

          {canSetTemperature && (
            <Field
              label={`Temperature${options.temperature === undefined ? " (model default)" : ""}`}
              hint="Higher is more varied. Clamped by the server to the model's range."
            >
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                // An unset temperature shows the model's own default so the slider does not imply 0.
                value={options.temperature ?? active?.defaultTemperature ?? 0.7}
                onChange={(event) => onChange({ ...options, temperature: Number(event.target.value) })}
                className="w-full"
                aria-label="Temperature"
              />
            </Field>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={options.includeSpeakerNotes}
              onChange={(event) => onChange({ ...options, includeSpeakerNotes: event.target.checked })}
            />
            Ask for speaker notes
          </label>
        </div>

        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-soft">
          Generated by{" "}
          <span className="font-medium">{active?.displayName ?? defaultModelId}</span>
          {active !== undefined && !active.verified && (
            <> <Flag title="This model id has not been confirmed invocable in this account.">unverified</Flag></>
          )}
          . Which model runs is a server setting, not a per-deck choice.
        </p>
      </details>
    </Card>
  );
}

/**
 * The right-hand editing panel — §9's **Edit / Notes / Slide** tabs.
 *
 * Tabs rather than one long column: the three concerns are edited at different times (content while writing,
 * notes while rehearsing, layout and destructive actions rarely), and stacking them made the layout switcher
 * and Save button scroll apart from each other.
 *
 * The Edit tab's draft and the Notes tab's draft are separate state, and switching tabs does NOT discard
 * either — a tab is a view, not a form boundary. Both surface their own "unsaved changes" hint, because two
 * independent drafts with one shared indicator is how an edit gets silently lost.
 */
type PanelTab = "edit" | "notes" | "slide";

function SlidePanel(
  { slide, layouts, busy, onSlots, onLayout, onRegenerate, onNotes, onDuplicate, onDelete }: {
    slide: Slide;
    layouts: readonly LayoutSummary[];
    busy: boolean;
    onSlots: (slots: SlotValues) => void;
    onLayout: (layoutId: string) => void;
    onRegenerate: (instruction: string) => void;
    onNotes: (speakerNotes: string) => void;
    onDuplicate: () => void;
    onDelete: () => void;
  },
) {
  const [tab, setTab] = useState<PanelTab>("edit");
  // Initialized once per mount. The caller's `key` handles re-seeding — see its note there.
  const [draft, setDraft] = useState<SlotValues>(slide.slots);
  const [notes, setNotes] = useState(slide.speakerNotes ?? "");
  const [instruction, setInstruction] = useState("");

  const layout = layouts.find((l) => l.id === slide.layoutId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(slide.slots);
  const notesDirty = notes !== (slide.speakerNotes ?? "");

  return (
    <Card className="space-y-4 p-4">
      {/* `role="tablist"` with `aria-selected` rather than styled links: this switches a panel in place, so
          it is a tab set, and a screen reader should announce it as one. */}
      <div role="tablist" aria-label="Slide panel" className="flex gap-1 border-b border-line">
        {([
          ["edit", "Edit"],
          ["notes", notesDirty ? "Notes •" : "Notes"],
          ["slide", "Slide"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={
              "-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors "
              + (tab === id
                ? "border-ink text-ink"
                : "border-transparent text-ink-soft hover:text-ink")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "edit" && (
        <>
          {layout === undefined
            ? (
              <p className="text-xs text-ink-soft">
                This slide uses layout “{slide.layoutId}”, which this build does not have. Pick a layout on
                the Slide tab to edit its content.
              </p>
            )
            : <SlotEditor slots={layout.slots} values={draft} onChange={setDraft} disabled={busy} />}

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => onSlots(draft)} disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save"}
            </Button>
            {dirty && <span className="text-xs text-ink-soft">Unsaved changes</span>}
          </div>

          <div className="space-y-2 border-t border-line pt-4">
            <Field label="Regenerate with an instruction" hint="e.g. “punchier”, “add a concrete number”">
              <Input
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                disabled={busy}
                placeholder="punchier"
              />
            </Field>
            <Button onClick={() => onRegenerate(instruction.trim())} disabled={busy}>
              <Wand2 aria-hidden className="size-4" />
              Regenerate slide
            </Button>
          </div>
        </>
      )}

      {tab === "notes" && (
        <div className="space-y-2">
          <Field
            label="Speaker notes"
            hint="Exported into the .pptx notes pane. 600 characters max — the server rejects longer."
          >
            <Textarea
              rows={8}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={busy}
              placeholder="What to say while this slide is up."
            />
          </Field>
          <div className="flex items-center justify-between gap-2">
            <Button variant="primary" onClick={() => onNotes(notes)} disabled={busy || !notesDirty}>
              {busy ? "Saving…" : "Save notes"}
            </Button>
            {/* Amber past the budget, matching the slot editor's counter — and for the same reason: the
                server rejects a user's over-long text rather than truncating it, so the warning has to
                arrive before the save. */}
            <span className={notes.length > 600 ? "text-xs font-medium text-flag" : "text-xs text-ink-soft"}>
              {notes.length}/600
            </span>
          </div>
        </div>
      )}

      {tab === "slide" && (
        <div className="space-y-4">
          <Field label="Layout" hint="Content carries across — slots the new layout does not declare are kept.">
            <Select
              value={slide.layoutId}
              onChange={(event) => onLayout(event.target.value)}
              disabled={busy}
            >
              {layouts.map((l) => (
                <option key={l.id} value={l.id}>{l.displayName}</option>
              ))}
              {/* A stored slide can carry a layout this build no longer has. Keep it selectable rather than
                  letting the select silently show — and then save — the first option instead. */}
              {layout === undefined && <option value={slide.layoutId}>{slide.layoutId} (unknown)</option>}
            </Select>
          </Field>

          <div className="space-y-2 border-t border-line pt-4">
            <span className="text-xs font-medium text-ink-soft">Slide actions</span>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onDuplicate} disabled={busy}>
                <Copy aria-hidden className="size-3.5" />
                Duplicate
              </Button>
              <Button variant="danger" onClick={onDelete} disabled={busy}>
                <Trash2 aria-hidden className="size-3.5" />
                Delete
              </Button>
            </div>
            <p className="text-[11px] text-ink-soft/80">
              The copy is inserted right after this slide. Deleting closes the gap in the numbering.
            </p>
          </div>
        </div>
      )}

      {slide.issue && (
        <p className="border-t border-line pt-3 text-xs text-ink-soft">{slide.issue.message}</p>
      )}
    </Card>
  );
}
