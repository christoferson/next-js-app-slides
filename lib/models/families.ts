/**
 * Family Strategies: request-body construction and stream decoding, one per wire schema (SPEC §8).
 *
 * This exists so **no model-id branching happens anywhere**. The adapter resolves a family from the
 * registry descriptor and calls these; adding a model with the same schema needs no code here, and
 * adding a *family* is one entry in `FAMILIES` plus one `ModelFamily` union member.
 *
 * ## Everything below is measured, not remembered (§1.2, Prime Directive #1)
 *
 * The Anthropic-on-Bedrock schema was probed in this account, including the failure modes:
 *   - `anthropic_version: "bedrock-2023-05-31"` is REQUIRED → "Invalid API version" if wrong;
 *   - `max_tokens` is REQUIRED → "max_tokens: Field required" if omitted;
 *   - content is a block array (`[{type:"text", text}]`), not a bare string;
 *   - non-streaming text is at `content[0].text`;
 *   - streaming text is at `chunk.delta.text` where `chunk.type === "content_block_delta"`, and the
 *     observed sequence is `message_start → content_block_start → content_block_delta ×N →
 *     content_block_stop → message_delta → message_stop`.
 *
 * Deliberately NOT split into separate files per family: with one family, a directory of strategies
 * would be indirection with nothing behind it. The seam that matters is the interface.
 */

import type { ModelFamily } from "@/lib/models/types";
import { ANTHROPIC_BEDROCK_VERSION } from "@/lib/models/registry";

/** What the adapter hands a family, already resolved (temperature clamped, model looked up). */
export interface FamilyRequest {
  system?: string;
  prompt: string;
  maxTokens: number;
  /** Already clamped, and already `undefined` when the model doesn't support it. */
  temperature?: number;
}

/** What a family extracts from a non-streaming response body. */
export interface FamilyCompletion {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  stopReason?: string;
}

export interface ModelFamilyStrategy {
  family: ModelFamily;
  /** The JSON body, ready to serialize. */
  buildBody(request: FamilyRequest): Record<string, unknown>;
  /** Pull text/usage/stop reason out of a parsed non-streaming response. */
  parseCompletion(body: unknown): FamilyCompletion;
  /**
   * One decoded stream event → the text it contributes, or `undefined` for events that carry none.
   *
   * `undefined` means **skip**, never error. §1.2's sequence includes five event types that are not
   * text deltas, and a future model version may add more — mirroring §12's "unknown event types
   * logged + skipped" discipline is what keeps a new envelope field from breaking generation.
   */
  decodeStreamEvent(event: unknown): string | undefined;
  /**
   * The stop reason from a terminal stream event, if this one carries it. Needed because a
   * `max_tokens` truncation is otherwise invisible in a stream — the text simply ends.
   */
  streamStopReason?(event: unknown): string | undefined;
}

/* ─────────────────────────────── anthropic ─────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * `content` is an array of typed blocks; text lives in the `text` blocks.
 *
 * Concatenating *all* text blocks rather than reading `content[0].text`: the spike observed a single
 * block, but a response containing a leading non-text block (a thinking block, say) would silently
 * yield `undefined` under the indexed read, and the caller would see an empty slide rather than an
 * error. Joining what is there is both correct for the observed shape and safe for the other one.
 */
const anthropicText = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
};

const anthropicUsage = (usage: unknown): FamilyCompletion["usage"] => {
  if (!isRecord(usage)) return undefined;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  return { inputTokens, outputTokens };
};

export const anthropicFamily: ModelFamilyStrategy = {
  family: "anthropic",

  buildBody(request) {
    const body: Record<string, unknown> = {
      // Both of these are mandatory — §1.2 confirmed each by omitting it and reading the error.
      anthropic_version: ANTHROPIC_BEDROCK_VERSION,
      max_tokens: request.maxTokens,
      messages: [{ role: "user", content: [{ type: "text", text: request.prompt }] }],
    };
    // Omitted rather than sent as `undefined`: an explicit null would reach the JSON body.
    if (request.system !== undefined && request.system !== "") body.system = request.system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    return body;
  },

  parseCompletion(body) {
    if (!isRecord(body)) return { text: "" };
    return {
      text: anthropicText(body.content),
      usage: anthropicUsage(body.usage),
      ...(typeof body.stop_reason === "string" ? { stopReason: body.stop_reason } : {}),
    };
  },

  decodeStreamEvent(event) {
    if (!isRecord(event) || event.type !== "content_block_delta") return undefined;
    const delta = event.delta;
    if (!isRecord(delta) || typeof delta.text !== "string") return undefined;
    return delta.text;
  },

  /**
   * `message_delta` carries the final `stop_reason` (`message_stop` does not). Read from
   * `delta.stop_reason`, with the top-level checked too so a shape change in either place is
   * tolerated rather than silently losing truncation detection.
   */
  streamStopReason(event) {
    if (!isRecord(event) || event.type !== "message_delta") return undefined;
    const delta = event.delta;
    if (isRecord(delta) && typeof delta.stop_reason === "string") return delta.stop_reason;
    return typeof event.stop_reason === "string" ? event.stop_reason : undefined;
  },
};

/* ─────────────────────────────── resolution ─────────────────────────────── */

const FAMILIES: Record<ModelFamily, ModelFamilyStrategy> = {
  anthropic: anthropicFamily,
};

/**
 * The family for a descriptor. Total over `ModelFamily`, so a new union member is a **compile**
 * error in `FAMILIES` rather than a runtime surprise at generation time.
 */
export const familyFor = (family: ModelFamily): ModelFamilyStrategy => FAMILIES[family];

/** `stop_reason` values that mean the response was cut off rather than finished (§1.2 §2). */
export const isTruncatedStopReason = (stopReason: string | undefined): boolean =>
  stopReason === "max_tokens";
