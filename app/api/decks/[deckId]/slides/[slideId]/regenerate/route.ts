/**
 * `POST /api/decks/:deckId/slides/:slideId/regenerate` — re-run generation for ONE slide (SPEC §7.4,
 * §12's "regenerate with instruction" seam).
 *
 * ## Why this is JSON where the deck-level generate is SSE
 *
 * One slide is one LLM call producing one result. There is no intermediate state worth showing: the client
 * has a spinner on that card until the answer lands. Streaming a single `slide-done` would add the SSE
 * parser to a path that gains nothing from it.
 *
 * ## Why the response is a `SlideOutcome` and not a `Slide`
 *
 * A regenerate can partially fail exactly as a deck-level slide can — the model returns garbage, the repair
 * pass also fails, and the fallback renderer produces a bullets slide carrying an error reason and quality
 * flags (§9's matrix, rows 5–6). Returning the outcome rather than the bare slide is what lets the card
 * show its amber badge instead of silently displaying a fallback as if it were the requested content
 * (§12: "never suppressed"). The slide is persisted either way, so the client's view is not a lie.
 *
 * `instruction` is the point of the endpoint ("punchier", "more technical"): §12 requires that it
 * demonstrably alters the output, and `generateSchema` is shared with the deck-level route so the two
 * cannot drift in what they accept. `request.signal` is forwarded so a closed tab stops paying for tokens.
 *
 * `emit` is a no-op here, and that is the honest wiring rather than a gap: the pipeline emits
 * `slide-start` and one terminal event for every slide it runs, and on this path there is no stream to
 * carry them. Everything they would have said — the degraded flag, the issue reason, the quality flags —
 * is on the `SlideOutcome` in the response body. Silence is not lost information; it is the same
 * information, delivered once.
 */

import { getFacade } from "@/lib/container";
import { handle, json, readJson } from "@/lib/http/route-helpers";
import { generateSchema } from "@/lib/http/request-schemas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string; slideId: string }> };

export function POST(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId, slideId } = await ctx.params;
    const body = await readJson(request, generateSchema);

    return json(await getFacade().regenerateSlide(request.headers, deckId, slideId, {
      emit: () => {},
      signal: request.signal,
      ...(body.instruction !== undefined ? { instruction: body.instruction } : {}),
      ...(body.includeSpeakerNotes !== undefined ? { includeSpeakerNotes: body.includeSpeakerNotes } : {}),
      ...(body.density !== undefined ? { density: body.density } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    }));
  });
}
