/**
 * `LLMPort` over Bedrock (CLAUDE.md §2 step 10). The ONLY file that imports `@aws-sdk/*` for the
 * model path, and the only place AWS error shapes are interpreted (§5 boundary).
 *
 * Three responsibilities, and nothing else:
 *  1. resolve the model descriptor → family Strategy (no model-id branching — SPEC §8);
 *  2. drive `InvokeModel` / `InvokeModelWithResponseStream`;
 *  3. translate every AWS failure into an `AppError` whose text is safe to show a person (§13).
 *
 * ## Why the error mapping looks the way it does
 *
 * §1.2 measured the real shapes, and the important finding is that **`ValidationException` is
 * overloaded**: the same name covers a bogus model id, a bare (non-profile) id, a wrong region, and a
 * malformed body. `name` alone cannot distinguish them, so `mapModelError` sub-classifies on message
 * signature. That is admittedly brittle against AWS message wording — which is exactly why the
 * signatures live in named constants here, `detail` carries the original for logs, and every branch
 * falls back to a readable generic rather than leaking the AWS text.
 *
 * ⚠️ VERIFY (from §1.2, unchanged): `AccessDeniedException` and `ThrottlingException` were NOT
 * reproducible in this account — these are admin credentials, and throttling cannot be triggered
 * without abusing the account. They are mapped from documented shapes, so the mapping is *unverified*
 * for those two names. The SDK retries throttles internally (`maxAttempts`), so what reaches us is
 * the FINAL failure; surfacing it readably per-slide is what makes §9's "other slides continue,
 * `deck-done {ok, failed}` accurate" hold.
 */

import {
  type BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { LLMPort, LlmRequest, LlmResponse, LlmTextDelta } from "@/lib/ports/llm-port";
import { familyFor, type ModelFamilyStrategy } from "@/lib/models/families";
import { clampTemperature, requireModel } from "@/lib/models/registry";
import {
  AppError, ModelAccessDenied, ModelInvalidRequest, ModelThrottled, ModelTimeout, ModelUnavailable,
} from "@/lib/errors/errors";

/**
 * Message fragments that sub-classify an overloaded `ValidationException` (§1.2 §5).
 *
 * Matched case-insensitively on a substring: the wording is AWS's and may be reworded, so a failed
 * match must degrade to the generic branch rather than throw. Each one is quoted verbatim from the
 * spike's recorded output.
 */
const SIGNATURES = {
  /** "…with on-demand throughput isn't supported. Retry…with…an inference profile…" */
  onDemandUnsupported: "on-demand throughput",
  /** "The provided model identifier is invalid." — bogus id AND profile-in-wrong-region. */
  invalidIdentifier: "model identifier is invalid",
} as const;

const messageOf = (err: unknown): string =>
  err instanceof Error && typeof err.message === "string" ? err.message : "";

const nameOf = (err: unknown): string =>
  typeof (err as { name?: unknown })?.name === "string" ? (err as { name: string }).name : "";

const includes = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * A cancellation, from either side of the boundary: our own pre-flight check or the SDK aborting an
 * in-flight request. Both surface as `name === "AbortError"`, and both mean the same thing.
 */
const isAbort = (err: unknown): boolean => nameOf(err) === "AbortError";

/**
 * Any thrown value from the AWS SDK → an `AppError`.
 *
 * Exported for its own test: the §1.2 table is the specification, and a table-test is the only way to
 * assert a mapping whose inputs cannot all be produced on demand.
 */
export function mapModelError(err: unknown, modelId: string): AppError {
  // Already ours (e.g. thrown by `requireModel`'s caller path) — do not re-wrap and re-word.
  if (err instanceof AppError) return err;

  const name = nameOf(err);
  const message = messageOf(err);

  // A cancellation reaching *here* is a defensive path only — both entry points rethrow aborts
  // unchanged so the pipeline can tell "the user hung up" from "the model failed". This branch exists
  // because the function's return type is `AppError`: it cannot pass a raw abort through, and a
  // timeout is the least wrong of the available codes.
  if (isAbort(err)) return ModelTimeout(err);

  switch (name) {
    case "AccessDeniedException":
      // ⚠️ Unverified shape — see the header.
      return ModelAccessDenied(modelId, err);

    case "ThrottlingException":
    case "TooManyRequestsException":
      // ⚠️ Unverified shape — see the header.
      return ModelThrottled(err);

    case "ModelTimeoutException":
    case "TimeoutError":
      return ModelTimeout(err);

    case "ModelNotReadyException":
    case "ServiceUnavailableException":
    case "InternalServerException":
      return ModelUnavailable(modelId, err);

    case "ResourceNotFoundException":
      // §1.2: a retired model version — "This model version has reached the end of its life."
      return ModelUnavailable(modelId, err);

    case "UnrecognizedClientException":
      // Invalid/expired credentials (403). Deliberately mapped to access-denied rather than an
      // internal error: the readable text ("an administrator needs to enable access") is the correct
      // instruction for a deployment whose credentials are wrong, and it leaks nothing.
      return ModelAccessDenied(modelId, err);

    case "ValidationException": {
      // The overloaded case. Both signatures mean "this id will never work as configured", which is a
      // deployment problem the operator can act on, so they map to `ModelUnavailable` rather than the
      // "our bug" wording of `ModelInvalidRequest`.
      if (includes(message, SIGNATURES.onDemandUnsupported)) {
        return ModelUnavailable(modelId, err);
      }
      if (includes(message, SIGNATURES.invalidIdentifier)) {
        return ModelUnavailable(modelId, err);
      }
      // Everything else is a malformed body — genuinely our bug (missing `max_tokens`, bad
      // `anthropic_version`). `detail` keeps the AWS message for logs; the user never sees it.
      return ModelInvalidRequest({ modelId, awsMessage: message }, err);
    }

    default:
      // An unmapped SDK error must not surface its own text. Access-denied would be a misleading
      // instruction, so this collapses to "unavailable", which is true of any failure we can't name.
      return ModelUnavailable(modelId, err);
  }
}

/**
 * `send` is all this adapter uses, and narrowing to it is deliberate: the structural type is what
 * lets a test drive the whole surface without AWS, and it documents that nothing else about the
 * client is depended on.
 */
export type BedrockSender = Pick<BedrockRuntimeClient, "send">;

export interface BedrockLLMAdapterOptions {
  /**
   * REQUIRED, with no self-constructed fallback — §3 says the factory is the only place a concrete
   * implementation is built, and a convenience default here would quietly make this a second one.
   * `tests/architecture.test.ts` enforces that, which is how the earlier version of this file was
   * caught. The client is built in `lib/repositories/factory.ts`; this adapter only sends with it.
   */
  client: BedrockSender;
}

export class BedrockLLMAdapter implements LLMPort {
  private readonly client: BedrockSender;

  constructor(options: BedrockLLMAdapterOptions) {
    this.client = options.client;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const { family, body } = this.prepare(request);
    throwIfAborted(request.signal);

    let output: { body?: Uint8Array };
    try {
      output = await this.client.send(new InvokeModelCommand({
        modelId: request.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
        // `abortSignal` goes in the SDK's per-call options, not the command input, so an aborted
        // request stops in flight rather than completing unobserved.
      }), request.signal ? { abortSignal: request.signal } : undefined) as { body?: Uint8Array };
    } catch (err) {
      if (isAbort(err)) throw err;
      throw mapModelError(err, request.modelId);
    }

    const parsed = family.parseCompletion(decodeJson(output.body, request.modelId));
    return {
      text: parsed.text,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...(parsed.stopReason !== undefined ? { stopReason: parsed.stopReason } : {}),
    };
  }

  /**
   * Streaming completion. An `async *` method rather than a function returning an iterable so the
   * abort check and the error mapping apply to the *whole* stream, including mid-stream failures —
   * §1.2 notes a throttle can arrive after the first delta, and §9 requires that slide to error
   * readably while the rest of the deck continues.
   */
  async *stream(request: LlmRequest): AsyncIterable<LlmTextDelta> {
    const { family, body } = this.prepare(request);
    throwIfAborted(request.signal);

    let response: { body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> };
    try {
      response = await this.client.send(new InvokeModelWithResponseStreamCommand({
        modelId: request.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      }), request.signal ? { abortSignal: request.signal } : undefined) as {
        body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>;
      };
    } catch (err) {
      if (isAbort(err)) throw err;
      throw mapModelError(err, request.modelId);
    }

    if (!response.body) return;

    try {
      for await (const item of response.body) {
        throwIfAborted(request.signal);
        const bytes = item.chunk?.bytes;
        if (!bytes) continue;

        const event = parseStreamEvent(bytes);
        // A frame we cannot parse is SKIPPED, not fatal: one malformed chunk must not discard a slide
        // whose other deltas were fine. Same discipline as §12's SSE parser.
        if (event === undefined) continue;

        const text = family.decodeStreamEvent(event);
        if (text !== undefined && text !== "") yield { text };
      }
    } catch (err) {
      // An abort passes through unmapped: §9 requires the pipeline to distinguish "the client hung up"
      // (stop the remaining slides, persist the completed ones) from a model failure (this slide errors,
      // the deck continues). Mapping it to `ModelTimeout` here would erase that difference.
      if (isAbort(err)) throw err;
      throw mapModelError(err, request.modelId);
    }
  }

  /** Registry lookup + family resolution + body construction. Shared by both entry points. */
  private prepare(request: LlmRequest): { family: ModelFamilyStrategy; body: Record<string, unknown> } {
    const model = requireModel(request.modelId);
    const family = familyFor(model.family);
    // Clamped here, once, so neither the family nor a service can send an out-of-range value — and
    // `undefined` for a model that doesn't support it, which omits the key rather than sending null.
    const temperature = clampTemperature(model, request.temperature);

    const body = family.buildBody({
      ...(request.system !== undefined ? { system: request.system } : {}),
      prompt: request.prompt,
      maxTokens: request.maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
    });
    return { family, body };
  }
}

/* ─────────────────────────────── decoding helpers ─────────────────────────────── */

const decoder = new TextDecoder();

function decodeJson(bytes: Uint8Array | undefined, modelId: string): unknown {
  if (!bytes) throw ModelInvalidRequest({ modelId, reason: "empty response body" });
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (err) {
    // The model answered with something that isn't JSON at all. Not the caller's fault and not
    // recoverable here; `lib/generation` cannot repair what it never received.
    throw ModelInvalidRequest({ modelId, reason: "response body was not JSON" }, err);
  }
}

/** `undefined` for an unparseable frame — the caller skips it rather than failing the stream. */
function parseStreamEvent(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    // Not a model error: the client hung up or the deck was cancelled. §9 requires completed slides to
    // persist and remaining ones to stop, which the generation pipeline handles — it needs a
    // distinguishable throw, not a readable model failure.
    throw new DOMException("Aborted", "AbortError");
  }
}
