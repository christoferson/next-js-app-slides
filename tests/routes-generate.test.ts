/**
 * `POST …/generate` (SSE), the slide routes, `…/workspace`, and `…/export/:format` — the rest of step 15.
 *
 * The SSE route is the only endpoint in the app whose *response shape* is the product, and it is the one
 * this file exists for. `tests/generation-service.test.ts` already proves which events occur, in what
 * order, and that a fallback slide is counted as failed; what is untested until now is the wire:
 *
 *   - the frames are well-formed SSE and each `data:` line is one JSON event;
 *   - the headers are the ones that keep a proxy from buffering a live feed into a single delivery — the
 *     failure that only appears in production;
 *   - a body-level 400 is a JSON 400, NOT a 200 stream carrying one `fatal` frame (the reason `handle`
 *     still wraps a streaming route);
 *   - a job that dies after the status line is a `fatal` frame, because by then it cannot be a 502.
 *
 * The frames are parsed with a hand-rolled split rather than the client parser: parsing them with the code
 * that produced them would make a framing bug invisible (`route-harness.ts`'s note).
 */

import { describe, expect, it } from "vitest";
import { POST as generate } from "@/app/api/decks/[deckId]/generate/route";
import {
  DELETE as deleteSlide, GET as getSlide, PATCH as patchSlide,
} from "@/app/api/decks/[deckId]/slides/[slideId]/route";
import { POST as duplicateSlide } from "@/app/api/decks/[deckId]/slides/[slideId]/duplicate/route";
import { POST as regenerateSlide } from "@/app/api/decks/[deckId]/slides/[slideId]/regenerate/route";
import { PUT as reorderSlides } from "@/app/api/decks/[deckId]/slides/order/route";
import { GET as workspace } from "@/app/api/decks/[deckId]/workspace/route";
import { GET as exportDeck } from "@/app/api/decks/[deckId]/export/[format]/route";
import { POST as createDeck } from "@/app/api/decks/route";
import { POST as createBrand } from "@/app/api/brands/route";
import {
  type RouteHarness, readBody, readError, readStream, req, routeHarness, sseEvents,
} from "@/tests/route-harness";
import { brandInput, slideResponseFor } from "@/tests/service-harness";
import { requireLayout } from "@/lib/layouts/registry";
import { ModelThrottled } from "@/lib/errors/errors";
import type { BrandDefinition } from "@/lib/brand/types";
import type { Briefing, Outline, Slide } from "@/lib/domain/deck";
import type { DeckMeta } from "@/lib/domain/deck";

const BRIEFING: Briefing = {
  topic: "Billing reliability",
  audience: "The exec team",
  objective: "Approve the remediation budget",
  targetSlideCount: 5,
};

/** Three slides across two headed sections — the same shape the generation suite uses. */
const OUTLINE: Outline = {
  sections: [
    {
      heading: "Where we are",
      slides: [
        { question: "Why are we here?", message: "Billing broke repeatedly.", evidence: ["19 incidents"], visualHint: "opening" },
      ],
    },
    {
      heading: "What we'll do",
      slides: [
        { question: "What's the plan?", message: "Three fixes, in order.", evidence: ["Fix A"], visualHint: "list" },
        { question: "What next?", message: "Approve the budget.", evidence: [], visualHint: "closing" },
      ],
    },
  ],
};

/**
 * A deck with a brand, a briefing, and an outline, plus one clean scripted response per planned slide.
 *
 * The outline is written straight to the repository rather than generated, because a scripted outline call
 * would consume a queue slot and the point here is the *generate* endpoint. Responses are derived from
 * each planned layout's own slot specs (§4) — three hand-written `bullets` fixtures would produce two
 * fallbacks and the counts would read as a route bug.
 */
async function readyDeck(h: RouteHarness, outline: Outline | null = OUTLINE): Promise<{
  brand: BrandDefinition; deck: DeckMeta;
}> {
  const { body: brand } = await readBody<BrandDefinition>(await createBrand(req("POST", brandInput())));
  const { body: deck } = await readBody<DeckMeta>(await createDeck(req("POST", {
    title: "Q3 Review", brandId: brand.id, briefing: BRIEFING,
  })));
  if (outline !== null) await h.container.decks.updateMeta(h.userId, deck.id, { outline });
  return { brand, deck };
}

function scriptCleanDeck(h: RouteHarness, label = "Value"): void {
  for (const mapped of h.services.mapping.map(OUTLINE)) {
    h.llm.push({ text: slideResponseFor(requireLayout(mapped.decision.layoutId), label) });
  }
}

/** Generate the deck through the route and return both the parsed frames and the stored slides. */
async function generated(h: RouteHarness, deckId: string): Promise<{
  events: Record<string, unknown>[]; slides: Slide[];
}> {
  const response = await generate(req("POST", {}), h.ctx({ deckId }));
  expect(response.status).toBe(200);
  const events = sseEvents(await readStream(response));
  return { events, slides: await h.services.decks.listSlides(h.userId, deckId) };
}

/* ─────────────────────────────── the SSE route ─────────────────────────────── */

describe("POST /api/decks/:deckId/generate", () => {
  it("streams well-formed SSE with the anti-buffering headers", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);

    const response = await generate(req("POST", {}), h.ctx({ deckId: deck.id }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Defeats nginx/ALB response buffering, which would hold every frame until the stream ends and turn
    // a live feed into a single delivery — the whole point of this route shape, and a failure that only
    // appears behind a proxy (i.e. never in dev).
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const text = await readStream(response);
    // Framing, asserted on the raw text: every frame is `event:`/`data:` terminated by a blank line. A
    // missing terminator makes the browser hold the frame until the next one arrives.
    expect(text).toMatch(/^event: /);
    expect(text.endsWith("\n\n")).toBe(true);
    for (const block of text.split("\n\n").filter((b) => b !== "")) {
      expect(block.split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(1);
    }
  });

  it("emits one terminal event per slide and a deck-done with true counts", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);

    const { events, slides } = await generated(h, deck.id);
    const types = events.map((e) => e.type);

    expect(types.filter((t) => t === "slide-start")).toHaveLength(3);
    expect(types.filter((t) => t === "slide-done")).toHaveLength(3);
    expect(types.at(-1)).toBe("deck-done");
    expect(events.at(-1)).toMatchObject({ ok: 3, failed: 0, deckId: deck.id });
    expect(slides).toHaveLength(3);
  });

  it("frames a `fatal` event when the job dies, because the status line was already sent", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h, null);   // no outline ⇒ DeckNotReady inside the job

    const response = await generate(req("POST", {}), h.ctx({ deckId: deck.id }));

    // 200, not 409. By the time the failure happens the headers are on the wire and cannot retroactively
    // become an error status — so §13's "readable in-stream" is the only place left to say it.
    expect(response.status).toBe(200);
    const events = sseEvents(await readStream(response));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "fatal", code: "DeckNotReady" });
    expect(String(events[0]?.message)).toMatch(/outline/i);
  });

  /**
   * A deployment with no `DEFAULT_LLM_MODEL_ID`, on the wire.
   *
   * The unit test in `model-registry.test.ts` proves `requireModel("")` throws the right `AppError`; this
   * proves the frame a browser actually receives, because the two used to disagree in the way that
   * matters. `requireModel` is called inside the streaming job, so the headers are already sent and this
   * cannot be a 503 status — it has to be a `fatal` frame carrying the 503's code, and the client's error
   * renderer keys off `code`. Before `ModelNotConfigured` existed the frame said `Internal` /
   * "something went wrong on our side", pointing whoever hit it at a stack trace rather than at an env var.
   */
  it("reports an unconfigured model as a readable fatal frame, not an opaque Internal", async () => {
    const h = routeHarness({ defaultLlmModelId: "" });
    const { deck } = await readyDeck(h);

    const response = await generate(req("POST", {}), h.ctx({ deckId: deck.id }));
    const events = sseEvents(await readStream(response));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "fatal", code: "ModelNotConfigured", retryable: false });
    // Names the variable to set. "Retrying" cannot help, which is what `retryable: false` tells the UI.
    expect(String(events[0]?.message)).toContain("DEFAULT_LLM_MODEL_ID");
    // The model was never called — this fails before any spend, unlike a bad id that fails at Bedrock.
    expect(h.llm.calls).toHaveLength(0);
  });

  it("rejects a malformed body as a JSON 400, NOT a stream with one fatal frame", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);

    const { status, body } = await readError(
      await generate(req("POST", { density: "verbose" }), h.ctx({ deckId: deck.id })),
    );

    // This is why `handle` still wraps a streaming route: the body is read before the Response exists, so
    // a client error is still expressible as a status code. A `fatal` frame here would make every 400
    // require an SSE parser to read.
    expect(status).toBe(400);
    expect(body.code).toBe("InvalidRequest");
    expect(body.issues?.some((i) => i.startsWith("density"))).toBe(true);
    expect(h.llm.calls).toHaveLength(0);
  });

  it("continues the deck when one slide's model call throttles (§9)", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);
    const layouts = h.services.mapping.map(OUTLINE).map((m) => m.decision.layoutId);

    h.llm.push(
      { text: slideResponseFor(requireLayout(layouts[0]!)) },
      { throws: ModelThrottled("m") },
      // The repair pass is not attempted for a throttle, so the next queued response belongs to slide 3.
      { text: slideResponseFor(requireLayout(layouts[2]!)) },
    );

    const { events } = await generated(h, deck.id);

    expect(events.filter((e) => e.type === "slide-error")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ ok: 2, failed: 1 });
    // The failing slide's frame is readable rather than a stack trace — §13, in-stream half.
    const failure = events.find((e) => e.type === "slide-error");
    expect(String(failure?.message).length).toBeGreaterThan(10);
  });

  it("stops on a client abort, keeping the slides already persisted (§9's last row)", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);

    const controller = new AbortController();
    const request = new Request("http://test.local/api", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    });

    // Aborted before the stream is read, so the pipeline sees the signal set at its first between-slide
    // check. The route's only job is to forward `request.signal` rather than invent its own.
    controller.abort();
    const response = await generate(request, h.ctx({ deckId: deck.id }));
    const events = sseEvents(await readStream(response));

    expect(events.at(-1)).toMatchObject({ type: "deck-done" });
    expect(events.at(-1)?.ok).toBe(0);
    const slides = await h.services.decks.listSlides(h.userId, deck.id);
    expect(slides).toHaveLength(0);
  });

  it("forwards the wizard's options into the prompts", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);

    await generate(
      req("POST", { instruction: "punchier", density: "concise", includeSpeakerNotes: true }),
      h.ctx({ deckId: deck.id }),
    );

    // Spread conditionally by the route, so an absent option must not become an explicit `undefined` that
    // overrides a default further down. Presence is what is asserted; the wording is `prompts.ts`'s.
    for (const call of h.llm.calls) expect(call.prompt).toContain("punchier");
  });
});

/* ─────────────────────────────── slides ─────────────────────────────── */

describe("GET | PATCH | DELETE /api/decks/:deckId/slides/:slideId", () => {
  async function deckWithSlides(h: RouteHarness): Promise<{ deck: DeckMeta; slides: Slide[] }> {
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    const { slides } = await generated(h, deck.id);
    return { deck, slides };
  }

  it("GET returns one slide", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);
    const target = slides[1]!;

    const { status, body } = await readBody<Slide>(
      await getSlide(req("GET"), h.ctx({ deckId: deck.id, slideId: target.id })),
    );

    expect(status).toBe(200);
    expect(body.id).toBe(target.id);
    expect(body.order).toBe(1);
  });

  it("GET 404s a slide from another deck without echoing the id", async () => {
    const h = routeHarness();
    const { deck } = await deckWithSlides(h);
    const { status, body } = await readError(
      await getSlide(req("GET"), h.ctx({ deckId: deck.id, slideId: "../../etc/passwd" })),
    );

    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain("passwd");
  });

  it("PATCH edits slots and returns the stored slide", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);
    const target = slides[0]!;
    const [slotKey] = Object.keys(target.slots);

    const { status, body } = await readBody<Slide>(await patchSlide(
      req("PATCH", { slots: { ...target.slots, [slotKey!]: "Edited by hand" } }),
      h.ctx({ deckId: deck.id, slideId: target.id }),
    ));

    expect(status).toBe(200);
    expect(body.slots[slotKey!]).toBe("Edited by hand");
  });

  it("PATCH rejects an over-budget edit rather than silently truncating it", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);
    const target = slides[0]!;
    const [slotKey] = Object.keys(target.slots);

    const { status, body } = await readError(await patchSlide(
      req("PATCH", { slots: { ...target.slots, [slotKey!]: "x".repeat(5_000) } }),
      h.ctx({ deckId: deck.id, slideId: target.id }),
    ));

    // The asymmetry with the model's path, which truncates and flags: silently rewriting what a person
    // typed is worse than telling them it does not fit, and the editor has a live counter.
    expect(status).toBe(400);
    expect(body.code).toBe("InvalidSlideContent");
    expect(body.issues?.some((i) => i.includes(slotKey!))).toBe(true);
  });

  it("PATCH rejects a slot value that is not a string or string array", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);

    const { status, body } = await readError(await patchSlide(
      // These are the shapes `SlotValue` does not admit, and they would otherwise reach the budget
      // checker as a type it cannot measure.
      req("PATCH", { slots: { title: 42 } }),
      h.ctx({ deckId: deck.id, slideId: slides[0]!.id }),
    ));

    expect(status).toBe(400);
    expect(body.code).toBe("InvalidRequest");
  });

  it("PATCH rejects an empty patch", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);
    const { status } = await readError(
      await patchSlide(req("PATCH", {}), h.ctx({ deckId: deck.id, slideId: slides[0]!.id })),
    );
    expect(status).toBe(400);
  });

  it("PATCH accepts an empty speakerNotes, since clearing them is a normal edit", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);

    const { status, body } = await readBody<Slide>(await patchSlide(
      req("PATCH", { speakerNotes: "" }),
      h.ctx({ deckId: deck.id, slideId: slides[0]!.id }),
    ));

    expect(status).toBe(200);
    expect(body.speakerNotes ?? "").toBe("");
  });

  it("DELETE is 204 and closes the order gap", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);

    const response = await deleteSlide(req("DELETE"), h.ctx({ deckId: deck.id, slideId: slides[1]!.id }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    // Nothing else in the deck changes, unlike the asset delete — which is why 204 is right here and
    // wrong there. The gap closing is the repository's, asserted so the contract is visible at this layer.
    const remaining = await h.services.decks.listSlides(h.userId, deck.id);
    expect(remaining.map((s) => s.order)).toEqual([0, 1]);
  });

  it("POST duplicate returns 201 with a new slide right after the original", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);
    const original = slides[0]!;

    const { status, body } = await readBody<Slide>(await duplicateSlide(
      req("POST"), h.ctx({ deckId: deck.id, slideId: original.id }),
    ));

    expect(status).toBe(201);
    expect(body.id).not.toBe(original.id);
    expect(body.order).toBe(1);
    expect(body.slots).toEqual(original.slots);
  });

  it("POST regenerate replaces content in place and returns the outcome, not the bare slide", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);
    const target = slides[0]!;
    h.llm.push({ text: slideResponseFor(requireLayout(target.layoutId), "Rewritten") });

    const { status, body } = await readBody<{ slideId: string; degraded: boolean; content: unknown }>(
      await regenerateSlide(req("POST", { instruction: "punchier" }), h.ctx({
        deckId: deck.id, slideId: target.id,
      })),
    );

    expect(status).toBe(200);
    expect(body.slideId).toBe(target.id);
    // The outcome, not the slide: a regenerate can partially fail exactly as a deck-level slide can, and
    // the card must be able to show its amber badge rather than display a fallback as the real answer.
    expect(body.degraded).toBe(false);
    expect(h.llm.calls.at(-1)?.prompt).toContain("punchier");

    const stored = await h.services.decks.getSlide(h.userId, deck.id, target.id);
    expect(Object.values(stored.slots).join(" ")).toContain("Rewritten");
    expect(stored.order).toBe(target.order);
  });

  it("POST regenerate reports a degraded slide instead of presenting a fallback as the answer", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);
    // Garbage, then garbage again: the one repair pass also fails, so the fallback renderer runs (§9 row 6).
    h.llm.push({ text: "not json at all" }, { text: "still not json" });

    const { status, body } = await readBody<{ degraded: boolean; content: { issue?: unknown } }>(
      await regenerateSlide(req("POST", {}), h.ctx({ deckId: deck.id, slideId: slides[0]!.id })),
    );

    expect(status).toBe(200);
    expect(body.degraded).toBe(true);
    // Never suppressed (§12): the issue travels with the content so the card can badge it.
    expect(body.content.issue).toBeTruthy();
  });

  it("PUT order reorders the deck and returns the full list", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);
    const reversed = [...slides].reverse().map((s) => s.id);

    const { status, body } = await readBody<{ slides: Slide[] }>(await reorderSlides(
      req("PUT", { orderedIds: reversed }), h.ctx({ deckId: deck.id }),
    ));

    expect(status).toBe(200);
    // The full list back, so the client re-syncs from one response rather than trusting its optimistic
    // guess — which differs from the truth whenever a concurrent delete landed.
    expect(body.slides.map((s) => s.id)).toEqual(reversed);
    expect(body.slides.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it("PUT order refuses a partial permutation rather than applying it", async () => {
    const h = routeHarness();
    const { deck, slides } = await deckWithSlides(h);

    const { status } = await readError(await reorderSlides(
      req("PUT", { orderedIds: [slides[0]!.id] }), h.ctx({ deckId: deck.id }),
    ));

    // A stale client is told, not silently obeyed: reconstructing an intended final order from a partial
    // list is not something either side can do.
    expect(status).toBeGreaterThanOrEqual(400);
    const after = await h.services.decks.listSlides(h.userId, deck.id);
    expect(after.map((s) => s.id)).toEqual(slides.map((s) => s.id));
  });

  it("PUT order rejects an empty list", async () => {
    const h = routeHarness();
    const { deck } = await deckWithSlides(h);
    const { status, body } = await readError(await reorderSlides(
      req("PUT", { orderedIds: [] }), h.ctx({ deckId: deck.id }),
    ));

    expect(status).toBe(400);
    expect(body.issues?.some((i) => i.startsWith("orderedIds"))).toBe(true);
  });
});

/* ─────────────────────────────── workspace + export ─────────────────────────────── */

describe("GET /api/decks/:deckId/workspace", () => {
  it("returns deck, slides, brand, tokens, templates and formats in one response", async () => {
    const h = routeHarness();
    const { deck, brand } = await readyDeck(h);
    scriptCleanDeck(h);
    await generated(h, deck.id);

    const { status, body } = await readBody<{
      deck: DeckMeta; slides: Slide[]; brand: BrandDefinition;
      tokens: unknown; templates: unknown[]; exportFormats: string[];
    }>(await workspace(req("GET"), h.ctx({ deckId: deck.id })));

    expect(status).toBe(200);
    expect(body.deck.id).toBe(deck.id);
    expect(body.slides).toHaveLength(3);
    // One request rather than four, because §8's guarantee is that the preview matches the export: four
    // parallel fetches can interleave with a brand edit and describe a state that never existed.
    expect(body.brand.id).toBe(brand.id);
    expect(body.tokens).toBeTruthy();
    expect(body.exportFormats).toContain("pptx");
    // Only the layouts the deck actually uses — `ExportService.buildRequest` narrows the same way, and
    // the two must agree or the preview would show zones for slides the export never renders.
    expect(body.templates.length).toBeLessThanOrEqual(3);
  });

  it("404s another user's deck", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);
    routeHarness({ defaultUserId: "user-b" });

    const { status } = await readError(await workspace(req("GET"), h.ctx({ deckId: deck.id })));
    expect(status).toBe(404);
  });
});

describe("GET /api/decks/:deckId/export/:format", () => {
  it("returns the PPTX bytes with a Content-Disposition attachment", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    await generated(h, deck.id);

    const response = await exportDeck(req("GET"), h.ctx({ deckId: deck.id, format: "pptx" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type"))
      .toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    // Both forms: the ASCII one for old clients, the RFC 5987 one carrying the real name.
    expect(disposition).toMatch(/filename="[^"]+\.pptx"/);
    expect(disposition).toContain("filename*=UTF-8''");
    // No cache: a deck's export is user-scoped and the URL carries no userId.
    expect(response.headers.get("cache-control")).toBe("no-store");

    const bytes = new Uint8Array(await response.arrayBuffer());
    // A PPTX is a zip; `PK\x03\x04` is the only cheap proof the bytes are the real artifact rather than
    // an empty buffer that every other assertion here would accept.
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
  });

  it("escapes a crafted deck title out of the Content-Disposition header", async () => {
    const h = routeHarness();
    const { body: brand } = await readBody<BrandDefinition>(await createBrand(req("POST", brandInput())));
    const { body: deck } = await readBody<DeckMeta>(await createDeck(req("POST", {
      // A title is user-controlled text that ends up in a response header. The quote would terminate the
      // quoted-string early and let the rest inject a parameter.
      title: 'evil"; filename="owned.exe',
      brandId: brand.id,
      briefing: BRIEFING,
    })));
    await h.container.decks.updateMeta(h.userId, deck.id, { outline: OUTLINE });
    scriptCleanDeck(h);
    await generated(h, deck.id);

    const response = await exportDeck(req("GET"), h.ctx({ deckId: deck.id, format: "pptx" }));
    const disposition = response.headers.get("content-disposition") ?? "";

    expect(disposition).not.toContain('filename="owned.exe"');
    // Exactly one `filename=` parameter survives — anything else means the injection worked.
    expect(disposition.match(/filename="/g)).toHaveLength(1);
  });

  it("reports an unknown format against the exporters this deployment has", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);
    scriptCleanDeck(h);
    await generated(h, deck.id);

    const { status, body } = await readError(
      await exportDeck(req("GET"), h.ctx({ deckId: deck.id, format: "keynote" })),
    );

    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.code).toBe("UnknownExportFormat");
    // Names what IS available, from `formats()` — the same list the workspace and registry publish, so a
    // new exporter is one registration rather than an edit here (§4).
    expect(body.message).toContain("pptx");
  });

  it("404s a deck the user does not own", async () => {
    const h = routeHarness();
    const { deck } = await readyDeck(h);
    routeHarness({ defaultUserId: "user-b" });

    const { status } = await readError(
      await exportDeck(req("GET"), h.ctx({ deckId: deck.id, format: "pptx" })),
    );
    expect(status).toBe(404);
  });
});
