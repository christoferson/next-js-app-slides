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
 * Tests build their own container via `createContainer(configOverrides, portOverrides)`, proving the
 * container itself is swappable rather than a hardcoded prod wiring (§3).
 */

import { loadConfig, type AppConfig } from "@/lib/config";
import type { AssetStore, AuthProvider, BrandRepository, DeckRepository } from "@/lib/ports";
import type { LLMPort } from "@/lib/ports/llm-port";
import {
  createAssetStore, createAuthProvider, createBrandRepository, createDeckRepository, createLLMPort,
} from "@/lib/repositories/factory";

/**
 * The ports wired so far. This grows to the full `Ports` shape as §2 proceeds: `exporters` arrives
 * with the PPTX exporter (step 13). Naming the subset explicitly — rather than typing this as
 * `Partial<Ports>` — means a consumer can never reach for a port that isn't wired yet and get
 * `undefined` at runtime.
 */
export interface Container {
  readonly config: AppConfig;
  readonly brands: BrandRepository;
  readonly decks: DeckRepository;
  readonly assets: AssetStore;
  readonly auth: AuthProvider;
  /**
   * Lazy, unlike the others. Constructing a `BedrockRuntimeClient` resolves credentials, and §1.3
   * requires `/api/registry/*` to be served with none configured — so the client must not exist until
   * a request actually generates something. A test can substitute a mocked port via `overrides`.
   */
  readonly llm: () => LLMPort;
}

/**
 * Pre-built ports, substituted instead of constructed. Config overrides stay the first parameter
 * because selecting a backend is the common case; this exists for ports that have no in-memory
 * *backend* to select — an `LLMPort` is mocked with canned responses (§9), not swapped for a second
 * real implementation.
 */
export interface PortOverrides {
  llm?: LLMPort;
}

export function createContainer(
  overrides: Partial<AppConfig> = {},
  ports: PortOverrides = {},
): Container {
  const config: AppConfig = { ...loadConfig(), ...overrides };
  let llm = ports.llm;
  return {
    config,
    brands: createBrandRepository(config),
    decks: createDeckRepository(config),
    assets: createAssetStore(config),
    auth: createAuthProvider(config),
    llm: () => (llm ??= createLLMPort(config)),
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
