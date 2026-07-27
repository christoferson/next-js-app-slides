/**
 * §6.2 — the shared contract suite run against the MEMORY backend.
 * `tests/file-repositories.test.ts` runs the identical suite against the file backend.
 */

import { assetStoreContract, brandRepositoryContract, deckRepositoryContract } from "@/tests/repository-contract";
import { MemoryBrandRepository } from "@/lib/repositories/memory/memory-brand-repository";
import { MemoryDeckRepository } from "@/lib/repositories/memory/memory-deck-repository";
import { MemoryAssetStore } from "@/lib/repositories/memory/memory-asset-store";

brandRepositoryContract("memory", async () => new MemoryBrandRepository());
deckRepositoryContract("memory", async () => new MemoryDeckRepository());
assetStoreContract("memory", async () => new MemoryAssetStore());
