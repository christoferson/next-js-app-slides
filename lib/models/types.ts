/**
 * Model registry types — SPEC §8. The registry itself (step 10) is typed code, not user data.
 *
 * `family` is the whole point: the adapter picks a family Strategy for request-body construction
 * and stream decoding, so **no model-id branching exists anywhere**. Adding a model is one
 * registry entry.
 */

/** One value per request/stream schema, NOT per model. Extend when a new schema appears. */
export type ModelFamily = "anthropic";

export interface ModelDescriptor {
  /**
   * The id passed to Bedrock. §1.2 CRITICAL FINDING: every ACTIVE Anthropic model in this
   * account is INFERENCE_PROFILE-only, so this must be a profile id (`us.anthropic.…`), not a
   * bare foundation-model id. The bare id looks more correct and fails at invoke time.
   */
  id: string;
  displayName: string;
  family: ModelFamily;
  contextWindow: number;
  supportsTemperature: boolean;
  /** Used when the UI leaves temperature unset; server-clamped regardless (SPEC §8). */
  defaultTemperature: number;
}
