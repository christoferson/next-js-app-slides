"use client";

/**
 * The outline editor (SPEC §7.1, §7.2) — the deck's *plan*, before any slide content exists.
 *
 * ## Why this screen is separate from the workspace
 *
 * The workspace edits generated slides; this edits what the generator will be asked for. Those are
 * different units of work with different costs: rewording a slide's `message` here changes one upcoming
 * model call, and doing it after generation means throwing away a slide that already rendered. Keeping the
 * plan editable on its own screen is what makes the cheap fix the obvious one.
 *
 * ## One read, and it comes composed
 *
 * `GET /api/decks/:id/outline` returns plan + advisories + mapping preview in ONE service call
 * (`OutlineService.view`). This screen must not assemble that from three requests: a concurrent
 * regenerate landing between them leaves mapping badges explaining slides that are no longer on screen.
 *
 * ## Two write paths, deliberately not one
 *
 *   - **The document** (`PATCH …/outline`) — text edits, reorder, delete. Sent whole, because the server's
 *     zod is the authority on the shape and a partial patch would need a second copy of it (§4).
 *   - **One slide's layout pin** (`PUT …/sections/:si/slides/:li/layout`) — a single click, written
 *     targeted. Round-tripping the whole outline to serve it would make every concurrent edit a
 *     lost-update race, which is the route's own documented reason for existing.
 *
 * A pin therefore applies immediately while text edits stay in a local draft until Save. That asymmetry is
 * visible in the UI (the pin has no dirty state; the text does) rather than hidden.
 *
 * ## Flags and advisories are never suppressed (§12)
 *
 * Every `advisories[]` entry renders as an amber `Flag` next to the regenerate control, and every row's
 * `rule`/`reason` renders as its mapping badge. Both are the "why" the user needs in order to decide
 * whether to override — filtering either would leave the layout choice unexplained.
 */

import { use, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronUp, RotateCcw, Trash2, Wand2 } from "lucide-react";
import type { Outline, OutlineSlide, VisualHint } from "@/lib/domain/deck";
import { ApiError, api } from "@/lib/client/api";
import { useResource } from "@/components/use-resource";
import { Button, Card, Empty, ErrorNote, Field, Flag, Input } from "@/components/ui/primitives";

/**
 * Mirrors `OutlineService.view`'s return. Declared structurally rather than imported: §5 forbids `app/**`
 * from importing `lib/facade` or `lib/services`, and these fields are the wire contract.
 */
interface OutlineView {
  outline: Outline;
  advisories: { kind: string; message: string }[];
  repaired: boolean;
  preview: {
    index: number;
    question: string;
    visualHint: VisualHint;
    layoutId: string;
    layoutDisplayName: string;
    rule: "user-override" | "positional" | "intent-match" | "fallback";
    reason: string;
    overridden: boolean;
    sectionHeading?: string;
    options: { id: string; displayName: string; description: string; recommended: boolean }[];
  }[];
}

type PreviewRow = OutlineView["preview"][number];

export default function OutlinePage({ params }: { params: Promise<{ deckId: string }> }) {
  const { deckId } = use(params);

  const { data: view, error: loadError, reload } = useResource(
    useCallback(() => api.decks.outlineView<OutlineView>(deckId), [deckId]),
  );

  const [actionError, setActionError] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  /**
   * The edited document, or `undefined` while it matches the server's.
   *
   * `undefined` rather than "a copy plus a dirty boolean": the copy is what goes stale when a regenerate
   * or a pin reloads the view, and a boolean alongside it can disagree with its contents. Absent means
   * "render the server's outline", which is unambiguous.
   */
  const [draft, setDraft] = useState<Outline | undefined>();
  const outline = draft ?? view?.outline;

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

  /** Regenerate the whole plan, or one section when `sectionIndex` is given (SPEC §7.1's body). */
  const regenerate = (instruction: string, sectionIndex?: number): Promise<void> =>
    run(sectionIndex === undefined ? "outline" : `section:${sectionIndex}`, async () => {
      await api.decks.outline(deckId, {
        ...(instruction !== "" ? { instruction } : {}),
        ...(sectionIndex !== undefined ? { sectionIndex } : {}),
      });
      // The generated plan replaces the draft outright. Merging would mean deciding which of two
      // divergent documents owns each slide, and the user asked for a new one.
      setDraft(undefined);
      reload();
    });

  const save = (): Promise<void> => run("save", async () => {
    if (draft === undefined) return;
    await api.decks.saveOutline(deckId, { outline: draft });
    // Dropped BEFORE the reload: the server normalizes (trims, drops empty sections), and keeping the
    // draft would type the un-normalized version straight back over it on the next save.
    setDraft(undefined);
    reload();
  });

  /**
   * Pin or clear one slide's layout.
   *
   * Applied against the SERVER's indices, so it is refused while a draft exists — an unsaved reorder means
   * the position the user clicked is not the position the server would write. Saving first is the honest
   * resolution, and the button says so.
   */
  const setLayout = (sectionIndex: number, slideIndex: number, layoutId: string | null): Promise<void> =>
    run(`layout:${sectionIndex}.${slideIndex}`, async () => {
      await api.decks.setSlideLayout(deckId, sectionIndex, slideIndex, { layoutId });
      reload();
    });

  /* ── pure draft edits ── */

  const editSlide = (
    sectionIndex: number, slideIndex: number, patch: Partial<OutlineSlide>,
  ): void => setDraft(mapSlide(outline, sectionIndex, slideIndex, (s) => ({ ...s, ...patch })));

  const deleteSlide = (sectionIndex: number, slideIndex: number): void =>
    setDraft(withSections(outline, (sections) =>
      sections.map((section, si) =>
        si !== sectionIndex
          ? section
          : { ...section, slides: section.slides.filter((_, li) => li !== slideIndex) })));

  /** Move within a section only. Cross-section moves are a reorder the section headings would have to
   *  explain, and "delete here, retype there" is clearer than a drag whose destination is ambiguous. */
  const moveSlide = (sectionIndex: number, slideIndex: number, delta: number): void =>
    setDraft(withSections(outline, (sections) =>
      sections.map((section, si) => {
        if (si !== sectionIndex) return section;
        const target = slideIndex + delta;
        if (target < 0 || target >= section.slides.length) return section;
        const slides = [...section.slides];
        const [moved] = slides.splice(slideIndex, 1);
        slides.splice(target, 0, moved!);
        return { ...section, slides };
      })));

  const editHeading = (sectionIndex: number, heading: string): void =>
    setDraft(withSections(outline, (sections) =>
      sections.map((section, si) => (si === sectionIndex ? { ...section, heading } : section))));

  /**
   * `preview` is indexed by the SERVER's outline, so a row is only meaningful for a slide the server
   * knows about at the same position. While a draft exists the badges are hidden rather than shown
   * against the wrong slide — a mapping badge that explains a different slide is worse than none.
   *
   * Computed before the loading early-return, because hooks may not be called conditionally.
   */
  const rowsBySlide = useMemo(
    () => (view === undefined ? new Map<string, PreviewRow>() : byPosition(view.preview, view.outline)),
    [view],
  );

  if (view === undefined) {
    return loadError
      ? <OutlineLoadFailure deckId={deckId} error={loadError} onRetry={reload} />
      : <Empty>Loading…</Empty>;
  }

  const error = actionError ?? loadError;
  const dirty = draft !== undefined;
  const slideCount = (outline?.sections ?? []).reduce((n, s) => n + s.slides.length, 0);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href={`/decks/${deckId}`}
          className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
        >
          <ChevronLeft aria-hidden className="size-3.5" />
          Back to the deck
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Outline</h1>
            <p className="text-sm text-ink-soft">
              {slideCount} slide{slideCount === 1 ? "" : "s"} in {outline?.sections.length ?? 0} section
              {outline?.sections.length === 1 ? "" : "s"} · one message per slide
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dirty && (
              <>
                <span className="text-xs text-ink-soft">Unsaved changes</span>
                <Button onClick={() => setDraft(undefined)} disabled={busy !== undefined}>Discard</Button>
              </>
            )}
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy !== undefined}>
              {busy === "save" ? "Saving…" : "Save outline"}
            </Button>
          </div>
        </div>

        {/* §12: advisories are shown, never filtered — they are why a regenerate might be wanted. */}
        {(view.advisories.length > 0 || view.repaired) && (
          <div className="flex flex-wrap gap-1.5">
            {view.repaired && (
              <Flag title="The model's first response was malformed and had to be repaired. Worth a read.">
                repaired
              </Flag>
            )}
            {view.advisories.map((advisory) => (
              <Flag key={advisory.kind} title={advisory.message}>{advisory.message}</Flag>
            ))}
          </div>
        )}
      </header>

      {error && <ErrorNote message={error.message} issues={error.issues} />}

      <RegenerateBar
        label="Regenerate the whole outline"
        hint="e.g. “fewer slides”, “lead with the cost argument”"
        busy={busy === "outline"}
        disabled={busy !== undefined}
        onRegenerate={(instruction) => void regenerate(instruction)}
      />

      {outline === undefined || outline.sections.length === 0
        ? <Empty>This outline has no sections.</Empty>
        : (
          <div className="space-y-6">
            {outline.sections.map((section, sectionIndex) => (
              <Card key={sectionIndex} className="space-y-4 p-4">
                <div className="space-y-3 border-b border-line pb-3">
                  <Field label={`Section ${sectionIndex + 1}`}>
                    <Input
                      value={section.heading}
                      onChange={(event) => editHeading(sectionIndex, event.target.value)}
                      placeholder="Untitled section"
                    />
                  </Field>
                  <RegenerateBar
                    label="Regenerate this section"
                    hint="Its neighbours are left alone."
                    busy={busy === `section:${sectionIndex}`}
                    disabled={busy !== undefined}
                    onRegenerate={(instruction) => void regenerate(instruction, sectionIndex)}
                  />
                </div>

                {section.slides.map((slide, slideIndex) => (
                  <SlideRow
                    key={slideIndex}
                    slide={slide}
                    position={`${sectionIndex + 1}.${slideIndex + 1}`}
                    row={dirty ? undefined : rowsBySlide.get(`${sectionIndex}.${slideIndex}`)}
                    busy={busy === `layout:${sectionIndex}.${slideIndex}`}
                    disabled={busy !== undefined}
                    dirty={dirty}
                    canMoveUp={slideIndex > 0}
                    canMoveDown={slideIndex < section.slides.length - 1}
                    onEdit={(patch) => editSlide(sectionIndex, slideIndex, patch)}
                    onMove={(delta) => moveSlide(sectionIndex, slideIndex, delta)}
                    onDelete={() => deleteSlide(sectionIndex, slideIndex)}
                    onLayout={(layoutId) => void setLayout(sectionIndex, slideIndex, layoutId)}
                  />
                ))}
              </Card>
            ))}
          </div>
        )}
    </div>
  );
}

/* ─────────────────────────────── rows ─────────────────────────────── */

function SlideRow(
  { slide, position, row, busy, disabled, dirty, canMoveUp, canMoveDown, onEdit, onMove, onDelete, onLayout }: {
    slide: OutlineSlide;
    position: string;
    row: PreviewRow | undefined;
    busy: boolean;
    disabled: boolean;
    dirty: boolean;
    canMoveUp: boolean;
    canMoveDown: boolean;
    onEdit: (patch: Partial<OutlineSlide>) => void;
    onMove: (delta: number) => void;
    onDelete: () => void;
    onLayout: (layoutId: string | null) => void;
  },
) {
  return (
    <div className="space-y-3 rounded-md border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-ink-soft">{position}</span>
          <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] text-ink-soft">
            {slide.visualHint}
          </span>
          {/* The mapping badge (§7.2): which layout this slide will get, and why. */}
          {row !== undefined && (
            <span className="text-[11px] text-ink-soft" title={row.reason}>
              → {row.layoutDisplayName} · {row.reason}
            </span>
          )}
          {slide.layoutOverride !== undefined && <Flag title="You pinned this layout">pinned</Flag>}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => onMove(-1)} disabled={!canMoveUp || disabled} aria-label={`Move slide ${position} up`}>
            <ChevronUp aria-hidden className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onMove(1)} disabled={!canMoveDown || disabled} aria-label={`Move slide ${position} down`}>
            <ChevronDown aria-hidden className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={disabled} aria-label={`Delete slide ${position}`}>
            <Trash2 aria-hidden className="size-3.5" />
          </Button>
        </div>
      </div>

      <Field label="Question" hint="What this slide answers for the audience.">
        <Input value={slide.question} onChange={(event) => onEdit({ question: event.target.value })} />
      </Field>

      <Field label="Message" hint="The one-sentence answer. One slide, one message.">
        <Input value={slide.message} onChange={(event) => onEdit({ message: event.target.value })} />
      </Field>

      <EvidenceEditor evidence={slide.evidence} onChange={(evidence) => onEdit({ evidence })} />

      <LayoutPicker
        slide={slide}
        row={row}
        busy={busy}
        disabled={disabled}
        dirty={dirty}
        onLayout={onLayout}
      />
    </div>
  );
}

/**
 * Evidence is 0–4 supports, so it is edited as a fixed short list plus an Add — not a textarea split on
 * newlines. The server caps the count, and a UI that let the user type a fifth only to have it silently
 * dropped would be the same silent-truncation problem the amber flags exist to avoid.
 */
function EvidenceEditor(
  { evidence, onChange }: { evidence: string[]; onChange: (evidence: string[]) => void },
) {
  const MAX = 4;
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-ink-soft">Evidence (up to {MAX})</span>
      {evidence.map((item, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            value={item}
            onChange={(event) =>
              onChange(evidence.map((e, i) => (i === index ? event.target.value : e)))}
            placeholder="A supporting fact"
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(evidence.filter((_, i) => i !== index))}
            aria-label={`Remove evidence ${index + 1}`}
          >
            <Trash2 aria-hidden className="size-3.5" />
          </Button>
        </div>
      ))}
      {evidence.length < MAX && (
        <Button size="sm" onClick={() => onChange([...evidence, ""])}>Add evidence</Button>
      )}
    </div>
  );
}

/**
 * The layout pin (§7.2's `UserOverrideRule`).
 *
 * Options come from the row's server-ranked `options` — the recommendation is the mapping service's
 * (`layoutOptionsFor`), never re-derived here: a client-side sort would be §4's parallel table and its
 * "recommended" would drift from the badge's `reason`.
 *
 * Disabled while a draft exists, because the write is by INDEX: an unsaved reorder means the position the
 * user clicked is not the one the server would write to.
 */
function LayoutPicker(
  { slide, row, busy, disabled, dirty, onLayout }: {
    slide: OutlineSlide;
    row: PreviewRow | undefined;
    busy: boolean;
    disabled: boolean;
    dirty: boolean;
    onLayout: (layoutId: string | null) => void;
  },
) {
  if (dirty || row === undefined) {
    return (
      <p className="text-xs text-ink-soft">
        Save the outline to change this slide&apos;s layout — the pin is written by position.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1">
        <Field label="Layout">
          <select
            // The pin's value, NOT the mapped layout: an empty select means "no pin, let the rules
            // decide", and pre-selecting the rule's answer would make clearing a pin unexpressible.
            value={slide.layoutOverride ?? ""}
            onChange={(event) => onLayout(event.target.value === "" ? null : event.target.value)}
            disabled={busy || disabled}
            className="w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">Automatic — {row.layoutDisplayName}</option>
            {row.options.map((option) => (
              <option key={option.id} value={option.id} title={option.description}>
                {option.displayName}{option.recommended ? " (recommended)" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {row.overridden && (
        <Button size="sm" onClick={() => onLayout(null)} disabled={busy || disabled}>
          <RotateCcw aria-hidden className="size-3.5" />
          Reset to automatic
        </Button>
      )}
    </div>
  );
}

/** Regenerate-with-instruction, at outline and section scope (§12 requires both). */
function RegenerateBar(
  { label, hint, busy, disabled, onRegenerate }: {
    label: string;
    hint: string;
    busy: boolean;
    disabled: boolean;
    onRegenerate: (instruction: string) => void;
  },
) {
  const [instruction, setInstruction] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-56 flex-1">
        <Field label={label} hint={hint}>
          <Input
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            disabled={disabled}
            placeholder="Optional instruction"
          />
        </Field>
      </div>
      <Button onClick={() => onRegenerate(instruction.trim())} disabled={disabled}>
        <Wand2 aria-hidden className="size-4" />
        {busy ? "Working…" : "Regenerate"}
      </Button>
    </div>
  );
}

/**
 * A `DeckNotReady` here is not a failure to retry — it means there is no outline yet, and the fix is a
 * different screen. Retrying the same GET would return the same 409 forever, so this offers the action
 * that actually resolves it.
 */
function OutlineLoadFailure(
  { deckId, error, onRetry }: { deckId: string; error: ApiError; onRetry: () => void },
) {
  if (error.code !== "DeckNotReady") {
    return <ErrorNote message={error.message} issues={error.issues} onRetry={onRetry} />;
  }
  return (
    <Card className="max-w-xl space-y-3 p-4">
      <h1 className="text-sm font-medium">No outline yet</h1>
      <p className="text-sm text-ink-soft">{error.message}</p>
      <Link href={`/decks/${deckId}`} className="text-sm underline">Go to the deck</Link>
    </Card>
  );
}

/* ─────────────────────────── pure helpers ─────────────────────────── */

/**
 * Preview rows keyed by `"sectionIndex.slideIndex"`.
 *
 * `preview` is a FLAT list carrying a deck-wide `index`, and the editor renders nested sections — so the
 * two have to be aligned. Walking the same outline the rows were computed from is what makes the join
 * exact; matching on `question` text would break the moment two slides asked the same thing.
 *
 * Sections with no slides are skipped, because `mapOutline` skips them too (`OUTLINE` schema drops them
 * on save, but a stored document may still contain one).
 */
function byPosition(preview: readonly PreviewRow[], outline: Outline): Map<string, PreviewRow> {
  const map = new Map<string, PreviewRow>();
  let cursor = 0;
  outline.sections.forEach((section, sectionIndex) => {
    section.slides.forEach((_, slideIndex) => {
      const row = preview[cursor++];
      if (row) map.set(`${sectionIndex}.${slideIndex}`, row);
    });
  });
  return map;
}

/** `undefined` outline → `undefined` draft, so the edit handlers stay callable before the first load. */
const withSections = (
  outline: Outline | undefined, fn: (sections: Outline["sections"]) => Outline["sections"],
): Outline | undefined => (outline === undefined ? undefined : { sections: fn(outline.sections) });

const mapSlide = (
  outline: Outline | undefined,
  sectionIndex: number,
  slideIndex: number,
  fn: (slide: OutlineSlide) => OutlineSlide,
): Outline | undefined =>
  withSections(outline, (sections) =>
    sections.map((section, si) =>
      si !== sectionIndex
        ? section
        : { ...section, slides: section.slides.map((slide, li) => (li === slideIndex ? fn(slide) : slide)) }));
