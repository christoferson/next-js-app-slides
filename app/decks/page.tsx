"use client";

/**
 * The decks list, plus the create step (SPEC §8's wizard entry).
 *
 * Creating a deck requires a brand, so this screen loads both lists. That is also why the create control is
 * explained rather than hidden when no brand exists: a hidden button leaves the user looking for it, and
 * `POST /api/decks` would answer `BrandNotFound` anyway.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import type { BrandSummary } from "@/lib/brand/types";
import type { DeckSummary } from "@/lib/domain/deck";
import { ApiError, api } from "@/lib/client/api";
import { useResource } from "@/components/use-resource";
import { Button, Card, Empty, ErrorNote, Field, Input, Select } from "@/components/ui/primitives";

export default function DecksPage() {
  // Two independent reads, fetched together: the screen needs a brand list before it can create anything,
  // and one combined fetcher keeps them in a single loading/error state instead of two interleaving ones.
  const { data, error: loadError, reload, set } = useResource(
    useCallback(async () => {
      // Both routes answer with a NAMED envelope (`{decks}` / `{brands}`), which is unwrapped here so the
      // rest of the screen reads plain arrays. Asserting the array type directly compiled fine and threw
      // `data.brands.map is not a function` at runtime — see the note in `app/brands/page.tsx`.
      const [decks, brands] = await Promise.all([
        api.decks.list<{ decks: DeckSummary[] }>(),
        api.brands.list<{ brands: BrandSummary[] }>(),
      ]);
      return { decks: decks.decks, brands: brands.brands };
    }, []),
  );

  const [actionError, setActionError] = useState<ApiError | undefined>();
  const [title, setTitle] = useState("");
  const [brandId, setBrandId] = useState("");
  const [busy, setBusy] = useState(false);

  // The brand select defaults to the first brand rather than mirroring it into state on load — deriving it
  // during render avoids a second source of truth that could disagree with the fetched list.
  const effectiveBrandId = brandId !== "" ? brandId : (data?.brands[0]?.id ?? "");

  /**
   * Reloads rather than prepending the response, for the same reason `app/brands/page.tsx` does:
   * `POST /api/decks` answers with a `DeckMeta`, and this list holds `DeckSummary`, which additionally
   * carries the DERIVED `slideCount`. Prepending gave the new row `undefined slides` — the generic said
   * `DeckSummary` and nothing checked it. Deriving the count client-side would be a second copy of a
   * server-side rule (§4), so the server stays its only owner.
   */
  const create = async () => {
    if (data === undefined) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await api.decks.create({
        title: title.trim() === "" ? "Untitled deck" : title.trim(),
        brandId: effectiveBrandId,
      });
      reload();
      setTitle("");
    } catch (cause) {
      if (cause instanceof ApiError) setActionError(cause);
      else throw cause;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (deckId: string) => {
    if (data === undefined) return;
    setActionError(undefined);
    try {
      await api.decks.remove(deckId);
      set({ ...data, decks: data.decks.filter((d) => d.id !== deckId) });
    } catch (cause) {
      if (cause instanceof ApiError) setActionError(cause);
      else throw cause;
    }
  };

  const error = actionError ?? loadError;
  const brandName = (id: string): string =>
    data?.brands.find((b) => b.id === id)?.name ?? "Unknown brand";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Decks</h1>
        <p className="text-sm text-ink-soft">Outline, generate, edit, and export presentations.</p>
      </header>

      {error && (
        <ErrorNote
          message={error.message}
          issues={error.issues}
          {...(loadError !== undefined ? { onRetry: reload } : {})}
        />
      )}

      {data !== undefined && (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-medium">New deck</h2>
          {data.brands.length === 0 ? (
            <p className="text-sm text-ink-soft">
              Create a <Link href="/brands" className="underline">brand</Link> first — a deck renders through one.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <Field label="Title">
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Q3 business review"
                  />
                </Field>
              </div>
              <div className="min-w-48">
                <Field label="Brand">
                  <Select
                    value={effectiveBrandId}
                    onChange={(event) => setBrandId(event.target.value)}
                  >
                    {data.brands.map((brand) => (
                      <option key={brand.id} value={brand.id}>{brand.name}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button variant="primary" onClick={() => void create()} disabled={busy || effectiveBrandId === ""}>
                <Plus aria-hidden className="size-4" />
                Create
              </Button>
            </div>
          )}
        </Card>
      )}

      {data === undefined && loadError === undefined && <Empty>Loading…</Empty>}
      {data?.decks.length === 0 && <Empty>No decks yet.</Empty>}

      {data !== undefined && data.decks.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {data.decks.map((deck) => (
            <li key={deck.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link href={`/decks/${deck.id}`} className="font-medium hover:underline">
                  {deck.title}
                </Link>
                <p className="text-xs text-ink-soft">
                  {brandName(deck.brandId)} · {deck.slideCount} slide{deck.slideCount === 1 ? "" : "s"}
                </p>
              </div>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void remove(deck.id)}
                aria-label={`Delete ${deck.title}`}
              >
                <Trash2 aria-hidden className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
