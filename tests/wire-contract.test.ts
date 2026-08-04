/**
 * The two serialization choke points: `lib/stream/events.ts` (SSE frames) and `toErrorBody`/`issuesOf`
 * (JSON error bodies).
 *
 * Both were covered only indirectly until now — by whichever route or service happened to exercise them.
 * They deserve direct tests because each is a single function through which EVERY response of its kind
 * passes, and each has one failure mode that no caller's test would notice:
 *
 *   - a frame that is well-formed for the events we happen to send but not for the ones we will add;
 *   - an error body that leaks `AppError.detail`, which holds brand ids, asset ids, model ids, and
 *     filesystem-adjacent context.
 *
 * The `detail`-leak assertions are the load-bearing ones in this file. They are written as "this specific
 * value must not appear anywhere in the serialized body" rather than "the body has these keys", because
 * the failure being guarded against is an extra key nobody thought to exclude.
 */

import { describe, expect, it } from "vitest";
import {
  type StreamEvent, isStreamEvent, toFatalEvent, toSseFrame,
} from "@/lib/stream/events";
import {
  AppError, AssetTooLarge, BrandInUse, BrandNotFound, InvalidBrandConfig, InvalidRequest,
  InvalidSlideContent, InvalidSlideOrder, ModelAccessDenied, ModelThrottled, UnsafeAsset,
  issuesOf, toErrorBody, toReadable,
} from "@/lib/errors/errors";

const AT = 1_700_000_000_000;

/* ─────────────────────────────── SSE framing ─────────────────────────────── */

describe("toSseFrame", () => {
  it("emits `event:` and `data:` lines terminated by a blank line", () => {
    const frame = toSseFrame({ type: "deck-start", at: AT, deckId: "d1", total: 3 });

    // The blank-line terminator is what tells the browser the frame is complete. Without it EventSource
    // holds the event until the next one arrives — which for the last frame of a stream means forever.
    expect(frame).toBe(
      `event: deck-start\ndata: {"type":"deck-start","at":${AT},"deckId":"d1","total":3}\n\n`,
    );
  });

  it("puts the whole event on ONE data line, whatever the payload contains", () => {
    // A raw newline inside `data:` would split one event into two frames, the second of which is not valid
    // JSON. Model-authored text is the realistic source of one, so this is not hypothetical: a slide's
    // message legitimately contains newlines.
    const frame = toSseFrame({
      type: "slide-delta", at: AT, slideId: "s1", text: "line one\nline two\r\nline three",
    });

    const lines = frame.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("event: slide-delta");
    expect(lines[1]?.startsWith("data: ")).toBe(true);
    // JSON.stringify escapes the newlines, so they survive a round trip rather than being stripped.
    const parsed = JSON.parse(lines[1]!.slice("data: ".length)) as { text: string };
    expect(parsed.text).toBe("line one\nline two\r\nline three");
  });

  it("round-trips every event variant through frame → parse → guard", () => {
    // One of each, so a new variant added to the union without a `KNOWN` entry fails here rather than
    // being silently skipped by a client that was told to skip unknown types (§12).
    const events: StreamEvent[] = [
      { type: "deck-start", at: AT, deckId: "d1", total: 2 },
      { type: "slide-start", at: AT, slideId: "s1", index: 0, layoutId: "title" },
      { type: "slide-delta", at: AT, slideId: "s1", text: "partial" },
      { type: "slide-done", at: AT, slideId: "s1", index: 0, flags: ["trimmed"] },
      { type: "slide-error", at: AT, slideId: "s2", index: 1, reason: "repair-failed", message: "Readable." },
      { type: "deck-done", at: AT, deckId: "d1", ok: 1, failed: 1 },
      { type: "fatal", at: AT, message: "Readable.", code: "Internal", retryable: false },
      { type: "ping", at: AT },
    ];

    for (const event of events) {
      const data = toSseFrame(event).split("\n")[1]!.slice("data: ".length);
      const parsed = JSON.parse(data) as unknown;
      expect(isStreamEvent(parsed), event.type).toBe(true);
      expect(parsed).toEqual(event);
    }
  });
});

describe("isStreamEvent", () => {
  it("accepts every known type and rejects an unknown one", () => {
    expect(isStreamEvent({ type: "slide-done", at: AT })).toBe(true);
    // Skipped, not thrown — which is what makes adding a variant backward-compatible by construction
    // (§12: "unknown event types logged + skipped").
    expect(isStreamEvent({ type: "slide-transcoded", at: AT })).toBe(false);
  });

  it("rejects the malformed shapes a broken frame actually produces", () => {
    for (const value of [null, undefined, 42, "fatal", [], {}, { type: 42 }, { at: AT }]) {
      expect(isStreamEvent(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("toFatalEvent", () => {
  it("mirrors the JSON body's code and retryable so one renderer serves both transports", () => {
    expect(toFatalEvent(ModelThrottled(), AT)).toMatchObject({
      type: "fatal", at: AT, code: "ModelThrottled", retryable: true,
    });
    expect(toFatalEvent(BrandNotFound("b1"), AT)).toMatchObject({
      code: "BrandNotFound", retryable: false,
    });
  });

  it("carries no detail, on the same allowlist reasoning as the JSON body", () => {
    const frame = toSseFrame(toFatalEvent(BrandNotFound("brand-abc-secret"), AT));
    expect(frame).not.toContain("brand-abc-secret");
  });
});

/* ─────────────────────────────── error bodies ─────────────────────────────── */

describe("toErrorBody", () => {
  it("carries code, readable message, retryable, and the taxonomy's status", () => {
    const { body, status } = toErrorBody(BrandNotFound("b1"));

    expect(status).toBe(404);
    expect(body).toEqual({
      code: "BrandNotFound",
      message: BrandNotFound("b1").readable,
      retryable: false,
    });
    // No `issues` key at all when there are none, rather than an empty array: a client checking
    // `body.issues?.length` and one checking `"issues" in body` should agree.
    expect("issues" in body).toBe(false);
  });

  it("never serializes `detail`, for every id-bearing code in the taxonomy", () => {
    // The single most important assertion about this function. Each of these constructors stashes an id
    // for the logs; none of it may reach a response. Written as "this exact value is absent from the
    // serialized body" because the failure guarded against is an extra key nobody excluded.
    const cases: [AppError, string][] = [
      [BrandNotFound("brand-secret-id"), "brand-secret-id"],
      [BrandInUse("brand-secret-id", 3), "brand-secret-id"],
      [ModelAccessDenied("us.anthropic.secret-model"), "secret-model"],
      [AssetTooLarge(99_999_999, 5_242_880), "99999999"],
      // The one the module header singles out: its detail is slide IDS, not field paths, so it is
      // excluded from ISSUE_BEARING on purpose. Asserted here so a well-meaning "it has issues, add it"
      // edit fails a test that explains itself.
      [InvalidSlideOrder("missing-ids", { missing: ["slide-secret-id"] }), "slide-secret-id"],
    ];

    for (const [err, secret] of cases) {
      const serialized = JSON.stringify(toErrorBody(err).body);
      expect(serialized, err.code).not.toContain(secret);
    }
  });

  it("crosses `issues` for exactly the allowlisted codes", () => {
    // The four that SPEC §12's "field-level readable zod errors" requires, and nothing else.
    const allowed: AppError[] = [
      InvalidRequest(["title: must not be empty"]),
      InvalidBrandConfig(["colors.primary: must be a hex colour"]),
      InvalidSlideContent(["bullets[0]: too long"]),
      UnsafeAsset("active-content", ["file: contains a <script> element"]),
    ];

    for (const err of allowed) {
      expect(toErrorBody(err).body.issues, err.code).toHaveLength(1);
    }
  });

  it("does NOT cross issues for a code outside the allowlist, even if detail holds some", () => {
    // A hand-built AppError with an `issues` array in a code that was never allowlisted. This is the
    // future-proofing the allowlist exists for: a new constructor that stashes issues alongside a
    // filesystem path leaks nothing until its code is named deliberately.
    const err = new AppError("GenerationFailed", "Something went wrong.", {
      detail: { issues: ["/var/data/decks/user-a/deck-1.json: EACCES"] },
    });

    expect(issuesOf(err)).toEqual([]);
    expect(JSON.stringify(toErrorBody(err).body)).not.toContain("/var/data");
  });

  it("filters non-string entries out of an issues array rather than trusting its shape", () => {
    const err = new AppError("InvalidRequest", "Bad request.", {
      detail: { issues: ["title: required", 42, null, { path: "leak" }, "brandId: required"] },
    });

    // `detail` is typed loosely and built by hand in places; an object in that array would be serialized
    // verbatim into the response, which is how a structured leak gets in through a field that was
    // supposed to be strings.
    expect(issuesOf(err)).toEqual(["title: required", "brandId: required"]);
  });

  it("collapses an unknown throw to a 500 that says nothing about what failed", () => {
    const { body, status } = toErrorBody(new Error("ECONNRESET connecting to bedrock-runtime.internal"));

    expect(status).toBe(500);
    expect(body.code).toBe("Internal");
    expect(body.message).not.toContain("ECONNRESET");
    expect(body.message).not.toContain("bedrock-runtime");
  });

  it("collapses a thrown non-Error the same way", () => {
    // A string throw, a rejected promise carrying an object — both reach `fail` in practice.
    for (const thrown of ["boom", { message: "boom" }, null, undefined, 42]) {
      const { body, status } = toErrorBody(thrown);
      expect(status, JSON.stringify(thrown)).toBe(500);
      expect(body.code).toBe("Internal");
    }
  });

  it("marks a throttle retryable and a validation failure not", () => {
    // The field a client's Retry button branches on. A throttle that came back `retryable: false` would
    // strand a deck the user could have finished by waiting ten seconds.
    expect(toErrorBody(ModelThrottled()).body.retryable).toBe(true);
    expect(toErrorBody(InvalidRequest(["x: bad"])).body.retryable).toBe(false);
  });
});

describe("toReadable", () => {
  it("returns the AppError's own readable text, not its message", () => {
    const err = BrandNotFound("b1");
    expect(toReadable(err)).toEqual({
      code: "BrandNotFound",
      message: err.readable,
      status: 404,
      retryable: false,
    });
  });
});
