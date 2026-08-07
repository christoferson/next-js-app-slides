/**
 * The model registry (SPEC §8). Adding a model is ONE entry here.
 *
 * ## Every id is an inference-profile id, and that is not cosmetic
 *
 * §1.2's critical finding: every ACTIVE Anthropic model in this account is `INFERENCE_PROFILE`-only.
 * None support `ON_DEMAND`, so the bare foundation-model id **fails at invoke time**:
 *
 *     anthropic.claude-opus-5     → ValidationException: "…on-demand throughput isn't supported…"
 *     us.anthropic.claude-opus-5  → works
 *
 * The bare id is what one would write from memory, and it looks *more* correct. This is precisely the
 * class of mistake Prime Directive #1 exists to catch, so the prefix is enforced by a load-time
 * invariant below rather than left to reviewer attention.
 *
 * ## What is and is not verified here
 *
 * Only `us.anthropic.claude-opus-5` was actually **invoked** during the spike (1849 ms round-trip, and
 * the source of the request/stream/error facts in `bedrock-anthropic.ts`). The others were enumerated
 * as present, `ACTIVE`, and streaming-capable in this account, but not invoked — so `verified` records
 * the difference honestly instead of implying a round-trip nobody made. `contextWindow` values are
 * **not** from the spike; they are used only to size `maxTokens` requests and are marked ⚠️ VERIFY.
 */

import type { ModelDescriptor, ModelFamily } from "@/lib/models/types";
import { ModelNotConfigured } from "@/lib/errors/errors";

/**
 * Bedrock requires this exact string in every Anthropic request body; a wrong value returns
 * "Invalid API version" (§1.2). It is a property of the *family's* wire protocol, not of a model.
 */
export const ANTHROPIC_BEDROCK_VERSION = "bedrock-2023-05-31";

/** Inference-profile prefixes seen in this account. A bare id is a configuration error. */
const PROFILE_PREFIXES = ["us.", "global.", "eu.", "apac."] as const;

export interface RegisteredModel extends ModelDescriptor {
  /**
   * True only where the spike actually invoked the model. `false` means "enumerated as ACTIVE in the
   * account but never round-tripped" — selectable, but a failure on first use is a ⚠️ VERIFY item and
   * not a surprise.
   */
  verified: boolean;
}

/**
 * ⚠️ VERIFY on `contextWindow`: these are not measured. Bedrock does not report a context window
 * through `ListFoundationModels`, and the spike had no reason to probe one. They are used solely to
 * bound `maxTokens`, where being conservative costs nothing.
 */
export const LLM_MODELS: readonly RegisteredModel[] = [
  {
    id: "us.anthropic.claude-opus-5",
    displayName: "Claude Opus 5",
    family: "anthropic",
    contextWindow: 200_000,
    supportsTemperature: true,
    defaultTemperature: 1,
    verified: true,
  },
  {
    id: "us.anthropic.claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    family: "anthropic",
    contextWindow: 200_000,
    supportsTemperature: true,
    defaultTemperature: 1,
    verified: false,
  },
  {
    id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    displayName: "Claude Haiku 4.5",
    family: "anthropic",
    contextWindow: 200_000,
    supportsTemperature: true,
    defaultTemperature: 1,
    verified: false,
  },
];

/** §1.2's invoked default, and the value `DEFAULT_LLM_MODEL_ID` is expected to carry. */
export const DEFAULT_MODEL_ID = "us.anthropic.claude-opus-5";

const byId = new Map<string, RegisteredModel>(LLM_MODELS.map((m) => [m.id, m]));

export const allModels = (): readonly RegisteredModel[] => LLM_MODELS;

export const findModel = (modelId: string): RegisteredModel | undefined => byId.get(modelId);

/**
 * The descriptor for a model id, or a readable failure.
 *
 * An unregistered id is *our* configuration error, not the user's — a `DEFAULT_LLM_MODEL_ID` typo
 * would otherwise surface as a Bedrock `ValidationException` mid-generation, which is both slower and
 * far harder to diagnose than failing here with the valid ids listed.
 *
 * Two distinct failures, because they have different fixes and different audiences:
 *
 *  - **Empty id** — nothing is configured. `loadConfig` cannot reject this at startup (§1.3: the app
 *    must boot and serve the registries with no AWS configuration), so the first generate request is the
 *    only place it can be reported, and it gets a `ModelNotConfigured` 503 naming the env var. Left as a
 *    plain `Error` it became an opaque `Internal` 500 — "something went wrong on our side" for what is
 *    really one unset variable.
 *  - **A non-empty id that is not registered** — a typo, or a model removed from the registry. Still a
 *    plain `Error` → `Internal` 500, deliberately: an operator DID configure something, so the useful
 *    output is the full list in the server log, and the id itself must not reach the client (it is
 *    `detail`-class information, and it is attacker-uncontrolled but still ours).
 */
export function requireModel(modelId: string): RegisteredModel {
  if (modelId.trim() === "") throw ModelNotConfigured(LLM_MODELS.map((m) => m.id));

  const model = byId.get(modelId);
  if (!model) {
    throw new Error(
      `Unknown model id "${modelId}". Registered models: ${LLM_MODELS.map((m) => m.id).join(", ")}. `
      + "Add an entry to lib/models/registry.ts — and verify the inference-profile prefix.",
    );
  }
  return model;
}

/** API-safe projection for the model picker (`/api/registry/models`). */
export interface ModelSummary {
  id: string;
  displayName: string;
  family: ModelFamily;
  supportsTemperature: boolean;
  defaultTemperature: number;
  verified: boolean;
}

export const modelSummaries = (): ModelSummary[] =>
  LLM_MODELS.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    family: m.family,
    supportsTemperature: m.supportsTemperature,
    defaultTemperature: m.defaultTemperature,
    verified: m.verified,
  }));

/**
 * Clamp a requested temperature (SPEC §8: "temperature UI-gated + server-clamped").
 *
 * Clamped rather than rejected because temperature arrives from a UI slider, and a request failing
 * because a client sent 1.001 would be a worse outcome than quietly using 1. A model that does not
 * support the parameter gets `undefined`, so the adapter omits the key entirely rather than sending a
 * value the family would reject.
 */
export function clampTemperature(
  model: Pick<RegisteredModel, "supportsTemperature" | "defaultTemperature">,
  requested: number | undefined,
): number | undefined {
  if (!model.supportsTemperature) return undefined;
  if (requested === undefined || !Number.isFinite(requested)) return model.defaultTemperature;
  return Math.min(1, Math.max(0, requested));
}

/* ─────────────────────────────── load-time invariants ─────────────────────────────── */

export function modelProblems(model: RegisteredModel): string[] {
  const problems: string[] = [];
  const where = `model "${model.id}"`;

  if (!PROFILE_PREFIXES.some((p) => model.id.startsWith(p))) {
    problems.push(
      `${where} is not an inference-profile id. §1.2 verified that bare foundation-model ids fail `
      + `with "on-demand throughput isn't supported" in this account — prefix it with one of `
      + `${PROFILE_PREFIXES.join(", ")}.`,
    );
  }
  if (model.displayName.trim() === "") problems.push(`${where} has no displayName.`);
  if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) {
    problems.push(`${where} has a non-positive contextWindow.`);
  }
  if (model.defaultTemperature < 0 || model.defaultTemperature > 1) {
    problems.push(`${where} has a defaultTemperature outside 0–1.`);
  }
  if (!model.supportsTemperature && model.defaultTemperature !== 0) {
    // Not a wire error, but a descriptor that contradicts itself — the value can never be used.
    problems.push(`${where} declares supportsTemperature: false yet sets a defaultTemperature.`);
  }
  return problems;
}

export function registryProblems(models: readonly RegisteredModel[] = LLM_MODELS): string[] {
  const problems = models.flatMap(modelProblems);

  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) problems.push(`duplicate model id "${model.id}".`);
    seen.add(model.id);
  }
  if (models.length === 0) problems.push("the model registry is empty.");
  if (!seen.has(DEFAULT_MODEL_ID)) {
    problems.push(`DEFAULT_MODEL_ID "${DEFAULT_MODEL_ID}" is not in the registry.`);
  }
  return problems;
}

/**
 * Throws at module load, for the same reason the layout registry does: these are authoring mistakes
 * in static data, unreachable from user input, and the alternative failure is a `ValidationException`
 * from Bedrock partway through generating someone's deck.
 */
export function assertRegistryInvariants(models: readonly RegisteredModel[] = LLM_MODELS): void {
  const problems = registryProblems(models);
  if (problems.length > 0) {
    throw new Error(`Invalid model registry:\n  - ${problems.join("\n  - ")}`);
  }
}

assertRegistryInvariants();
