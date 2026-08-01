/**
 * The model registry and the family Strategies (SPEC §8, CLAUDE.md §2 step 10).
 *
 * The §1.2 spike's measured facts are the specification here, and this file is where they stop being
 * prose in `VERIFICATION.md` and become assertions. In particular the **inference-profile prefix**:
 * every ACTIVE Anthropic model in this account is `INFERENCE_PROFILE`-only, so a bare foundation-model
 * id fails at invoke time with "on-demand throughput isn't supported". The bare id looks *more*
 * correct, which is precisely why it needs a test and not a comment.
 */

import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_BEDROCK_VERSION, DEFAULT_MODEL_ID, LLM_MODELS, type RegisteredModel, allModels,
  clampTemperature, findModel, modelProblems, modelSummaries, registryProblems, requireModel,
} from "@/lib/models/registry";
import { anthropicFamily, familyFor, isTruncatedStopReason } from "@/lib/models/families";

const model = (over: Partial<RegisteredModel> = {}): RegisteredModel => ({
  id: "us.anthropic.probe",
  displayName: "Probe",
  family: "anthropic",
  contextWindow: 200_000,
  supportsTemperature: true,
  defaultTemperature: 1,
  verified: false,
  ...over,
});

describe("the registry as shipped", () => {
  it("is clean under its own invariants", () => {
    expect(registryProblems()).toEqual([]);
  });

  it("contains the §1.2-verified default", () => {
    expect(DEFAULT_MODEL_ID).toBe("us.anthropic.claude-opus-5");
    expect(findModel(DEFAULT_MODEL_ID)).toBeDefined();
  });

  it("marks exactly the model the spike actually invoked as verified", () => {
    // The honesty check: "enumerated as ACTIVE" is not "round-tripped", and conflating them would
    // make a first-use failure look like a regression instead of a known ⚠️ VERIFY item.
    expect(LLM_MODELS.filter((m) => m.verified).map((m) => m.id)).toEqual([DEFAULT_MODEL_ID]);
  });

  it("stores INFERENCE-PROFILE ids for every entry, never bare foundation-model ids", () => {
    for (const m of LLM_MODELS) {
      expect(m.id, `${m.id} must be profile-prefixed`).toMatch(/^(us|global|eu|apac)\./);
    }
  });

  it("has no duplicate ids", () => {
    expect(new Set(LLM_MODELS.map((m) => m.id)).size).toBe(LLM_MODELS.length);
  });

  it("pins the Bedrock API version the spike proved is required", () => {
    // A wrong value returns "Invalid API version" — verified by sending one.
    expect(ANTHROPIC_BEDROCK_VERSION).toBe("bedrock-2023-05-31");
  });

  it("exposes the registry without copying it", () => {
    expect(allModels()).toBe(LLM_MODELS);
  });
});

describe("registry invariants actually fire", () => {
  it("rejects a bare foundation-model id, naming the reason", () => {
    const problems = modelProblems(model({ id: "anthropic.claude-opus-5" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/inference-profile/);
    expect(problems[0]).toMatch(/on-demand throughput/);
  });

  it("rejects a missing displayName", () => {
    expect(modelProblems(model({ displayName: "  " }))).toHaveLength(1);
  });

  it("rejects a non-positive or non-integer context window", () => {
    expect(modelProblems(model({ contextWindow: 0 }))).toHaveLength(1);
    expect(modelProblems(model({ contextWindow: -1 }))).toHaveLength(1);
    expect(modelProblems(model({ contextWindow: 1.5 }))).toHaveLength(1);
  });

  it("rejects a defaultTemperature outside 0–1", () => {
    expect(modelProblems(model({ defaultTemperature: 1.5 }))).toHaveLength(1);
    expect(modelProblems(model({ defaultTemperature: -0.1 }))).toHaveLength(1);
  });

  it("rejects a descriptor that contradicts itself about temperature", () => {
    // `supportsTemperature: false` with a default means the value can never be used — dead config
    // that would mislead the next person reading the entry.
    expect(modelProblems(model({ supportsTemperature: false, defaultTemperature: 1 })))
      .toHaveLength(1);
    expect(modelProblems(model({ supportsTemperature: false, defaultTemperature: 0 })))
      .toEqual([]);
  });

  it("accepts a well-formed entry", () => {
    expect(modelProblems(model())).toEqual([]);
  });

  it("reports duplicates and an absent default at registry level", () => {
    const dup = registryProblems([model(), model()]);
    expect(dup.some((p) => p.includes("duplicate"))).toBe(true);
    expect(dup.some((p) => p.includes(DEFAULT_MODEL_ID))).toBe(true);
  });

  it("reports an empty registry", () => {
    expect(registryProblems([]).some((p) => p.includes("empty"))).toBe(true);
  });
});

describe("requireModel", () => {
  it("returns the descriptor for a registered id", () => {
    expect(requireModel(DEFAULT_MODEL_ID).family).toBe("anthropic");
  });

  it("throws listing the registered ids, because this is OUR config error", () => {
    // A `DEFAULT_LLM_MODEL_ID` typo would otherwise surface as a Bedrock ValidationException
    // mid-generation, which is slower to hit and far harder to diagnose.
    expect(() => requireModel("us.anthropic.nope")).toThrow(/Unknown model id/);
    expect(() => requireModel("us.anthropic.nope")).toThrow(DEFAULT_MODEL_ID);
  });

  it("throws on a bare id rather than passing it to Bedrock", () => {
    expect(() => requireModel("anthropic.claude-opus-5")).toThrow(/Unknown model id/);
  });
});

describe("clampTemperature", () => {
  it("clamps into 0–1 rather than rejecting", () => {
    // It arrives from a UI slider; failing a request because a client sent 1.001 is a worse outcome.
    expect(clampTemperature(model(), 2)).toBe(1);
    expect(clampTemperature(model(), -5)).toBe(0);
    expect(clampTemperature(model(), 0.4)).toBe(0.4);
  });

  it("uses the model's default when unset", () => {
    expect(clampTemperature(model({ defaultTemperature: 0.7 }), undefined)).toBe(0.7);
  });

  it("uses the default for NaN and Infinity, not the clamp bounds", () => {
    expect(clampTemperature(model({ defaultTemperature: 0.7 }), Number.NaN)).toBe(0.7);
    expect(clampTemperature(model({ defaultTemperature: 0.7 }), Infinity)).toBe(0.7);
  });

  it("returns undefined for a model that doesn't support it, so the key is OMITTED", () => {
    // Not 0 — sending a temperature to a family that rejects the parameter is a ValidationException.
    expect(clampTemperature(model({ supportsTemperature: false, defaultTemperature: 0 }), 0.5))
      .toBeUndefined();
  });
});

describe("modelSummaries — the API projection", () => {
  it("covers every model", () => {
    expect(modelSummaries()).toHaveLength(LLM_MODELS.length);
  });

  it("omits internals and JSON round-trips", () => {
    const summaries = modelSummaries();
    expect(summaries[0]).not.toHaveProperty("contextWindow");
    expect(JSON.parse(JSON.stringify(summaries))).toEqual(summaries);
  });

  it("carries `verified` through, so the picker can mark unproven entries", () => {
    expect(modelSummaries().find((s) => s.id === DEFAULT_MODEL_ID)!.verified).toBe(true);
  });
});

describe("anthropic family — request body (§1.2 §2, measured)", () => {
  it("sends both mandatory fields", () => {
    // Each verified by omitting it: "Invalid API version" and "max_tokens: Field required".
    const body = anthropicFamily.buildBody({ prompt: "hi", maxTokens: 512 });
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.max_tokens).toBe(512);
  });

  it("wraps the prompt in a typed content block, not a bare string", () => {
    expect(anthropicFamily.buildBody({ prompt: "hi", maxTokens: 8 }).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("includes system and temperature when supplied", () => {
    const body = anthropicFamily.buildBody({
      prompt: "hi", maxTokens: 8, system: "Be brief.", temperature: 0.3,
    });
    expect(body.system).toBe("Be brief.");
    expect(body.temperature).toBe(0.3);
  });

  it("OMITS system and temperature rather than sending undefined", () => {
    // An explicit `undefined` survives into the JSON body as a missing-but-present key in some
    // serializers, and pptxgenjs aside, Bedrock validates its body strictly.
    const body = anthropicFamily.buildBody({ prompt: "hi", maxTokens: 8 });
    expect(body).not.toHaveProperty("system");
    expect(body).not.toHaveProperty("temperature");
  });

  it("omits an empty system prompt", () => {
    expect(anthropicFamily.buildBody({ prompt: "hi", maxTokens: 8, system: "" }))
      .not.toHaveProperty("system");
  });

  it("sends temperature 0 — falsy, but a legitimate value", () => {
    expect(anthropicFamily.buildBody({ prompt: "hi", maxTokens: 8, temperature: 0 }).temperature)
      .toBe(0);
  });

  it("serializes to JSON without loss", () => {
    const body = anthropicFamily.buildBody({ prompt: "日本語も", maxTokens: 8 });
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });
});

describe("anthropic family — non-streaming response (§1.2 §2)", () => {
  const response = {
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 3 },
  };

  it("extracts text, usage, and stop reason", () => {
    expect(anthropicFamily.parseCompletion(response)).toEqual({
      text: "Hello",
      usage: { inputTokens: 12, outputTokens: 3 },
      stopReason: "end_turn",
    });
  });

  it("concatenates ALL text blocks rather than reading content[0]", () => {
    // The spike saw one block, but a leading non-text block (a thinking block) would make an indexed
    // read yield undefined — an empty slide instead of an error.
    expect(anthropicFamily.parseCompletion({
      content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "A" }, { type: "text", text: "B" }],
    }).text).toBe("AB");
  });

  it("omits usage rather than fabricating it when absent or malformed", () => {
    expect(anthropicFamily.parseCompletion({ content: [] }).usage).toBeUndefined();
    expect(anthropicFamily.parseCompletion({ content: [], usage: { input_tokens: "12" } }).usage)
      .toBeUndefined();
  });

  it("surfaces stop_reason so max_tokens truncation is detectable", () => {
    const parsed = anthropicFamily.parseCompletion({ content: [], stop_reason: "max_tokens" });
    expect(isTruncatedStopReason(parsed.stopReason)).toBe(true);
    expect(isTruncatedStopReason("end_turn")).toBe(false);
    expect(isTruncatedStopReason(undefined)).toBe(false);
  });

  it("returns empty text rather than throwing on a shape it does not recognize", () => {
    // Model output is hostile input by policy (§0.4); `lib/generation` decides what to do about empty.
    for (const body of [null, undefined, 42, "text", {}, { content: "not an array" }, { content: [null] }]) {
      expect(() => anthropicFamily.parseCompletion(body), JSON.stringify(body)).not.toThrow();
      expect(anthropicFamily.parseCompletion(body).text).toBe("");
    }
  });
});

describe("anthropic family — stream decoding (§1.2 §3, measured envelope)", () => {
  it("decodes a text delta from where the spike found it", () => {
    expect(anthropicFamily.decodeStreamEvent({
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "1" },
    })).toBe("1");
  });

  it("SKIPS every other event type in the observed sequence, rather than erroring", () => {
    // message_start → content_block_start → …deltas… → content_block_stop → message_delta →
    // message_stop. Only the deltas carry text; treating an unknown type as an error would break
    // generation the first time a model version adds one.
    for (const type of [
      "message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop",
      "ping", "some_future_event",
    ]) {
      expect(anthropicFamily.decodeStreamEvent({ type }), type).toBeUndefined();
    }
  });

  it("skips a delta whose text is missing or not a string", () => {
    expect(anthropicFamily.decodeStreamEvent({ type: "content_block_delta", delta: {} }))
      .toBeUndefined();
    expect(anthropicFamily.decodeStreamEvent({ type: "content_block_delta", delta: { text: 42 } }))
      .toBeUndefined();
  });

  it("skips non-objects without throwing", () => {
    for (const event of [null, undefined, 42, "text", []]) {
      expect(anthropicFamily.decodeStreamEvent(event)).toBeUndefined();
    }
  });

  it("reassembles the spike's exact sequence into the original text", () => {
    const events = [
      { type: "message_start", message: { id: "m1" } },
      { type: "content_block_start", index: 0 },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];
    const text = events.map((e) => anthropicFamily.decodeStreamEvent(e) ?? "").join("");
    expect(text).toBe("Hello world");
  });

  it("reads the final stop reason from message_delta, where it actually lives", () => {
    // `message_stop` does NOT carry it, so a truncated stream would otherwise just… end.
    expect(anthropicFamily.streamStopReason!({
      type: "message_delta", delta: { stop_reason: "max_tokens" },
    })).toBe("max_tokens");
    expect(anthropicFamily.streamStopReason!({ type: "message_stop" })).toBeUndefined();
    expect(anthropicFamily.streamStopReason!({ type: "content_block_delta", delta: { text: "x" } }))
      .toBeUndefined();
  });

  it("tolerates a top-level stop_reason on message_delta", () => {
    expect(anthropicFamily.streamStopReason!({ type: "message_delta", stop_reason: "end_turn" }))
      .toBe("end_turn");
  });
});

describe("familyFor", () => {
  it("resolves every family a registered model declares", () => {
    // The property SPEC §8 asks for: no model-id branching, and no registered model without a
    // strategy behind it.
    for (const m of LLM_MODELS) {
      expect(familyFor(m.family), m.id).toBeDefined();
      expect(familyFor(m.family).family).toBe(m.family);
    }
  });
});
