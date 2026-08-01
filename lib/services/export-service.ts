/**
 * `ExportService` — deck + brand → resolved `ExportRequest` → bytes (SPEC §12).
 *
 * ## Why the resolution lives here and not in the exporter
 *
 * `ExportRequest` (`lib/ports/exporter.ts`) is fully resolved by design: no repository, no asset store,
 * no `userId`. That makes an exporter a pure function of its inputs — testable with fixtures, and
 * structurally unable to reach storage. The cost is that *someone* has to do the resolving, and this is
 * that someone:
 *
 *   - deck meta + slides, ordered;
 *   - the brand and its compiled `DesignTokens` (never a raw `BrandDefinition` for appearance — see
 *     `lib/brand/types.ts`);
 *   - backgrounds resolved to bytes, keyed by layoutId, **deduplicated by asset id** so the exporter can
 *     build one slide master per *distinct* background (§1.1/C3: pptxgenjs does not dedupe identical
 *     media — 611 KB / 15 parts became 146 KB / 1 part in the probe);
 *   - logos, if the brand has any.
 *
 * ## Format selection is a registry, not a switch
 *
 * SPEC §12 names `Html`/`Pdf` as later formats. Exporters arrive as `Record<format, Exporter>` — the
 * shape `Ports` already declares — so adding one is one container line, the same one-entry rule §10
 * applies to layouts and models. An unknown format is a readable failure, not a crash.
 *
 * The key duplicates `Exporter.format`, which is a drift risk: a container entry filed under `"ppt"`
 * holding the `"pptx"` exporter would resolve by key and then produce a mismatched filename. So the key
 * is checked against the field on lookup rather than trusted — one comparison, and it fails at the
 * wiring mistake instead of in the downloaded file.
 */

import type { DeckMeta, Slide } from "@/lib/domain/deck";
import type { BrandDefinition, DesignTokens } from "@/lib/brand/types";
import type { ExportRequest, ExportResult, Exporter } from "@/lib/ports/exporter";
import { DeckNotReady, UnknownExportFormat } from "@/lib/errors/errors";
import type { BrandService } from "@/lib/services/brand-service";
import type { DeckService } from "@/lib/services/deck-service";

export interface ExportServiceDeps {
  decks: DeckService;
  brands: BrandService;
  /** Injected by the container, keyed by format — `Ports.exporters`' shape. */
  exporters: Readonly<Record<string, Exporter>>;
}

export class ExportService {
  constructor(private readonly deps: ExportServiceDeps) {}

  /** Which formats this deployment can produce — the download menu's options. */
  formats(): string[] {
    return Object.keys(this.deps.exporters).sort();
  }

  async export(userId: string, deckId: string, format: string): Promise<ExportResult> {
    // `Object.hasOwn`, not a bare index: `exporters["toString"]` would otherwise resolve to a function
    // off the prototype chain and be *called* as an exporter. A format arrives straight from a URL
    // segment, so this is reachable input, not a hypothetical (the same hole `isVisualHint` had).
    const exporter = Object.hasOwn(this.deps.exporters, format)
      ? this.deps.exporters[format]
      : undefined;

    if (!exporter) {
      // A format arrives from a URL or a menu, so an unknown one is a bad request rather than a bug.
      // The available list makes the message actionable.
      throw UnknownExportFormat(format, this.formats());
    }
    if (exporter.format !== format) {
      // A wiring mistake, not a user error — see the header. Fails here rather than in the filename.
      throw new Error(
        `Exporter registered under "${format}" reports format "${exporter.format}" — fix lib/container.ts.`,
      );
    }
    return exporter.export(await this.buildRequest(userId, deckId));
  }

  /**
   * Assemble the fully-resolved request.
   *
   * Exposed (not private) because it is also the fixture builder for §8's zone-fidelity check: the
   * comparison is only meaningful if the preview and the export consume the *same* resolved inputs, and
   * a test that reconstructs them by hand would be comparing its own reconstruction.
   */
  async buildRequest(userId: string, deckId: string): Promise<ExportRequest> {
    const { meta, slides } = await this.deps.decks.getFull(userId, deckId);
    if (slides.length === 0) {
      throw DeckNotReady("This deck has no slides yet. Generate them before exporting.", { deckId });
    }

    const { brand, tokens } = await this.deps.brands.themeFor(userId, meta.brandId);

    // Only the layouts this deck actually uses. Resolving every templated layout would read bytes for
    // backgrounds no slide references — on a brand with a background per layout that is most of them.
    const layoutIds = [...new Set(slides.map((s) => s.layoutId))];
    const assets = await this.deps.brands.resolveRenderAssets(userId, brand, layoutIds);

    return {
      deck: meta,
      slides,
      brand,
      tokens,
      ...assets,
    };
  }
}

/* ─────────────────────────── pure helpers ─────────────────────────── */

/**
 * A filesystem-safe download name derived from the deck title.
 *
 * Exported for the exporters to share: `ExportResult.filename` is set per format, and two exporters
 * each writing their own sanitizer is how one of them ends up emitting a name with a `/` in it. The
 * character class is a whitelist rather than a blacklist — a blacklist has to enumerate every reserved
 * character on every platform, and misses the next one.
 */
export function exportFilename(deck: Pick<DeckMeta, "title">, extension: string): string {
  const base = deck.title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base === "" ? "deck" : base}.${extension}`;
}

/** Narrow re-export so a caller need not import the port to name what it received. */
export type { ExportRequest, ExportResult, BrandDefinition, DesignTokens, Slide };
