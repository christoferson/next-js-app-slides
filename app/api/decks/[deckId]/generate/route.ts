/**
 * `POST /api/decks/:deckId/generate` — per-slide generation, streamed as SSE (SPEC §3, §7.3, §9).
 *
 * ## This is the one endpoint whose response shape is the product
 *
 * A ten-slide deck takes a minute. The grid has to "fill live" (SPEC §9), which means a `slide-done` must
 * reach the browser while the next slide is still generating — so the job runs INSIDE the stream (see
 * `sse`), not before the Response is returned. Awaiting the facade first would produce one response
 * containing every frame at once: valid SSE, indistinguishable from a plain POST, and useless.
 *
 * ## What `emit` is, and why the facade takes a callback
 *
 * `GenerationService` decides *which* events occur; this route decides how they are framed on the wire
 * (`toSseFrame`, the single choke point). That split is what makes §9's matrix — including the mid-deck
 * throttle and client-abort rows — testable by collecting events into an array with no HTTP involved.
 *
 * ## Aborts (§9's last row)
 *
 * `request.signal` is forwarded into the job. The pipeline checks it between slides, and each slide is
 * persisted before its event is emitted, which is precisely what "remaining slides stop; completed slides
 * persisted" means. Nothing in this file implements that — it only has to pass the signal through rather
 * than invent its own.
 *
 * ## Errors
 *
 * A per-slide failure is a `slide-error` frame and the deck continues; `deck-done {ok, failed}` reports
 * the true counts. A failure that kills the whole job — an unauthenticated request, a missing outline, a
 * model that cannot be reached at all — becomes exactly one `fatal` frame, because the status line was
 * already sent by the time any slide ran and cannot retroactively become a 502. §13's "readable
 * request-level AND in-stream" is satisfied by the same `toReadable` on both paths.
 *
 * The result of `generateDeck` is deliberately discarded: its `{ok, failed}` is the same pair already
 * announced on `deck-done`, and sending it again after the stream closed is not possible anyway.
 */

import { getFacade } from "@/lib/container";
import { handle, readJson, sse } from "@/lib/http/route-helpers";
import { generateSchema } from "@/lib/http/request-schemas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string }> };

export function POST(request: Request, ctx: Ctx): Promise<Response> {
  // `handle` still wraps this, and it is not redundant with the stream's own error path: the body is read
  // and the params awaited BEFORE the Response exists, so a malformed body must be a JSON 400 rather than
  // a stream containing one `fatal` frame. Once `sse` returns, failures can only be frames.
  return handle(async () => {
    const { deckId } = await ctx.params;
    const body = await readJson(request, generateSchema);

    return sse(request, async (emit, signal) => {
      await getFacade().generateDeck(request.headers, deckId, {
        emit,
        signal,
        ...(body.instruction !== undefined ? { instruction: body.instruction } : {}),
        ...(body.includeSpeakerNotes !== undefined ? { includeSpeakerNotes: body.includeSpeakerNotes } : {}),
        ...(body.density !== undefined ? { density: body.density } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      });
    });
  });
}
