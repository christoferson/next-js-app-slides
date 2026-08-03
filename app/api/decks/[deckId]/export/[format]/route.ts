/**
 * `GET /api/decks/:deckId/export/:format` — the download (SPEC §3, §11 step 9).
 *
 * ## `format` is a path segment, and it is not validated here
 *
 * `ExportService` resolves it against the registered exporters and raises `UnknownExportFormat` naming the
 * ones this deployment actually has. A `z.enum(["pptx"])` at the route would be the §4 parallel table in
 * its plainest form: adding a PDF exporter is meant to be one registration, and a second hardcoded list
 * here would make it two — with the route's copy silently 400ing a format the service can produce. The
 * available list is also what `GET /api/registry/*` and `WorkspaceView.exportFormats` publish, all from the
 * same `formats()`.
 *
 * ## Why `GET`, and why that is a considered choice
 *
 * Exporting is expensive and not idempotent in the cheap sense — it renders images and builds a zip on
 * every call. But it creates no state, and a download has to be reachable by `window.location` /
 * `<a download>` for the browser to hand it to the OS file dialog. A `POST` would force the client to
 * buffer the whole deck in JS and re-serve it through a blob URL, which for a 20 MB PPTX is worse in every
 * way. `no-store` (set by `download`) keeps the response out of any cache.
 *
 * ## Headers
 *
 * All three come from `ExportResult` through the one shared `download` helper, which is also where the
 * `Content-Disposition` injection defence lives: the filename was built by `exportFilename` (a whitelist),
 * and `download` still strips quotes and backslashes from the ASCII form and sends an RFC 5987 `filename*`
 * for the real one. A deck title is user-controlled text that ends up in a response header, so both layers
 * are deliberate.
 */

import { getFacade } from "@/lib/container";
import { download, handle } from "@/lib/http/route-helpers";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ deckId: string; format: string }> };

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { deckId, format } = await ctx.params;
    const result = await getFacade().exportDeck(request.headers, deckId, format);
    return download(result.bytes, result.contentType, result.filename);
  });
}
