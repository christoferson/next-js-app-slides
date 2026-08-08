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
 */

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Download, Loader2, Play, Square, Wand2 } from "lucide-react";
import type { DeckMeta, Slide } from "@/lib/domain/deck";
import type { SlotValues } from "@/lib/domain/slots";
import type { BrandDefinition, DesignTokens } from "@/lib/brand/types";
import type { LayoutSummary } from "@/lib/layouts/registry";
import type { QualityFlag, StreamEvent } from "@/lib/stream/events";
import { unreadableOverBackground } from "@/lib/brand/background-luminance";
import { ApiError, api, streamGeneration } from "@/lib/client/api";
import { useResource } from "@/components/use-resource";
import { Button, Card, Empty, ErrorNote, Field, Flag, Input } from "@/components/ui/primitives";
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
      const [workspace, registry] = await Promise.all([
        api.decks.workspace<WorkspaceView>(deckId),
        api.registry.layouts<{ layouts: LayoutSummary[] }>(),
      ]);
      return { workspace, layouts: registry.layouts };
    }, [deckId]),
  );

  const [actionError, setActionError] = useState<ApiError | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  /** Live generation state; `undefined` when idle. */
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>();
  const abort = useRef<AbortController | undefined>(undefined);

  // Abort an in-flight generation when the user navigates away — otherwise the server keeps spending tokens
  // on a deck nobody is watching. §9's client-abort row is what makes this a requirement, not a nicety.
  useEffect(() => () => abort.current?.abort(), []);

  const view = data?.workspace;
  const layouts = data?.layouts ?? [];

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
      await streamGeneration(deckId, {}, onEvent, controller.signal);
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
          <div>
            <h1 className="text-xl font-semibold">{view.deck.title}</h1>
            <p className="text-sm text-ink-soft">
              {view.brand.name} · {view.slides.length} slide{view.slides.length === 1 ? "" : "s"}
              {" · "}
              <Link href={`/decks/${view.deck.id}/briefing`} className="underline">briefing</Link>
              {(view.deck.outline?.sections.length ?? 0) > 0 && (
                <>
                  {" · "}
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

/** The right-hand editing panel: slots, layout switcher, regenerate-with-instruction (§12). */
function SlidePanel(
  { slide, layouts, busy, onSlots, onLayout, onRegenerate }: {
    slide: Slide;
    layouts: readonly LayoutSummary[];
    busy: boolean;
    onSlots: (slots: SlotValues) => void;
    onLayout: (layoutId: string) => void;
    onRegenerate: (instruction: string) => void;
  },
) {
  // Initialized once per mount. The caller's `key` handles re-seeding — see its note there.
  const [draft, setDraft] = useState<SlotValues>(slide.slots);
  const [instruction, setInstruction] = useState("");

  const layout = layouts.find((l) => l.id === slide.layoutId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(slide.slots);

  return (
    <Card className="space-y-4 p-4">
      <Field label="Layout">
        <select
          value={slide.layoutId}
          onChange={(event) => onLayout(event.target.value)}
          disabled={busy}
          className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm disabled:opacity-50"
        >
          {layouts.map((l) => (
            <option key={l.id} value={l.id}>{l.displayName}</option>
          ))}
          {/* A stored slide can carry a layout this build no longer has. Keep it selectable rather than
              letting the select silently show — and then save — the first option instead. */}
          {layout === undefined && <option value={slide.layoutId}>{slide.layoutId} (unknown)</option>}
        </select>
      </Field>

      {layout !== undefined && (
        <SlotEditor slots={layout.slots} values={draft} onChange={setDraft} disabled={busy} />
      )}

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

      {slide.issue && (
        <p className="border-t border-line pt-3 text-xs text-ink-soft">{slide.issue.message}</p>
      )}
    </Card>
  );
}
