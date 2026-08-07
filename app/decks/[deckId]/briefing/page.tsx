"use client";

/**
 * The briefing form (SPEC §8's wizard step 2) — topic, audience, objective, slide count, optional source text.
 *
 * ## The one place the deck's *inputs* are edited
 *
 * Everything downstream is derived: the outline is generated from this, and the slides from the outline. So
 * this form's job is to be honest about what the server will accept — `briefingSchema` requires all five
 * fields together (it is a `strictObject`, not a partial), which is why Save sends the whole briefing rather
 * than a patch per field.
 *
 * Limits shown here (500 chars, 5–30 slides) mirror `briefingSchema`. They are duplicated as *hints*, never
 * as enforcement: the server rejects out-of-range values with field-level issues, and `ErrorNote` renders
 * them, so a drifted hint is a cosmetic bug rather than a validation hole.
 *
 * The form is a separate component so the page can remount it with a `key` when the server's copy changes,
 * instead of seeding draft state from an effect — see `BriefingForm`'s call site.
 */

import { use, useCallback, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { Briefing, DeckMeta } from "@/lib/domain/deck";
import { ApiError, api } from "@/lib/client/api";
import { useResource } from "@/components/use-resource";
import { Button, Card, Empty, ErrorNote, Field, Input } from "@/components/ui/primitives";

const EMPTY: Briefing = { topic: "", audience: "", objective: "", targetSlideCount: 10 };

export default function BriefingPage({ params }: { params: Promise<{ deckId: string }> }) {
  // Next 16 hands params as a promise; `use` unwraps it during render, which is what it is for.
  const { deckId } = use(params);

  const { data: deck, error: loadError, reload, set: setDeck } = useResource(
    useCallback(() => api.decks.get<DeckMeta>(deckId), [deckId]),
  );

  const [actionError, setActionError] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (draft: Briefing) => {
    setBusy(true);
    setActionError(undefined);
    setSaved(false);
    try {
      // `sourceText` is omitted when blank rather than sent as "": the schema caps its length but an empty
      // string would still be stored, and "has grounding text" is a meaningful distinction downstream.
      const briefing: Briefing = {
        topic: draft.topic.trim(),
        audience: draft.audience.trim(),
        objective: draft.objective.trim(),
        targetSlideCount: draft.targetSlideCount,
        ...(draft.sourceText !== undefined && draft.sourceText.trim() !== ""
          ? { sourceText: draft.sourceText }
          : {}),
      };
      setDeck(await api.decks.update<DeckMeta>(deckId, { briefing }));
      setSaved(true);
    } catch (cause) {
      if (cause instanceof ApiError) setActionError(cause);
      else throw cause;
    } finally {
      setBusy(false);
    }
  };

  if (deck === undefined) {
    return loadError
      ? <ErrorNote message={loadError.message} issues={loadError.issues} onRetry={reload} />
      : <Empty>Loading…</Empty>;
  }

  const error = actionError ?? loadError;

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-2">
        <Link
          href={`/decks/${deck.id}`}
          className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
        >
          <ChevronLeft aria-hidden className="size-3.5" />
          {deck.title}
        </Link>
        <h1 className="text-xl font-semibold">Briefing</h1>
        <p className="text-sm text-ink-soft">
          What the deck is about. The outline — and every slide&apos;s content — is generated from this.
        </p>
      </header>

      {error && <ErrorNote message={error.message} issues={error.issues} />}

      <BriefingForm
        // Remount when the server's copy changes, so the fields re-initialize from it. A server-normalized
        // value then replaces the draft rather than being typed back over on the next save.
        key={deck.updatedAt}
        initial={deck.briefing ?? EMPTY}
        busy={busy}
        onSave={(draft) => void save(draft)}
      />

      {saved && (
        <Link href={`/decks/${deck.id}`} className="text-sm underline">
          Saved — back to the deck
        </Link>
      )}
    </div>
  );
}

function BriefingForm(
  { initial, busy, onSave }: { initial: Briefing; busy: boolean; onSave: (draft: Briefing) => void },
) {
  const [draft, setDraft] = useState<Briefing>(initial);

  const setField = <K extends keyof Briefing>(key: K, value: Briefing[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <Card className="space-y-4 p-4">
      <Field label="Topic" hint="Up to 500 characters.">
        <Input
          value={draft.topic}
          onChange={(event) => setField("topic", event.target.value)}
          placeholder="Q3 platform performance and what we do next"
        />
      </Field>

      <Field label="Audience" hint="Who is in the room — it changes the register, not the facts.">
        <Input
          value={draft.audience}
          onChange={(event) => setField("audience", event.target.value)}
          placeholder="Regional sales leads, non-technical"
        />
      </Field>

      <Field label="Objective" hint="What you want the audience to do or decide.">
        <Input
          value={draft.objective}
          onChange={(event) => setField("objective", event.target.value)}
          placeholder="Approve the Q4 headcount increase"
        />
      </Field>

      <Field label="Target slide count" hint="5–30. The outline is validated to within ±2 of this.">
        <Input
          type="number"
          min={5}
          max={30}
          value={draft.targetSlideCount}
          // `valueAsNumber` is NaN for an empty input, which would then be sent and rejected. Falling back
          // to the current value keeps the field usable while it is being retyped.
          onChange={(event) =>
            setField("targetSlideCount", Number.isNaN(event.target.valueAsNumber)
              ? draft.targetSlideCount
              : event.target.valueAsNumber)}
        />
      </Field>

      <Field
        label="Source text (optional)"
        hint="Notes, a transcript, a doc. Evidence on each slide is drawn from this when present."
      >
        <textarea
          rows={8}
          value={draft.sourceText ?? ""}
          onChange={(event) => setField("sourceText", event.target.value)}
          className="w-full resize-y rounded-md border border-line bg-white px-2.5 py-1.5 text-sm text-ink"
          placeholder="Paste anything the deck should be grounded in."
        />
      </Field>

      <Button variant="primary" onClick={() => onSave(draft)} disabled={busy}>
        {busy ? "Saving…" : "Save briefing"}
      </Button>
    </Card>
  );
}
