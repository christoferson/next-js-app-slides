/**
 * THE COMPOSITION ROOT (CLAUDE.md §3, SPEC §14).
 *
 * Rules this file carries alone:
 *  - Config is read once (`loadConfig`) and backends are selected once.
 *  - It is the only module — with `repositories/factory.ts`, which it delegates to — permitted to
 *    construct concrete implementations. Lint forbids every other layer from importing
 *    `lib/repositories/**` or `lib/adapters/**` (§5).
 *  - Routes obtain the facade from here; they never build anything.
 *
 * The singleton is lazy so that importing this module has no side effects — which is what lets
 * `/api/registry/*` be served with no AWS credentials and no DATA_DIR write (§1.3): nothing is
 * constructed until a request actually needs it.
 *
 * Tests build their own container via `createContainer(configOverrides)`, proving the container
 * itself is swappable rather than a hardcoded prod wiring (§3).
 */

import { loadConfig, type AppConfig } from "@/lib/config";
import type { AssetStore, AuthProvider, BrandRepository, DeckRepository } from "@/lib/ports";
import {
  createAssetStore, createAuthProvider, createBrandRepository, createDeckRepository,
} from "@/lib/repositories/factory";

/**
 * The ports wired so far. This grows to the full `Ports` shape as §2 proceeds: `llm` arrives with
 * the Bedrock adapter (step 10) and `exporters` with the PPTX exporter (step 13). Naming the
 * subset explicitly — rather than typing this as `Partial<Ports>` — means a consumer can never
 * reach for a port that isn't wired yet and get `undefined` at runtime.
 */
export interface Container {
  readonly config: AppConfig;
  readonly brands: BrandRepository;
  readonly decks: DeckRepository;
  readonly assets: AssetStore;
  readonly auth: AuthProvider;
}

export function createContainer(overrides: Partial<AppConfig> = {}): Container {
  const config: AppConfig = { ...loadConfig(), ...overrides };
  return {
    config,
    brands: createBrandRepository(config),
    decks: createDeckRepository(config),
    assets: createAssetStore(config),
    auth: createAuthProvider(config),
  };
}

let singleton: Container | undefined;

/** The accessor routes use. Lazy — see the note above about import-time side effects. */
export function getContainer(): Container {
  singleton ??= createContainer();
  return singleton;
}

/** Test-only escape hatch, so one test's container can't leak into the next. */
export function resetContainer(): void {
  singleton = undefined;
}
