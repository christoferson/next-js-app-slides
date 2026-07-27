/**
 * CLAUDE.md §2 step 6 / §3 — backend selection. Together with `lib/container.ts`, the ONLY place
 * concrete implementations are constructed. That is lint-enforced: every other layer is forbidden
 * from importing `lib/repositories/**` or `lib/adapters/**` (§5).
 *
 * §6.3's swap claim is literal — adding DynamoDB is **one case per switch below**, with zero
 * service or route changes. The `memory` cases exist to prove that claim is already true.
 */

import type { AppConfig } from "@/lib/config";
import type { AssetStore, AuthProvider, BrandRepository, DeckRepository } from "@/lib/ports";
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
