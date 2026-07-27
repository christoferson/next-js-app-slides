/**
 * CLAUDE.md §2 step 3 — the LLM PORT.
 *
 * Everything Bedrock-shaped stops at this line. Services see prompts in and text out; the
 * adapter owns request-body construction, the stream envelope, and error mapping (§1.2 measured
 * all three: text at `content[0].text`, deltas at `chunk.delta.text` when
 * `chunk.type === "content_block_delta"`, and the concrete error shapes now mapped in
 * `lib/errors/errors.ts`).
 *
 * The port is deliberately NOT "generate a slide" — it is "complete this prompt". Slot schemas,
 * repair passes, and fallbacks belong to `lib/generation`, which must be testable against a
 * mocked port with canned responses (§9).
 */

export interface LlmRequest {
  /** Registry model id; the adapter resolves the family Strategy from it. */
  modelId: string;
  /** System instruction. Content guidance only — never visual vocabulary (§7). */
  system?: string;
  prompt: string;
  maxTokens: number;
  /** Ignored by the adapter when the descriptor says `supportsTemperature: false`. */
  temperature?: number;
  /** Cooperative cancellation — a client abort must stop in-flight model work (§9). */
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  /** Concatenated model text. Hostile input by policy: always validated downstream. */
  text: string;
  /** Absent when a family/response omits usage — never fabricated. */
  usage?: LlmUsage;
  /** e.g. Anthropic `stop_reason`; surfaced because `max_tokens` truncation must be detectable. */
  stopReason?: string;
}

/** One decoded text delta. The adapter has already unwrapped the family's chunk envelope. */
export interface LlmTextDelta {
  text: string;
}

export interface LLMPort {
  /** Non-streaming completion — used for the outline and the repair pass. */
  complete(request: LlmRequest): Promise<LlmResponse>;
  /**
   * Streaming completion. Yields only text deltas; the final aggregate is the concatenation of
   * everything yielded, so a caller that needs both can accumulate as it forwards to SSE.
   * Throws mapped `AppError`s (never raw SDK errors) — including mid-stream.
   */
  stream(request: LlmRequest): AsyncIterable<LlmTextDelta>;
}
