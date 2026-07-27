/**
 * CLAUDE.md §2 step 3 — the exporter PORT (SPEC §12: `PptxExporter` now, `Html`/`Pdf` later).
 *
 * The port returns BYTES, not a path and not a written file: the route streams the buffer
 * straight to the client, and nothing in the app needs a scratch directory. §1.1 verified
 * pptxgenjs can produce a nodebuffer server-side, so this shape is proven, not assumed.
 */

import type { BrandDefinition, DesignTokens } from "@/lib/brand/types";
import type { DeckMeta, Slide } from "@/lib/domain/deck";
import type { ResolvedAsset } from "@/lib/domain/asset";

/**
 * Everything an exporter needs, fully resolved by the service layer. Note what is ABSENT: no
 * repository, no asset store, no userId. An exporter is a pure function of resolved inputs, so
 * it is testable with fixtures and cannot reach storage.
 */
export interface ExportRequest {
  deck: DeckMeta;
  slides: Slide[];
  brand: BrandDefinition;
  tokens: DesignTokens;
  /**
   * Backgrounds already resolved to bytes, keyed by layoutId. §1.1/C3 found pptxgenjs does NOT
   * deduplicate identical media, so the exporter must define one slide master per DISTINCT
   * background (611 KB / 15 parts → 146 KB / 1 part in the probe) — this map is what makes the
   * distinct set knowable up front.
   */
  backgroundsByLayoutId: Record<string, ResolvedAsset>;
  /** Resolved logo variants, if the brand has any. */
  logos?: { light?: ResolvedAsset; dark?: ResolvedAsset };
}

export interface ExportResult {
  bytes: Uint8Array;
  contentType: string;
  /** Suggested download filename; the route sets Content-Disposition from it. */
  filename: string;
}

export interface Exporter {
  /** Stable id for the format, e.g. `"pptx"` — used to select the exporter. */
  readonly format: string;
  export(request: ExportRequest): Promise<ExportResult>;
}
