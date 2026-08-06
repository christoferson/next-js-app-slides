/**
 * The complete swap contract (CLAUDE.md §2 step 3). Every interface an implementation must
 * satisfy lives behind this barrel; services import from here and never from an impl.
 *
 * `Ports` is the shape `lib/container.ts` assembles — and the ONLY place concrete classes are
 * constructed (§3). Keeping it here, next to the interfaces, means adding a port makes the
 * container fail to typecheck until it is wired.
 */

export type { BrandRepository, DeckRepository } from "@/lib/ports/repositories";
export type { AssetStore } from "@/lib/ports/asset-store";
export type { AuthProvider, Principal } from "@/lib/ports/auth-provider";
export type { LLMPort, LlmRequest, LlmResponse, LlmTextDelta, LlmUsage } from "@/lib/ports/llm-port";
export type { Exporter, ExportRequest, ExportResult } from "@/lib/ports/exporter";
export type { ImageLuminancePort } from "@/lib/ports/image-luminance";

import type { BrandRepository, DeckRepository } from "@/lib/ports/repositories";
import type { AssetStore } from "@/lib/ports/asset-store";
import type { AuthProvider } from "@/lib/ports/auth-provider";
import type { LLMPort } from "@/lib/ports/llm-port";
import type { Exporter } from "@/lib/ports/exporter";
import type { ImageLuminancePort } from "@/lib/ports/image-luminance";

export interface Ports {
  brands: BrandRepository;
  decks: DeckRepository;
  assets: AssetStore;
  auth: AuthProvider;
  llm: LLMPort;
  /** Samples an uploaded background's luminance once, at upload — see the port's header. */
  luminance: ImageLuminancePort;
  /** Keyed by `Exporter.format`; SPEC §12's exporter Strategy seam. */
  exporters: Record<string, Exporter>;
}
