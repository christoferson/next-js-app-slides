/**
 * The Bedrock adapter (CLAUDE.md §2 step 10: "All AWS error mapping here. Mock-test the adapter
 * surface.").
 *
 * `mapModelError` is table-tested against §1.2's recorded error table, which is the specification.
 * That table is also the reason the mapping is a *pure exported function* rather than inline `catch`
 * logic: two of its rows — `AccessDeniedException` and `ThrottlingException` — cannot be produced on
 * demand in this account (admin credentials; throttling can't be triggered without abusing the
 * account), so a table-test is the only way to assert them at all. Those two rows are marked
 * ⚠️ UNVERIFIED here as well as in the adapter, so a future fix has something to grep for.
 *
 * The `complete`/`stream` tests drive a fake `send`. What they assert is the adapter's *contract with
 * the layers around it*: the body it sends is the family's (no duplicated schema knowledge), a raw SDK
 * error never escapes, and a single malformed stream frame does not discard a slide.
 */

import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors/errors";
import { BedrockLLMAdapter, mapModelError } from "@/lib/adapters/bedrock-llm-adapter";
import { ANTHROPIC_BEDROCK_VERSION, DEFAULT_MODEL_ID } from "@/lib/models/registry";
import type { LlmRequest, LlmTextDelta } from "@/lib/ports/llm-port";

/** An SDK-shaped error: the SDK sets `name` to the AWS exception name, which is what we branch on. */
const awsError = (name: string, message = ""): Error => {
  const err = new Error(message);
  err.name = name;
  return err;
};

const encoder = new TextEncoder();
const bytes = (value: unknown): Uint8Array =>
  encoder.encode(typeof value === "string" ? value : JSON.stringify(value));

const completionBody = (text: string): Uint8Array => bytes({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 4 },
});

const deltaFrame = (text: string) => ({
  chunk: { bytes: bytes({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) },
});

/**
 * A fake `send`, plus its call log. The second parameter is declared because the adapter passes the
 * SDK's per-call options there (`abortSignal`) and a test needs to read it — `Pick<Client, "send">`
 * types it as optional, so omitting it here would silently hide whether it was forwarded at all.
 */
const fakeClient = (impl: (command: unknown) => unknown) => {
  const send = vi.fn(async (command: unknown, _options?: { abortSignal?: AbortSignal }) => impl(command));
  return { client: { send } as never, send };
};

const adapterWith = (impl: (command: unknown) => unknown) => {
  const { client, send } = fakeClient(impl);
  return { adapter: new BedrockLLMAdapter({ client }), send };
};

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  modelId: DEFAULT_MODEL_ID,
  prompt: "Summarize the briefing.",
  maxTokens: 512,
  ...over,
});

const collect = async (stream: AsyncIterable<LlmTextDelta>): Promise<string[]> => {
  const out: string[] = [];
  for await (const delta of stream) out.push(delta.text);
  return out;
};

/* ─────────────────────────────── error mapping ─────────────────────────────── */

/**
 * §1.2's table, transcribed. `messages` are verbatim from the spike's recorded output except where
 * `spikeVerified: false` — those two rows were never reproducible in this account and their shapes come
 * from AWS documentation, so they are the mapping's known-unverified edges (⚠️ VERIFY).
 */
const ERROR_TABLE = [
  { name: "ValidationException", message: "The provided model identifier is invalid.", code: "ModelUnavailable", spikeVerified: true },
  { name: "ValidationException", message: "…with on-demand throughput isn't supported. Retry…", code: "ModelUnavailable", spikeVerified: true },
  { name: "ValidationException", message: "max_tokens: Field required", code: "ModelInvalidRequest", spikeVerified: true },
  { name: "ValidationException", message: "Invalid API version: not-a-version", code: "ModelInvalidRequest", spikeVerified: true },
  { name: "UnrecognizedClientException", message: "The security token included in the request is invalid.", code: "ModelAccessDenied", spikeVerified: true },
  { name: "ResourceNotFoundException", message: "This model version has reached the end of its life.", code: "ModelUnavailable", spikeVerified: true },
  { name: "AccessDeniedException", message: "not authorized to invoke this model", code: "ModelAccessDenied", spikeVerified: false },
  { name: "ThrottlingException", message: "Too many requests", code: "ModelThrottled", spikeVerified: false },
] as const;

describe("mapModelError — §1.2's recorded error table", () => {
  it.each(ERROR_TABLE)("$name ($message) → $code", ({ name, message, code }) => {
    expect(mapModelError(awsError(name, message), DEFAULT_MODEL_ID).code).toBe(code);
  });

  it("has exactly two unverified rows, and they are the two §1.2 named", () => {
    // A tripwire, not a tautology: if someone adds a mapping from a shape nobody measured, this fails
    // and the ⚠️ VERIFY list in VERIFICATION.md has to be updated with it.
    expect(ERROR_TABLE.filter((r) => !r.spikeVerified).map((r) => r.name))
      .toEqual(["AccessDeniedException", "ThrottlingException"]);
  });

  it("maps the profile-in-wrong-region case the same way as a bogus id", () => {
    // §1.2: both produce the identical message, so they are indistinguishable — and the operator
    // action ("this id will never work as configured") is the same for both.
    expect(mapModelError(
      awsError("ValidationException", "The provided model identifier is invalid."), DEFAULT_MODEL_ID,
    ).code).toBe("ModelUnavailable");
  });

  it("matches the ValidationException signatures case-insensitively", () => {
    // The wording is AWS's; casing is the cheapest thing to be robust against.
    expect(mapModelError(
      awsError("ValidationException", "ON-DEMAND THROUGHPUT is not supported"), DEFAULT_MODEL_ID,
    ).code).toBe("ModelUnavailable");
  });

  it("treats an unrecognized ValidationException as OUR bug, keeping the AWS text in detail only", () => {
    const mapped = mapModelError(
      awsError("ValidationException", "some new body complaint"), DEFAULT_MODEL_ID,
    );
    expect(mapped.code).toBe("ModelInvalidRequest");
    expect(mapped.detail).toMatchObject({ awsMessage: "some new body complaint" });
    // The AWS text must not reach the user — §13's readable-errors rule.
    expect(mapped.readable).not.toContain("some new body complaint");
  });

  it.each([
    "ModelTimeoutException", "TimeoutError",
  ])("maps %s to a timeout", (name) => {
    expect(mapModelError(awsError(name), DEFAULT_MODEL_ID).code).toBe("ModelTimeout");
  });

  it.each([
    "ModelNotReadyException", "ServiceUnavailableException", "InternalServerException",
  ])("maps %s to unavailable", (name) => {
    expect(mapModelError(awsError(name), DEFAULT_MODEL_ID).code).toBe("ModelUnavailable");
  });

  it("maps TooManyRequestsException alongside ThrottlingException", () => {
    // ⚠️ UNVERIFIED shape, same caveat as ThrottlingException.
    expect(mapModelError(awsError("TooManyRequestsException"), DEFAULT_MODEL_ID).code)
      .toBe("ModelThrottled");
  });

  it("marks the throttle retryable and the config errors not", () => {
    // What the route/SSE layer keys its "try again" wording off.
    expect(mapModelError(awsError("ThrottlingException"), DEFAULT_MODEL_ID).retryable).toBe(true);
    expect(mapModelError(awsError("AccessDeniedException"), DEFAULT_MODEL_ID).retryable).toBe(false);
  });

  it("collapses an unmapped error to unavailable rather than leaking its text", () => {
    // Access-denied would be a misleading instruction; "unavailable" is true of any failure we can't
    // name, and the original survives as `cause` for logs.
    const err = awsError("SomeFutureException", "internal detail nobody should read");
    const mapped = mapModelError(err, DEFAULT_MODEL_ID);
    expect(mapped.code).toBe("ModelUnavailable");
    expect(mapped.readable).not.toContain("internal detail");
    expect(mapped.cause).toBe(err);
  });

  it("does not re-wrap an AppError it is handed", () => {
    // Reachable when a helper inside the try block already threw ours; re-wrapping would replace a
    // specific readable message with a generic one.
    const ours = mapModelError(awsError("ThrottlingException"), DEFAULT_MODEL_ID);
    expect(mapModelError(ours, DEFAULT_MODEL_ID)).toBe(ours);
  });

  it("maps an abort to a timeout rather than a model failure", () => {
    expect(mapModelError(awsError("AbortError"), DEFAULT_MODEL_ID).code).toBe("ModelTimeout");
  });

  it("never throws, whatever it is handed", () => {
    // It runs inside a `catch`; throwing here would replace a readable error with an opaque one.
    for (const thrown of [null, undefined, 42, "a string", {}, [], new Error("plain")]) {
      expect(() => mapModelError(thrown, DEFAULT_MODEL_ID), JSON.stringify(thrown)).not.toThrow();
      expect(mapModelError(thrown, DEFAULT_MODEL_ID)).toBeInstanceOf(AppError);
    }
  });

  it("records the model id in detail for every branch that has one", () => {
    for (const name of ["AccessDeniedException", "ValidationException", "ResourceNotFoundException"]) {
      expect(mapModelError(awsError(name), "us.anthropic.claude-sonnet-5").detail)
        .toMatchObject({ modelId: "us.anthropic.claude-sonnet-5" });
    }
  });
});

/* ─────────────────────────────── complete() ─────────────────────────────── */

describe("complete", () => {
  it("returns the family-parsed text, usage, and stop reason", async () => {
    const { adapter } = adapterWith(() => ({ body: completionBody("Hello") }));
    await expect(adapter.complete(request())).resolves.toEqual({
      text: "Hello",
      usage: { inputTokens: 10, outputTokens: 4 },
      stopReason: "end_turn",
    });
  });

  it("sends the body the family built, not one assembled here", async () => {
    // The §8-shaped guarantee for models: schema knowledge lives in exactly one place. If the adapter
    // reassembled the body, adding a family would need edits in two files.
    const { adapter, send } = adapterWith(() => ({ body: completionBody("ok") }));
    await adapter.complete(request({ system: "Be brief.", temperature: 0.2 }));

    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input.modelId).toBe(DEFAULT_MODEL_ID);
    expect(input.contentType).toBe("application/json");
    expect(JSON.parse(input.body as string)).toEqual({
      anthropic_version: ANTHROPIC_BEDROCK_VERSION,
      max_tokens: 512,
      messages: [{ role: "user", content: [{ type: "text", text: "Summarize the briefing." }] }],
      system: "Be brief.",
      temperature: 0.2,
    });
  });

  it("clamps an out-of-range temperature before it reaches the wire", async () => {
    const { adapter, send } = adapterWith(() => ({ body: completionBody("ok") }));
    await adapter.complete(request({ temperature: 4 }));
    const input = (send.mock.calls[0]![0] as { input: { body: string } }).input;
    expect(JSON.parse(input.body).temperature).toBe(1);
  });

  it("substitutes the model's default when no temperature is given", async () => {
    const { adapter, send } = adapterWith(() => ({ body: completionBody("ok") }));
    await adapter.complete(request());
    const input = (send.mock.calls[0]![0] as { input: { body: string } }).input;
    expect(JSON.parse(input.body).temperature).toBe(1);
  });

  it("rejects an unregistered model id BEFORE calling Bedrock", async () => {
    // A wasted round-trip that returns an overloaded ValidationException is a worse diagnostic than
    // failing locally with the registered ids listed.
    const { adapter, send } = adapterWith(() => ({ body: completionBody("ok") }));
    await expect(adapter.complete(request({ modelId: "anthropic.claude-opus-5" })))
      .rejects.toThrow(/Unknown model id/);
    expect(send).not.toHaveBeenCalled();
  });

  it("maps an SDK failure — a raw SDK error never escapes the adapter", async () => {
    const { adapter } = adapterWith(() => { throw awsError("ThrottlingException", "slow down"); });
    await expect(adapter.complete(request())).rejects.toMatchObject({ code: "ModelThrottled" });
  });

  it("fails readably on an empty response body", async () => {
    const { adapter } = adapterWith(() => ({}));
    await expect(adapter.complete(request())).rejects.toMatchObject({
      code: "ModelInvalidRequest", detail: { reason: "empty response body" },
    });
  });

  it("fails readably when the response body is not JSON", async () => {
    const { adapter } = adapterWith(() => ({ body: bytes("<html>proxy error</html>") }));
    await expect(adapter.complete(request())).rejects.toMatchObject({
      code: "ModelInvalidRequest", detail: { reason: "response body was not JSON" },
    });
  });

  it("returns empty text rather than failing on valid JSON of an unexpected shape", async () => {
    // Model output is hostile input (§0.4): `lib/generation`'s Validate→Repair→Fallback chain decides
    // what an empty completion means, so the adapter must not pre-empt it with a throw.
    const { adapter } = adapterWith(() => ({ body: bytes({ unexpected: true }) }));
    await expect(adapter.complete(request())).resolves.toEqual({ text: "" });
  });

  it("omits usage and stopReason rather than fabricating them", async () => {
    const { adapter } = adapterWith(() => ({ body: bytes({ content: [{ type: "text", text: "x" }] }) }));
    const response = await adapter.complete(request());
    expect(response).toEqual({ text: "x" });
    expect(response).not.toHaveProperty("usage");
  });

  it("decodes multi-byte text correctly", async () => {
    const { adapter } = adapterWith(() => ({ body: completionBody("日本語も確認") }));
    await expect(adapter.complete(request())).resolves.toMatchObject({ text: "日本語も確認" });
  });

  it("does not call Bedrock at all when the signal is already aborted", async () => {
    const { adapter, send } = adapterWith(() => ({ body: completionBody("ok") }));
    await expect(adapter.complete(request({ signal: AbortSignal.abort() })))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(send).not.toHaveBeenCalled();
  });

  it("forwards the signal to the SDK so an in-flight request can be cancelled", async () => {
    // Without this the request completes unobserved and the tokens are still billed.
    const controller = new AbortController();
    const { adapter, send } = adapterWith(() => ({ body: completionBody("ok") }));
    await adapter.complete(request({ signal: controller.signal }));
    expect(send.mock.calls[0]![1]).toEqual({ abortSignal: controller.signal });
  });
});

/* ─────────────────────────────── stream() ─────────────────────────────── */

describe("stream", () => {
  const streamOf = (frames: unknown[]) => ({
    body: (async function* () { for (const frame of frames) yield frame; })(),
  });

  it("yields one delta per text chunk, in order", async () => {
    const { adapter } = adapterWith(() => streamOf([
      { chunk: { bytes: bytes({ type: "message_start" }) } },
      deltaFrame("Hel"), deltaFrame("lo "), deltaFrame("world"),
      { chunk: { bytes: bytes({ type: "message_stop" }) } },
    ]));
    expect(await collect(adapter.stream(request()))).toEqual(["Hel", "lo ", "world"]);
  });

  it("uses the streaming command, with the same body as complete", async () => {
    const { adapter, send } = adapterWith(() => streamOf([deltaFrame("x")]));
    await collect(adapter.stream(request()));
    const command = send.mock.calls[0]![0] as { constructor: { name: string }; input: { body: string } };
    expect(command.constructor.name).toBe("InvokeModelWithResponseStreamCommand");
    expect(JSON.parse(command.input.body).max_tokens).toBe(512);
  });

  it("SKIPS a malformed frame instead of discarding the slide", async () => {
    // §12's SSE discipline applied to the inbound side: one bad chunk must not lose the deltas that
    // arrived around it, because the slide's content is the concatenation of all of them.
    const { adapter } = adapterWith(() => streamOf([
      deltaFrame("good "),
      { chunk: { bytes: bytes("{not json") } },
      deltaFrame("still good"),
    ]));
    expect(await collect(adapter.stream(request()))).toEqual(["good ", "still good"]);
  });

  it("skips a frame with no bytes at all", async () => {
    const { adapter } = adapterWith(() => streamOf([{}, { chunk: {} }, deltaFrame("x")]));
    expect(await collect(adapter.stream(request()))).toEqual(["x"]);
  });

  it("does not yield empty deltas — a consumer counting deltas would see phantom progress", async () => {
    const { adapter } = adapterWith(() => streamOf([deltaFrame(""), deltaFrame("real")]));
    expect(await collect(adapter.stream(request()))).toEqual(["real"]);
  });

  it("ends cleanly when the response carries no body", async () => {
    const { adapter } = adapterWith(() => ({}));
    expect(await collect(adapter.stream(request()))).toEqual([]);
  });

  it("maps a failure raised before the first chunk", async () => {
    const { adapter } = adapterWith(() => { throw awsError("AccessDeniedException"); });
    await expect(collect(adapter.stream(request())))
      .rejects.toMatchObject({ code: "ModelAccessDenied" });
  });

  it("maps a failure raised MID-stream, after deltas have been yielded", async () => {
    // §1.2 notes a throttle can arrive after the first delta. §9 requires that slide to error readably
    // while the rest of the deck continues — which needs an AppError, not a raw SDK throw.
    const { adapter } = adapterWith(() => ({
      body: (async function* () {
        yield deltaFrame("partial");
        throw awsError("ThrottlingException", "slow down");
      })(),
    }));
    const seen: string[] = [];
    await expect((async () => {
      for await (const delta of adapter.stream(request())) seen.push(delta.text);
    })()).rejects.toMatchObject({ code: "ModelThrottled" });
    expect(seen).toEqual(["partial"]);
  });

  it("rejects an unregistered model id before opening a stream", async () => {
    const { adapter, send } = adapterWith(() => streamOf([deltaFrame("x")]));
    await expect(collect(adapter.stream(request({ modelId: "nope" })))).rejects.toThrow(/Unknown model id/);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not open a stream when the signal is already aborted", async () => {
    const { adapter, send } = adapterWith(() => streamOf([deltaFrame("x")]));
    await expect(collect(adapter.stream(request({ signal: AbortSignal.abort() }))))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops mid-stream on abort, keeping the deltas already yielded", async () => {
    // §9's "client abort mid-generation: remaining slides stop, completed slides persisted" —
    // the adapter's half of that is stopping between frames rather than draining the response.
    const controller = new AbortController();
    let framesRead = 0;
    const { adapter } = adapterWith(() => ({
      body: (async function* () {
        for (const text of ["a", "b", "c", "d"]) { framesRead += 1; yield deltaFrame(text); }
      })(),
    }));

    const seen: string[] = [];
    await expect((async () => {
      for await (const delta of adapter.stream(request({ signal: controller.signal }))) {
        seen.push(delta.text);
        if (seen.length === 2) controller.abort();
      }
    })()).rejects.toMatchObject({ name: "AbortError" });

    expect(seen).toEqual(["a", "b"]);
    expect(framesRead).toBeLessThan(4);
  });
});
