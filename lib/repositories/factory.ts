/**
 * CLAUDE.md §2 step 6 / §3 — backend selection. Together with `lib/container.ts`, the ONLY place
 * concrete implementations are constructed. That is lint-enforced: every other layer is forbidden
 * from importing `lib/repositories/**` or `lib/adapters/**` (§5).
 *
 * §6.3's swap claim is literal — adding DynamoDB is **one case per switch below**, with zero
 * service or route changes. The `memory` cases exist to prove that claim is already true.
 */

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { AppConfig } from "@/lib/config";
import type { AssetStore, AuthProvider, BrandRepository, DeckRepository } from "@/lib/ports";
import type { Exporter } from "@/lib/ports/exporter";
import type { ImageLuminancePort } from "@/lib/ports/image-luminance";
import type { LLMPort } from "@/lib/ports/llm-port";
import { BedrockLLMAdapter } from "@/lib/adapters/bedrock-llm-adapter";
import { SharpImageLuminance } from "@/lib/adapters/sharp-image-luminance";
import { PptxExporter } from "@/lib/export/pptx-exporter";
import { FileBrandRepository } from "@/lib/repositories/file/file-brand-repository";
import { FileDeckRepository } from "@/lib/repositories/file/file-deck-repository";
import { MemoryBrandRepository } from "@/lib/repositories/memory/memory-brand-repository";
import { MemoryDeckRepository } from "@/lib/repositories/memory/memory-deck-repository";
import { MemoryAssetStore } from "@/lib/repositories/memory/memory-asset-store";
import { LocalDiskAssetStore } from "@/lib/adapters/local-disk-asset-store";
import { StubAuthProvider } from "@/lib/adapters/stub-auth-provider";

/**
 * The `default` arms are unreachable: `loadConfig` already rejected unknown values. They exist so
 * that ADDING a backend to the config union makes these switches fail to typecheck (`never`)
 * until the case is wired — the compiler enforces that a new backend is actually implemented.
 */
const unreachable = (value: never, name: string): never => {
  throw new Error(`${name}: unhandled backend ${String(value)}`);
};

export function createBrandRepository(config: AppConfig): BrandRepository {
  switch (config.storageBackend) {
    case "file": return new FileBrandRepository(config.dataDir);
    case "memory": return new MemoryBrandRepository();
    default: return unreachable(config.storageBackend, "createBrandRepository");
  }
}

export function createDeckRepository(config: AppConfig): DeckRepository {
  switch (config.storageBackend) {
    case "file": return new FileDeckRepository(config.dataDir);
    case "memory": return new MemoryDeckRepository();
    default: return unreachable(config.storageBackend, "createDeckRepository");
  }
}

export function createAssetStore(config: AppConfig): AssetStore {
  switch (config.assetBackend) {
    case "local": return new LocalDiskAssetStore(config.dataDir);
    case "memory": return new MemoryAssetStore();
    default: return unreachable(config.assetBackend, "createAssetStore");
  }
}

export function createAuthProvider(config: AppConfig): AuthProvider {
  switch (config.authBackend) {
    case "stub": return new StubAuthProvider(config.defaultUserId);
    default: return unreachable(config.authBackend, "createAuthProvider");
  }
}

/**
 * The image-luminance port. No backend switch, for the same reason `createLLMPort` has none: there is one
 * implementation, and a one-armed switch is indirection with nothing behind it.
 *
 * Constructed eagerly — `sharp` is imported at module load either way (the factory is not lazy), and the
 * adapter itself holds no state and opens nothing, so this does not affect §1.3's "boots with no
 * credentials" guarantee.
 */
export function createImageLuminance(_config: AppConfig): ImageLuminancePort {
  return new SharpImageLuminance();
}

/**
 * The LLM port (§2 step 10). No backend switch yet — Bedrock is the only implementation, and a
 * one-armed switch would be indirection with nothing behind it. When a second arrives it goes here,
 * exactly like the repositories above.
 *
 * The `BedrockRuntimeClient` is built HERE rather than inside the adapter so that §3's rule holds
 * literally: the adapter takes its client as a required dependency, which is also what makes its whole
 * surface testable without AWS. Credentials come from the default provider chain (`AWS_PROFILE`, task
 * role, …) — this file names none of them.
 */
export function createLLMPort(config: AppConfig): LLMPort {
  return new BedrockLLMAdapter({ client: new BedrockRuntimeClient({ region: config.awsRegion }) });
}

/**
 * The exporters this deployment can produce, keyed by format (§2 step 13).
 *
 * A map rather than a switch because format selection is *not* a backend choice: SPEC §12 names
 * `Html`/`Pdf` as later formats, and a deployment offers all of them at once. Adding one is one line
 * here — the same one-entry rule §10 applies to layouts and models.
 *
 * The key must equal the exporter's own `format` field; `ExportService` verifies that on every lookup
 * rather than trusting it, because a mismatch would otherwise surface as a correctly-named file full of
 * the wrong bytes.
 */
export function createExporters(_config: AppConfig): Record<string, Exporter> {
  return { pptx: new PptxExporter() };
}
