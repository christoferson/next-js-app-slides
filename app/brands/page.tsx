"use client";

/**
 * The brands gallery (SPEC §7). A client component because it mutates: create and delete both act on this
 * list, and the delete path needs the `BrandInUse` 409 rendered inline next to the row that caused it.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import type { BrandSummary } from "@/lib/brand/types";
import { ApiError, api } from "@/lib/client/api";
import { useResource } from "@/components/use-resource";
import { Button, Card, Empty, ErrorNote } from "@/components/ui/primitives";

export default function BrandsPage() {
  const { data: brands, error: loadError, reload, set } = useResource(
    useCallback(() => api.brands.list<BrandSummary[]>(), []),
  );
  const [actionError, setActionError] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState(false);

  /**
   * Create with a name only: `brandInputSchema` supplies every other default, so a new brand is a complete,
   * valid, on-brand default rather than a half-filled record — the reason `BrandService.create` documents
   * for keeping defaults in the schema.
   */
  const create = async () => {
    setBusy(true);
    setActionError(undefined);
    try {
      const brand = await api.brands.create<BrandSummary>({ name: "New brand" });
      set([brand, ...(brands ?? [])]);
    } catch (cause) {
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
