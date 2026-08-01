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
import { registryLookup } from "@/lib/layouts/registry";
import { createPromptLogger } from "@/lib/generation/prompt-log";
import { ulid } from "@/lib/util/ids";
import { BrandService } from "@/lib/services/brand-service";
import { DeckService } from "@/lib/services/deck-service";
import { GenerationService } from "@/lib/services/generation-service";
import { LayoutMappingService } from "@/lib/services/layout-mapping-service";
import { OutlineService } from "@/lib/services/outline-service";

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
  /** §2 step 12. The facade (step 14) is assembled from exactly these. */
  readonly services: Services;
}

/**
 * The service layer, wired over the ports above.
 *
 * Services are constructed eagerly — unlike the LLM port — because none of them touches AWS or the
 * filesystem at construction time; they only hold references. `GenerationService` and `OutlineService`
 * receive the *thunk*, not a port, which is what preserves §1.3 through this layer: building the
 * container must not resolve credentials even though two of its services will eventually need them.
 */
export interface Services {
  readonly brands: BrandService;
  readonly decks: DeckService;
  readonly mapping: LayoutMappingService;
  readonly outline: OutlineService;
  readonly generation: GenerationService;
}

/**
 * Pre-built ports, substituted instead of constructed. Config overrides stay the first parameter
 * because selecting a backend is the common case; this exists for ports that have no in-memory
 * *backend* to select — an `LLMPort` is mocked with canned responses (§9), not swapped for a second
 * real implementation.
 *
 * `now`/`newId` are here for the same reason: a service test asserting a stored timestamp needs a fixed
 * clock, and threading one through every service constructor from a test would duplicate the wiring
 * this file exists to own. Defaults are the real thing.
 */
export interface PortOverrides {
  llm?: LLMPort;
  now?: () => number;
  newId?: () => string;
}

export function createContainer(
  overrides: Partial<AppConfig> = {},
  ports: PortOverrides = {},
): Container {
  const config: AppConfig = { ...loadConfig(), ...overrides };
  let llm = ports.llm;
  const llmThunk = (): LLMPort => (llm ??= createLLMPort(config));

  const brands = createBrandRepository(config);
  const decks = createDeckRepository(config);
  const assets = createAssetStore(config);

  const now = ports.now ?? Date.now;
  const newId = ports.newId ?? (() => ulid());
  // Built once, not per prompt: `createPromptLogger` returns a shared no-op when the flag is off, so
  // every `onPrompt?.()` in the pipelines costs one call rather than a per-request closure.
  const onPrompt = createPromptLogger(config.debugPrompts);

  const brandService = new BrandService({
    brands, decks, assets, layouts: registryLookup, now, newId,
  });
  const deckService = new DeckService({ decks, now, newId });
  const mapping = new LayoutMappingService();

  return {
    config,
    brands,
    decks,
    assets,
    auth: createAuthProvider(config),
    llm: llmThunk,
    services: {
      brands: brandService,
      decks: deckService,
      mapping,
      outline: new OutlineService({
        decks: deckService, brands: brandService, mapping,
        llm: llmThunk, modelId: config.outlineModelId, onPrompt,
      }),
      generation: new GenerationService({
        slides: decks, decks: deckService, brands: brandService, mapping,
        llm: llmThunk, modelId: config.defaultLlmModelId,
        concurrency: config.generationConcurrency, now, newId, onPrompt,
      }),
    },
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
