/**
 * `/api/decks*` — the deck, outline, and slide routes of §2 step 15.
 *
 * Same scope discipline as `routes-brands.test.ts`: what the route decides, not what the services already
 * prove. Three things here are load-bearing rather than incidental:
 *
 *   - **`PATCH /api/decks/:id` returns a DIFFERENT shape when `brandId` is present** (the swap's
 *     re-resolved templates). A client discriminates on which field it sent, so the shape has to be
 *     pinned by a test or the next refactor collapses it into a plain meta write.
 *   - **`PATCH …/outline` parses the document.** Before `parseEditedOutline` existed this route would
 *     persist arbitrary JSON and the next generation run would map over slides with no `message`. The
 *     asymmetry it rests on — a *user* may pin a `layoutOverride`, a *model* may not — is asserted here.
 *   - **`maxSourceTextChars` takes effect at the HTTP edge**, and nowhere else can apply it.
 */

import { describe, expect, it } from "vitest";
import { GET as listDecks, POST as createDeck } from "@/app/api/decks/route";
import { DELETE as deleteDeck, GET as getDeck, PATCH as patchDeck } from "@/app/api/decks/[deckId]/route";
import {
  GET as getOutline, PATCH as patchOutline, POST as postOutline,
} from "@/app/api/decks/[deckId]/outline/route";
import { PUT as putLayout } from "@/app/api/decks/[deckId]/outline/sections/[sectionIndex]/slides/[slideIndex]/layout/route";
import { POST as createBrand } from "@/app/api/brands/route";
import { type RouteHarness, rawReq, readBody, readError, req, routeHarness } from "@/tests/route-harness";
import { brandInput } from "@/tests/service-harness";
import type { BrandDefinition } from "@/lib/brand/types";
import type { Briefing, Outline } from "@/lib/domain/deck";
import type { DeckMeta } from "@/lib/domain/deck";

/**
 * `targetSlideCount: 5`, not 4.
 *
 * The service suites use 4 quite legally — a domain `Briefing` has no count bound, because the bound is
 * SPEC §9's UI range and belongs at the HTTP edge. Going through the route applies `briefingSchema`, whose
 * floor is 5, so a 4 here would 400 every deck this file creates. Worth stating rather than silently
 * matching: it is the same layering split the whole suite is about, seen from the fixture side.
 */
const BRIEFING: Briefing = {
  topic: "Billing reliability",
  audience: "The exec team",
  objective: "Approve the remediation budget",
  targetSlideCount: 5,
};

/** Four slides across two headed sections — hinted so no advisory fires and the counts match the target. */
const FOUR_SLIDES: Outline = {
  sections: [
    {
      heading: "Where we are",
      slides: [
        { question: "Why are we here?", message: "Billing broke repeatedly.", evidence: [], visualHint: "opening" },
        { question: "What broke?", message: "Nineteen incidents in Q3.", evidence: ["19 incidents"], visualHint: "list" },
      ],
    },
    {
      heading: "What we'll do",
      slides: [
        { question: "What's the plan?", message: "Three fixes, in order.", evidence: [], visualHint: "list" },
        { question: "What next?", message: "Approve the budget.", evidence: [], visualHint: "closing" },
      ],
    },
  ],
};

async function seedBrand(): Promise<BrandDefinition> {
  const { body } = await readBody<BrandDefinition>(await createBrand(req("POST", brandInput())));
  return body;
}

/** A deck with a brand and a briefing — the state the outline endpoints require. */
async function seedDeck(briefing: Briefing | null = BRIEFING): Promise<{ brand: BrandDefinition; deck: DeckMeta }> {
  const brand = await seedBrand();
  const { body: deck } = await readBody<DeckMeta>(await createDeck(req("POST", {
    title: "Q3 Review",
    brandId: brand.id,
    ...(briefing !== null ? { briefing } : {}),
  })));
  return { brand, deck };
}

/* ─────────────────────────────── collection ─────────────────────────────── */

describe("POST /api/decks", () => {
  it("returns 201 with the created deck", async () => {
    routeHarness();
    const { deck } = await seedDeck();

    expect(deck.title).toBe("Q3 Review");
    expect(deck.briefing).toMatchObject({ topic: "Billing reliability" });
  });

  it("404s BrandNotFound at creation, not later (facade orchestration)", async () => {
    routeHarness();
    const { status, body } = await readError(
      await createDeck(req("POST", { title: "Orphan", brandId: "id-does-not-exist" })),
    );

    // The alternative is a deck that exists and fails at outline time with a confusing BrandNotFound on
    // an unrelated action. Failing on the request that actually named the brand is the facade's job, and
    // the route's contribution is that it does not invent a 400 for it.
    expect(status).toBe(404);
    expect(body.code).toBe("BrandNotFound");
  });

  it("rejects an unknown body key rather than ignoring it", async () => {
    routeHarness();
    const brand = await seedBrand();
    const { status, body } = await readError(await createDeck(req("POST", {
      title: "Q3", brandId: brand.id, tempreature: 0.5,
    })));

    expect(status).toBe(400);
    expect(body.issues?.some((i) => i.includes("tempreature"))).toBe(true);
  });

  it("applies maxSourceTextChars — the config knob only this layer can enforce", async () => {
    routeHarness({ maxSourceTextChars: 50 });
    const brand = await seedBrand();

    const { status, body } = await readError(await createDeck(req("POST", {
      title: "Q3",
      brandId: brand.id,
      briefing: { ...BRIEFING, sourceText: "x".repeat(51) },
    })));

    expect(status).toBe(400);
    // Names the limit, because "too long" with no number is unactionable — and names the field, because
    // the briefing has five of them.
    expect(body.issues?.some((i) => i.startsWith("briefing.sourceText") && i.includes("50"))).toBe(true);
  });

  it("rejects a slide count outside 5–30 instead of clamping it (SPEC §9)", async () => {
    routeHarness();
    const brand = await seedBrand();
    const { status, body } = await readError(await createDeck(req("POST", {
      title: "Q3", brandId: brand.id, briefing: { ...BRIEFING, targetSlideCount: 200 },
    })));

    // Unlike temperature, which is clamped: a count of 200 is a client with no slider, and silently
    // generating 30 slides for it would be a surprising bill.
    expect(status).toBe(400);
    expect(body.issues?.some((i) => i.includes("targetSlideCount"))).toBe(true);
  });
});

describe("GET /api/decks", () => {
  it("returns a `{decks}` envelope scoped to the principal", async () => {
    routeHarness();
    await seedDeck();
    const { status, body } = await readBody<{ decks: unknown[] }>(await listDecks(req("GET")));

    expect(status).toBe(200);
    expect(body.decks).toHaveLength(1);
  });
});

/* ─────────────────────────────── one deck ─────────────────────────────── */

describe("GET | PATCH | DELETE /api/decks/:deckId", () => {
  it("GET returns the meta and 404s an unknown id without echoing it", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();

    const found = await readBody<DeckMeta>(await getDeck(req("GET"), h.ctx({ deckId: deck.id })));
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(deck.id);

    const missing = await readError(await getDeck(req("GET"), h.ctx({ deckId: "../../etc/passwd" })));
    expect(missing.status).toBe(404);
    expect(JSON.stringify(missing.body)).not.toContain("passwd");
  });

  it("PATCH title returns the updated meta", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();
    h.clock.tick();

    const { status, body } = await readBody<DeckMeta>(
      await patchDeck(req("PATCH", { title: "Renamed" }), h.ctx({ deckId: deck.id })),
    );

    expect(status).toBe(200);
    expect(body.title).toBe("Renamed");
    expect(body.updatedAt).not.toBe(deck.updatedAt);
  });

  it("PATCH briefing makes an unready deck ready", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck(null);
    expect(deck.briefing).toBeUndefined();

    const { status, body } = await readBody<DeckMeta>(
      await patchDeck(req("PATCH", { briefing: BRIEFING }), h.ctx({ deckId: deck.id })),
    );

    expect(status).toBe(200);
    expect(body.briefing).toMatchObject({ objective: BRIEFING.objective });
  });

  it("PATCH brandId returns the swap's re-resolved view, not a bare meta", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();
    const other = await createBrand(req("POST", brandInput({ name: "Second" })));
    const { body: second } = await readBody<BrandDefinition>(other);

    const { status, body } = await readBody<{
      deck: DeckMeta; brand: BrandDefinition; tokens: unknown; templates: unknown[];
    }>(await patchDeck(req("PATCH", { brandId: second.id }), h.ctx({ deckId: deck.id })));

    expect(status).toBe(200);
    // The whole reason this route returns early on `brandId`: the caller's next need after a swap is
    // always to re-render, and a bare meta would force a second round trip to discover the new zones.
    expect(body.deck.brandId).toBe(second.id);
    expect(body.brand.id).toBe(second.id);
    expect(body.tokens).toBeTruthy();
    expect(Array.isArray(body.templates)).toBe(true);
  });

  it("PATCH applies title and briefing together, and brandId still wins the response", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck(null);
    const { body: second } = await readBody<BrandDefinition>(
      await createBrand(req("POST", brandInput({ name: "Second" }))),
    );

    const { body } = await readBody<{ deck: DeckMeta }>(await patchDeck(
      req("PATCH", { title: "All three", briefing: BRIEFING, brandId: second.id }),
      h.ctx({ deckId: deck.id }),
    ));

    // All three writes happened even though only the swap shaped the response — the route applies
    // title → briefing → brandId in order, deliberately non-atomically (see its header).
    expect(body.deck.title).toBe("All three");
    expect(body.deck.briefing).toMatchObject({ topic: BRIEFING.topic });
    expect(body.deck.brandId).toBe(second.id);
  });

  it("PATCH rejects an empty patch", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();
    const { status, body } = await readError(
      await patchDeck(req("PATCH", {}), h.ctx({ deckId: deck.id })),
    );

    // A 200 here would let a broken client believe it saved something.
    expect(status).toBe(400);
    expect(body.issues?.some((i) => i.includes("at least one"))).toBe(true);
  });

  it("PATCH 404s a brandId the user does not own, and does not apply the earlier fields", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();

    const { status } = await readError(await patchDeck(
      req("PATCH", { title: "Renamed", brandId: "id-nope" }),
      h.ctx({ deckId: deck.id }),
    ));
    expect(status).toBe(404);

    // Non-atomic, and this is what that costs: the title DID land. Asserted rather than left implicit,
    // because a future reader deciding to reorder the writes should see the behaviour is under test.
    const { body } = await readBody<DeckMeta>(await getDeck(req("GET"), h.ctx({ deckId: deck.id })));
    expect(body.title).toBe("Renamed");
    expect(body.brandId).not.toBe("id-nope");
  });

  it("DELETE is 204 and the deck is gone", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();

    expect((await deleteDeck(req("DELETE"), h.ctx({ deckId: deck.id }))).status).toBe(204);
    const { status } = await readError(await getDeck(req("GET"), h.ctx({ deckId: deck.id })));
    expect(status).toBe(404);
  });
});

/* ─────────────────────────────── outline ─────────────────────────────── */

describe("POST /api/decks/:deckId/outline", () => {
  it("generates, persists, and returns the view in one call", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();
    h.llm.push({ text: JSON.stringify(FOUR_SLIDES) });

    const { status, body } = await readBody<{
      outline: Outline; advisories: unknown[]; repaired: boolean;
    }>(await postOutline(req("POST", {}), h.ctx({ deckId: deck.id })));

    expect(status).toBe(200);
    expect(body.outline.sections).toHaveLength(2);
    expect(body.repaired).toBe(false);

    // Persisted in the same call: a reload must not cost a second model call.
    const { body: stored } = await readBody<{ outline: Outline }>(
      await getOutline(req("GET"), h.ctx({ deckId: deck.id })),
    );
    expect(stored.outline).toEqual(body.outline);
  });

  it("accepts no body at all, since every field is optional", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();
    h.llm.push({ text: JSON.stringify(FOUR_SLIDES) });

    // `readJson` treats an absent body as `undefined` rather than failing, which is what lets a bare POST
    // mean "generate with defaults" — the wizard's actual request.
    const { status } = await readBody(await postOutline(
      new Request("http://test.local/api", { method: "POST" }),
      h.ctx({ deckId: deck.id }),
    ));
    expect(status).toBe(200);
  });

  it("dispatches to regenerateSection when sectionIndex is present", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();
    h.llm.push({ text: JSON.stringify(FOUR_SLIDES) });
    await postOutline(req("POST", {}), h.ctx({ deckId: deck.id }));

    h.llm.push({ text: JSON.stringify({
      heading: "Where we are",
      slides: [{ question: "Rewritten?", message: "A punchier claim.", evidence: [], visualHint: "list" }],
    }) });

    const { status, body } = await readBody<{ outline: Outline }>(
      await postOutline(req("POST", { sectionIndex: 0, instruction: "punchier" }), h.ctx({ deckId: deck.id })),
    );

    expect(status).toBe(200);
    // One section replaced, the other untouched — the discriminator is `sectionIndex`'s presence and
    // nothing else, so this is the assertion that keeps the two paths distinct.
    expect(body.outline.sections[0]?.slides).toHaveLength(1);
    expect(body.outline.sections[1]?.slides).toHaveLength(2);
    expect(h.llm.calls.at(-1)?.prompt).toContain("punchier");
  });

  it("409s DeckNotReady when there is no briefing", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck(null);

    const { status, body } = await readError(
      await postOutline(req("POST", {}), h.ctx({ deckId: deck.id })),
    );

    expect(status).toBe(409);
    expect(body.code).toBe("DeckNotReady");
    // Names the step to do next: the wizard has three stages and "which one" is the useful content.
    expect(body.message).toMatch(/briefing/i);
    // And no model call was made — a 409 that had already spent tokens would be worse than a 500.
    expect(h.llm.calls).toHaveLength(0);
  });

  /**
   * The exact failure that motivated `ModelNotConfigured`, at the route it was found on.
   *
   * Unlike `…/generate`, this endpoint is plain JSON, so an unconfigured deployment CAN be reported as a
   * status code — and this is the assertion that it is a 503 naming the variable rather than the opaque
   * `Internal` 500 ("something went wrong on our side") it produced before. That 500 was what a real
   * seeding run hit, with the actual cause visible only in the server log.
   */
  it("503s ModelNotConfigured when DEFAULT_LLM_MODEL_ID is unset, rather than a 500", async () => {
    const h = routeHarness({ outlineModelId: "" });
    const { deck } = await seedDeck();

    const { status, body } = await readError(
      await postOutline(req("POST", {}), h.ctx({ deckId: deck.id })),
    );

    expect(status).toBe(503);
    expect(body.code).toBe("ModelNotConfigured");
    expect(body.message).toContain("DEFAULT_LLM_MODEL_ID");
    // Not retryable: the same request will fail identically until someone sets the variable, and a Retry
    // button here would be a lie.
    expect(body.retryable).toBe(false);
    // The registered ids stay in the log-only `detail` — they are ours, and useless to a user.
    expect(JSON.stringify(body)).not.toContain("us.anthropic");
    expect(h.llm.calls).toHaveLength(0);
  });

  it("rejects a negative sectionIndex", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();
    const { status, body } = await readError(
      await postOutline(req("POST", { sectionIndex: -1 }), h.ctx({ deckId: deck.id })),
    );

    expect(status).toBe(400);
    expect(body.issues?.some((i) => i.startsWith("sectionIndex"))).toBe(true);
  });
});

describe("PATCH /api/decks/:deckId/outline", () => {
  it("saves an edited document and returns the re-derived view", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();

    const edited: Outline = {
      sections: [{
        ...FOUR_SLIDES.sections[0]!,
        slides: [{ ...FOUR_SLIDES.sections[0]!.slides[0]!, message: "Reworded by hand." }],
      }, FOUR_SLIDES.sections[1]!],
    };

    const { status, body } = await readBody<{ outline: Outline; advisories: unknown[] }>(
      await patchOutline(req("PATCH", { outline: edited }), h.ctx({ deckId: deck.id })),
    );

    expect(status).toBe(200);
    expect(body.outline.sections[0]?.slides[0]?.message).toBe("Reworded by hand.");
    // Saved, not just echoed.
    const { body: stored } = await readBody<{ outline: Outline }>(
      await getOutline(req("GET"), h.ctx({ deckId: deck.id })),
    );
    expect(stored.outline.sections[0]?.slides[0]?.message).toBe("Reworded by hand.");
    // No model call: saving edits is a write, not a generation.
    expect(h.llm.calls).toHaveLength(0);
  });

  it("rejects a malformed outline with field-level issues instead of persisting it", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();

    // The defect this route had before `parseEditedOutline` existed: a slide with no `message` would be
    // stored, and the next generation run would map over it and build a prompt from `undefined`.
    const { status, body } = await readError(await patchOutline(
      req("PATCH", { outline: { sections: [{ heading: "H", slides: [{ question: "Q?" }] }] } }),
      h.ctx({ deckId: deck.id }),
    ));

    expect(status).toBe(400);
    expect(body.code).toBe("InvalidRequest");
    expect(body.issues?.some((i) => i.includes("message"))).toBe(true);

    const { status: readStatus } = await readError(await getOutline(req("GET"), h.ctx({ deckId: deck.id })));
    expect(readStatus).toBe(409);
  });

  it("PRESERVES a user's layoutOverride — the asymmetry with the model's schema", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();

    const pinned: Outline = {
      sections: [{
        heading: "Where we are",
        slides: [{
          ...FOUR_SLIDES.sections[0]!.slides[0]!,
          layoutOverride: "bullets",
        }],
      }],
    };

    const { status, body } = await readBody<{ outline: Outline }>(
      await patchOutline(req("PATCH", { outline: pinned }), h.ctx({ deckId: deck.id })),
    );

    expect(status).toBe(200);
    // A person editing their own outline is exactly who may pin a layout. The MODEL's schema strips the
    // same field (`outlineSlideSchema`), so a model cannot outrank the mapping chain — two schemas rather
    // than a boolean flag, so the generation path cannot reach the permissive one by accident.
    expect(body.outline.sections[0]?.slides[0]?.layoutOverride).toBe("bullets");
  });

  it("rejects a layoutOverride naming no registered layout", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();

    const { status, body } = await readError(await patchOutline(
      req("PATCH", {
        outline: {
          sections: [{
            heading: "H",
            slides: [{ ...FOUR_SLIDES.sections[0]!.slides[0]!, layoutOverride: "no-such-layout" }],
          }],
        },
      }),
      h.ctx({ deckId: deck.id }),
    ));

    expect(status).toBe(400);
    // Checked against the registry by the service, not by a route-level enum (§4). The damage the check
    // prevents: a client told a pin was saved that the mapping chain would silently ignore.
    expect(JSON.stringify(body)).toMatch(/layout/i);
  });

  it("rejects a body with no `outline` key", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();
    const { status } = await readError(
      await patchOutline(rawReq("PATCH", "{}"), h.ctx({ deckId: deck.id })),
    );
    // `saveOutlineSchema` requires the key even though its value is `unknown`: `{}` would otherwise
    // reach `parseEditedOutline` as `undefined` and be reported as a broken outline rather than a
    // malformed request.
    expect(status).toBe(400);
  });
});

describe("GET /api/decks/:deckId/outline", () => {
  it("409s before an outline exists", async () => {
    const h = routeHarness();
    const { deck } = await seedDeck();
    const { status, body } = await readError(await getOutline(req("GET"), h.ctx({ deckId: deck.id })));

    expect(status).toBe(409);
    expect(body.code).toBe("DeckNotReady");
  });
});

/* ─────────────────────────────── layout override ─────────────────────────────── */

describe("PUT /api/decks/:deckId/outline/sections/:si/slides/:li/layout", () => {
  async function outlined(h: RouteHarness): Promise<DeckMeta> {
    const { deck } = await seedDeck();
    h.llm.push({ text: JSON.stringify(FOUR_SLIDES) });
    await postOutline(req("POST", {}), h.ctx({ deckId: deck.id }));
    return deck;
  }

  it("pins a layout on one slide and leaves the rest alone", async () => {
    const h = routeHarness();
    const deck = await outlined(h);

    const { status, body } = await readBody<{ outline: Outline }>(await putLayout(
      req("PUT", { layoutId: "bullets" }),
      h.ctx({ deckId: deck.id, sectionIndex: "0", slideIndex: "1" }),
    ));

    expect(status).toBe(200);
    expect(body.outline.sections[0]?.slides[1]?.layoutOverride).toBe("bullets");
    expect(body.outline.sections[0]?.slides[0]?.layoutOverride).toBeUndefined();
  });

  it("clears the pin with an explicit null", async () => {
    const h = routeHarness();
    const deck = await outlined(h);
    const ctx = h.ctx({ deckId: deck.id, sectionIndex: "0", slideIndex: "1" });
    await putLayout(req("PUT", { layoutId: "bullets" }), ctx);

    const { body } = await readBody<{ outline: Outline }>(await putLayout(
      req("PUT", { layoutId: null }),
      h.ctx({ deckId: deck.id, sectionIndex: "0", slideIndex: "1" }),
    ));

    // Nullable rather than optional, because "absent" and "explicitly cleared" must be distinguishable —
    // an optional field would make clearing a pin unexpressible.
    expect(body.outline.sections[0]?.slides[1]?.layoutOverride).toBeUndefined();
  });

  it("rejects a non-numeric index rather than coercing it", async () => {
    const h = routeHarness();
    const deck = await outlined(h);

    // Every one of these coerces to a number via `Number()` and would index somewhere the client did not
    // ask for: `" 1"`→1, `"1e3"`→1000, `"0x2"`→2, `""`→0.
    for (const sectionIndex of [" 1", "1e3", "0x2", "", "-1", "1.5"]) {
      const { status, body } = await readError(await putLayout(
        req("PUT", { layoutId: "bullets" }),
        h.ctx({ deckId: deck.id, sectionIndex, slideIndex: "0" }),
      ));
      expect(status, `sectionIndex ${JSON.stringify(sectionIndex)}`).toBe(400);
      expect(body.issues).toEqual(["sectionIndex: must be a whole number"]);
    }
  });

  it("reports an out-of-range index readably rather than silently doing nothing", async () => {
    const h = routeHarness();
    const deck = await outlined(h);

    const { status } = await readError(await putLayout(
      req("PUT", { layoutId: "bullets" }),
      h.ctx({ deckId: deck.id, sectionIndex: "9", slideIndex: "0" }),
    ));
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it("rejects an empty-string layoutId, which is neither a pin nor a clear", async () => {
    const h = routeHarness();
    const deck = await outlined(h);

    const { status, body } = await readError(await putLayout(
      req("PUT", { layoutId: "" }),
      h.ctx({ deckId: deck.id, sectionIndex: "0", slideIndex: "0" }),
    ));
    expect(status).toBe(400);
    expect(body.issues?.some((i) => i.startsWith("layoutId"))).toBe(true);
  });
});
