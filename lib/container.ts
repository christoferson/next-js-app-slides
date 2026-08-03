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
import type { Exporter } from "@/lib/ports/exporter";
import type { LLMPort } from "@/lib/ports/llm-port";
import {
  createAssetStore, createAuthProvider, createBrandRepository, createDeckRepository, createExporters,
  createLLMPort,
} from "@/lib/repositories/factory";
import { registryLookup } from "@/lib/layouts/registry";
import { createPromptLogger } from "@/lib/generation/prompt-log";
import { ulid } from "@/lib/util/ids";
import { BrandService } from "@/lib/services/brand-service";
import { DeckService } from "@/lib/services/deck-service";
import { GenerationService } from "@/lib/services/generation-service";
import { LayoutMappingService } from "@/lib/services/layout-mapping-service";
import { OutlineService } from "@/lib/services/outline-service";
import { ExportService } from "@/lib/services/export-service";
import { StudioFacade } from "@/lib/facade/studio-facade";

/**
 * Every port, wired. This now matches the full `Ports` shape (`lib/ports/index.ts`) — the subset note
 * that stood here through steps 6–12 is gone because `exporters` was the last one outstanding.
 *
 * Still named field-by-field rather than typed as `Ports`, because two fields deliberately differ from
 * it: `llm` is a thunk (see below) and `config`/`services` are not ports at all.
 */
export interface Container {
  readonly config: AppConfig;
  readonly brands: BrandRepository;
  readonly decks: DeckRepository;
  readonly assets: AssetStore;
  readonly auth: AuthProvider;
  /**
   * Keyed by `Exporter.format` (§2 step 13). Eager: an exporter holds no client and touches no
   * filesystem until `export` is called, so constructing it costs nothing and §1.3 is unaffected.
   */
  readonly exporters: Readonly<Record<string, Exporter>>;
  /**
   * Lazy, unlike the others. Constructing a `BedrockRuntimeClient` resolves credentials, and §1.3
   * requires `/api/registry/*` to be served with none configured — so the client must not exist until
   * a request actually generates something. A test can substitute a mocked port via `overrides`.
   */
  readonly llm: () => LLMPort;
  /** §2 step 12. The facade is assembled from exactly these, plus `auth`. */
  readonly services: Services;
  /**
   * §2 step 14 — what routes actually use. Eager for the same reason the services are: it holds
   * references and constructs nothing, so building it cannot resolve credentials (§1.3).
   */
  readonly facade: StudioFacade;
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
  readonly export: ExportService;
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
  const exporters = createExporters(config);
  const auth = createAuthProvider(config);

  // Named before the return so the facade can be assembled from the SAME instances the container
  // exposes — building it inline would give routes a facade over one set of services while
  // `container.services` handed tests a second, independently-constructed set.
  const services: Services = {
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
    export: new ExportService({ decks: deckService, brands: brandService, exporters }),
  };

  return {
    config,
    brands,
    decks,
    assets,
    auth,
    exporters,
    llm: llmThunk,
    services,
    facade: new StudioFacade({ auth, ...services }),
  };
}

let singleton: Container | undefined;

/** The accessor routes use. Lazy — see the note above about import-time side effects. */
export function getContainer(): Container {
  singleton ??= createContainer();
  return singleton;
}

/**
 * What a route imports. Routes need the facade and nothing else — offering this instead of making them
 * reach through `getContainer().services` is what keeps §5's "routes call lib/facade, not services"
 * a matter of there being no path to a service rather than a rule to remember.
 */
export function getFacade(): StudioFacade {
  return getContainer().facade;
}

/**
 * The config, for the routes that need a knob rather than a use-case.
 *
 * Two do: the deck/briefing schemas are parameterized by `maxSourceTextChars` and the upload route
 * enforces `maxAssetBytes`. Both are HTTP-edge limits — a service cannot apply them, because by the time
 * a service sees a briefing the megabyte has already been parsed and the bytes already buffered.
 *
 * Offered as its own accessor for `getFacade`'s reason: a route that reached `getContainer().config`
 * would have `.services` in scope, and §5's rule would then be a habit again rather than the absence of
 * a path. This returns config and nothing else.
 */
export function getConfig(): AppConfig {
  return getContainer().config;
}

/** Test-only escape hatch, so one test's container can't leak into the next. */
export function resetContainer(): void {
  singleton = undefined;
}
