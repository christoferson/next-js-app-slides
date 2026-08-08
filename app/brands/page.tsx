"use client";

/**
 * The brands gallery (SPEC §7). A client component because it mutates: create and delete both act on this
 * list, and the delete path needs the `BrandInUse` 409 rendered inline next to the row that caused it.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import type { BrandDefinition, BrandSummary } from "@/lib/brand/types";
import { ApiError, api } from "@/lib/client/api";
import { useResource } from "@/components/use-resource";
import { JsonImportField } from "@/components/brand/json-import";
import { Button, Card, Empty, ErrorNote } from "@/components/ui/primitives";

export default function BrandsPage() {
  /**
   * `{ brands }`, not a bare array.
   *
   * Every list route in this app answers with a NAMED envelope (`{brands}`, `{decks}`, `{layouts}`) so a
   * field can be added later without breaking clients. This screen asserted `BrandSummary[]` instead and
   * crashed at `brands.map` — a lie the compiler could not catch, because `request<T>` casts an
   * `unknown` body to whatever the caller names. Unwrapped here in the fetcher rather than at each use
   * site, so `brands` is the array its name promises. `tests/client-contract.test.ts` now checks the
   * envelope for every list method, so the next one fails a test instead of a screen.
   */
  const { data: brands, error: loadError, reload, set } = useResource(
    useCallback(
      async () => (await api.brands.list<{ brands: BrandSummary[] }>()).brands,
      [],
    ),
  );
  const [actionError, setActionError] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState(false);

  /**
   * Create with a name only: `brandInputSchema` supplies every other default, so a new brand is a complete,
   * valid, on-brand default rather than a half-filled record — the reason `BrandService.create` documents
   * for keeping defaults in the schema.
   *
   * ## Why this reloads instead of prepending the response
   *
   * `POST /api/brands` answers with a `BrandDefinition`; this list holds `BrandSummary`. They are NOT the
   * same shape — a summary carries `templatedLayoutIds`, which the repository DERIVES from
   * `Object.keys(brand.templates)` and which therefore does not exist on the definition. Prepending the
   * response satisfied the compiler (the generic was simply asserted as `BrandSummary`) and then threw
   * `Cannot read properties of undefined (reading 'length')` on the new row's template count.
   *
   * Converting client-side would mean a second copy of that derivation, which is what §4 forbids — so the
   * server stays the only place that knows how a summary is built, and `reload` re-reads it. That is also
   * exactly what `useResource` documents `set` is NOT for: "a mutation that could change anything derived
   * should `reload` instead". One extra request per brand creation, in exchange for one shape.
   */
  const create = async () => {
    setBusy(true);
    setActionError(undefined);
    try {
      await api.brands.create({ name: "New brand" });
      reload();
    } catch (cause) {
      if (cause instanceof ApiError) setActionError(cause);
      else throw cause;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Import a shared config as a NEW brand (SPEC §5; the create half of §11 step 3).
   *
   * This is the last client method that no screen reached. The editor's import REPLACES the brand being
   * edited, which is useless for the flow that actually happens: someone sends you a config and you have no
   * brand to overwrite. Doing it there would mean creating a throwaway brand first and then destroying its
   * contents — so the create path belongs on the gallery, next to "New brand".
   *
   * `POST /api/brands/import` takes a whole exported definition (ids and timestamps included) rather than
   * `brandInputSchema`'s editable surface, which is why it is a separate endpoint: an export sent to
   * `POST /api/brands` fails on four unrecognized keys. The payload's `id`/`userId` are discarded
   * server-side, so a crafted config cannot write into another user's partition or overwrite an existing
   * brand — it always creates.
   *
   * Reloads rather than prepending the 201, for the reason `create` documents at length: the response is a
   * `BrandDefinition` and this list holds `BrandSummary`, and `templatedLayoutIds` is derived server-side.
   * An imported brand is the most likely of all to carry templates, so this is precisely the case where
   * prepending would show `undefined.length`.
   */
  const importBrand = async (parsed: unknown) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await api.brands.import<BrandDefinition>(parsed);
      reload();
    } catch (cause) {
      // The expected failure is `InvalidBrandConfig` (400) carrying field-level zod issues, which
      // `ErrorNote` renders one per line — §12's "field-level readable zod errors".
      if (cause instanceof ApiError) setActionError(cause);
      else throw cause;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (brandId: string) => {
    setActionError(undefined);
    try {
      await api.brands.remove(brandId);
      set((brands ?? []).filter((b) => b.id !== brandId));
    } catch (cause) {
      // The expected failure here is `BrandInUse` (409) — a brand referenced by a deck. Its message names
      // the count, and the server deliberately omits the brand id, so it is rendered as-is.
      if (cause instanceof ApiError) setActionError(cause);
      else throw cause;
    }
  };

  const error = actionError ?? loadError;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Brands</h1>
          <p className="text-sm text-ink-soft">
            Colours, fonts, tone, and per-layout backgrounds. Every deck renders through one of these.
          </p>
        </div>
        <Button variant="primary" onClick={() => void create()} disabled={busy}>
          <Plus aria-hidden className="size-4" />
          New brand
        </Button>
      </header>

      {error && (
        <ErrorNote
          message={error.message}
          issues={error.issues}
          {...(loadError !== undefined ? { onRetry: reload } : {})}
        />
      )}

      {/* Collapsed: importing is the rarer path, and an always-open textarea would compete with "New brand"
          for the primary action on a screen whose job is to list brands. */}
      <Card className="p-4">
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Import a brand from JSON
            <span className="ml-2 font-normal text-ink-soft">
              — paste a config someone shared, or a file you exported
            </span>
          </summary>
          <div className="mt-3">
            <JsonImportField
              label="Config JSON"
              hint="Creates a new brand. Your existing brands are untouched, and nothing is applied if it is invalid."
              submitLabel="Create brand from JSON"
              pendingLabel="Importing…"
              busy={busy}
              onSubmit={(parsed) => void importBrand(parsed)}
            />
          </div>
        </details>
      </Card>

      {brands === undefined && loadError === undefined && <Empty>Loading…</Empty>}

      {brands?.length === 0 && (
        <Empty>No brands yet. Create one to get started — it starts from on-brand defaults.</Empty>
      )}

      {brands !== undefined && brands.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {brands.map((brand) => (
            <li key={brand.id}>
              <Card className="flex h-full flex-col overflow-hidden">
                {/* The palette IS the thumbnail — the brand's own colours, which is the one place in the
                    chrome where brand colour legitimately appears. */}
                <div className="flex h-16">
                  {(["primary", "secondary", "accent", "background", "surface"] as const).map((key) => (
                    <div key={key} className="flex-1" style={{ backgroundColor: `#${brand.colors[key]}` }} />
                  ))}
                </div>
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <Link href={`/brands/${brand.id}`} className="font-medium hover:underline">
                    {brand.name}
                  </Link>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
                    <span>{brand.fonts.heading} / {brand.fonts.body}</span>
                    {brand.templatedLayoutIds.length > 0 && (
                      <span>· {brand.templatedLayoutIds.length} templated</span>
                    )}
                  </div>
                  <div className="mt-auto flex items-center justify-between pt-2">
                    <Link href={`/brands/${brand.id}`} className="text-xs text-ink-soft hover:text-ink">
                      Edit
                    </Link>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void remove(brand.id)}
                      aria-label={`Delete ${brand.name}`}
                    >
                      <Trash2 aria-hidden className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
