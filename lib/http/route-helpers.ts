/**
 * The route toolkit — the ONE place an HTTP response is constructed (§2 step 15).
 *
 * ## Why this is a module rather than four lines repeated in twenty routes
 *
 * Every route does the same four things: parse a body, call the facade, serialize the result, and turn a
 * throw into a status. Three of those have a wrong answer that is invisible in review:
 *
 *   1. **Error serialization must not leak `AppError.detail`.** It holds brand ids, asset ids, model
 *      ids, filesystem-adjacent context. `toErrorBody` (in `lib/errors`) applies the allowlist; routes
 *      call `fail` and never touch `detail` at all, so a route *cannot* be the place a leak is
 *      introduced.
 *   2. **A crafted id must not be echoed.** A 404 that reads `Brand "../../etc/passwd" not found` is a
 *      reflected-input hole in an error path, and it is the natural thing to write. The taxonomy's
 *      readable strings name no ids, and `fail` sends only those.
 *   3. **An unexpected throw must still be a JSON error, not an HTML 500.** Next's default error page
 *      would break every client that expects `{code, message}` — including the SSE parser. `handle`
 *      wraps every route body.
 *
 * ## Why routes are wrapped rather than trusted
 *
 * `handle` is not sugar: it is what makes "errors readable request-level" (§13) a property of the layer
 * instead of a habit. A route that forgets a try/catch inherits the wrapper's; a route that wants
 * different behaviour has to say so explicitly.
 *
 * Per §5 this module may import `lib/facade`, `lib/errors`, `lib/stream`, and zod schemas — and nothing
 * else. It constructs nothing (§3): the facade arrives via `getFacade()`.
 */

import type { z } from "zod";
import { AssetTooLarge, InvalidRequest, toErrorBody } from "@/lib/errors/errors";
import { type StreamEvent, toFatalEvent, toSseFrame } from "@/lib/stream/events";

/* ─────────────────────────────── responses ─────────────────────────────── */

/**
 * `Cache-Control: no-store` on every JSON response.
 *
 * Not paranoia about a CDN: all of this data is user-scoped and the serving URLs carry no userId (see
 * `BrandService.getAssetStream`), so any shared cache keyed on URL alone would serve one user's brand
 * list to another. The registries override this deliberately — they are the only truly public payloads.
 */
const NO_STORE = { "cache-control": "no-store" } as const;

export function json(data: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return Response.json(data, {
    status: init?.status ?? 200,
    headers: { ...NO_STORE, ...init?.headers },
  });
}

/** 204, for deletes. No body — a `{ok:true}` envelope invites clients to branch on it. */
export const noContent = (): Response => new Response(null, { status: 204, headers: NO_STORE });

/**
 * The error response. Status and body both come from the taxonomy — see the header's point 1.
 *
 * Logged here, at full detail, precisely because the *response* carries none: without this an
 * `InvalidBrandConfig` on a background asset id becomes unactionable for whoever is on call. 5xx only,
 * so a client sending malformed JSON in a loop cannot fill the log.
 */
export function fail(err: unknown): Response {
  const { body, status } = toErrorBody(err);
  if (status >= 500) console.error("[route]", body.code, err);
  return json(body, { status });
}

/**
 * Wrap a route body so any throw becomes a readable JSON error (§13).
 *
 * `AppError`s carry their own status; anything else collapses to a 500 whose message says nothing about
 * what actually failed (`toReadable`'s contract).
 */
export async function handle(body: () => Promise<Response>): Promise<Response> {
  try {
    return await body();
  } catch (err) {
    return fail(err);
  }
}

/* ─────────────────────────────── request parsing ─────────────────────────────── */

/**
 * Parse a JSON body against a schema, or throw `InvalidRequest` with field-level issues.
 *
 * Malformed JSON is `InvalidRequest` too, not a 500: it is the client's mistake, and the message says so
 * without echoing the body (a parse error's text contains a slice of the input, which is exactly the
 * reflected-input problem the header's point 2 describes).
 *
 * ## An absent body is parsed as `{}`
 *
 * Three endpoints have schemas whose every field is optional — `POST …/outline`, `POST …/generate`, and
 * `POST …/slides/:id/regenerate` — and for all three a bare `POST` with no body means "do it with the
 * defaults", which is what the wizard's buttons actually send. `undefined` would fail every one of those
 * schemas (a zod object rejects it), so the empty object is what makes the intended request expressible.
 *
 * This is not a loosening for schemas that DO require fields: `{}` fails them with the same field-level
 * issues a `{}` body sent explicitly would produce, which is more useful than a message about the body
 * being absent — the client's next step is to add the fields either way.
 */
export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const raw = await readRawJson(request);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw InvalidRequest(describeZodIssues(parsed.error));
  return parsed.data;
}

/**
 * The body as an opaque object, for the endpoints that forward the payload to a *domain* validator
 * (brand create/update/import — see `request-schemas.ts`'s header).
 *
 * It checks one thing: that the body is a JSON object. `null`, an array, a bare string, and an absent
 * body all fail here as `InvalidRequest`, which matters because `validateBrandInput` on a non-object
 * would otherwise report "this brand configuration isn't valid" — blaming the config for what is a
 * malformed request, after paying for a registry read and an asset listing to say so.
 */
export async function readObjectJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await readRawJson(request);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw InvalidRequest(["body: must be a JSON object"]);
  }
  return raw as Record<string, unknown>;
}

/**
 * The body as `unknown`, unchecked. For endpoints whose schema is entirely optional and which therefore
 * accept an absent body (`readJson` handles that case).
 */
export async function readRawJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw InvalidRequest(["body: must be valid JSON"]);
  }
}

/** zod issues → `"field.path: message"`, the same shape `describeIssues` produces for brands. */
export function describeZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path
      .map((p) => (typeof p === "number" ? `[${p}]` : String(p)))
      .join(".")
      .replace(/\.\[/g, "[");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
}

/**
 * A path segment parsed as a non-negative integer (`sectionIndex`, `slideIndex`).
 *
 * `Number()` is deliberately not used: it accepts `" 1"`, `"1e3"`, `"0x2"`, and `""`→0, any of which
 * would index somewhere the client did not ask for. The regex admits digits only.
 */
export function readIndex(raw: string, field: string): number {
  if (!/^\d{1,6}$/.test(raw)) throw InvalidRequest([`${field}: must be a whole number`]);
  return Number.parseInt(raw, 10);
}

/* ─────────────────────────────── multipart upload ─────────────────────────────── */

/** One file part plus the sibling text fields of the same form. */
export interface UploadPart {
  bytes: Uint8Array;
  filename: string;
  /** As declared by the browser (from the file extension) — the service re-derives it from the bytes. */
  declaredType: string;
  /** Every non-file field, so the caller validates them with its own schema. */
  fields: Record<string, string>;
}

/**
 * The multipart body of `POST /api/brands/:id/assets` — the only endpoint that takes one.
 *
 * ## Where the size limit is enforced, and why twice
 *
 * `MAX_ASSET_MB` is checked against `Content-Length` **before** `formData()` is awaited, and again
 * against the part's actual byte length afterwards. Neither check alone is enough:
 *
 *   - The header is a claim. A client can understate it or omit it entirely (chunked encoding), so a
 *     header-only check is bypassable and the stored record's size would be a lie.
 *   - The post-parse check is authoritative but late: by then a 500 MB body has already been buffered
 *     into this process's memory, which is the denial-of-service the limit exists to prevent.
 *
 * So the header check is the cheap door that stops the honest majority of oversized uploads before any
 * allocation, and the byte check is the one that is actually true. `MULTIPART_SLACK` is added to the
 * header bound because a multipart envelope carries boundaries and part headers around the file — without
 * it, a file of exactly the limit would be rejected for the overhead of its own encoding.
 *
 * ⚠️ VERIFY — deferred, and recorded here rather than left implicit: this does not *stream*-limit the
 * body. A client that omits `Content-Length` and sends a chunked body larger than the limit will have it
 * buffered before the second check fires. Closing that requires reading `request.body` through a
 * counting transform and parsing multipart ourselves (Next exposes no per-route body-size limit for App
 * Router handlers, and `next.config.ts`'s `serverActions.bodySizeLimit` applies to Server Actions, not
 * route handlers). For a single-user local-first v1 behind a reverse proxy that has its own
 * `client_max_body_size`, the header check plus the byte check is the documented trade; a public
 * deployment should set the proxy limit and is the reason this note exists.
 */
export async function readUpload(request: Request, maxBytes: number): Promise<UploadPart> {
  const MULTIPART_SLACK = 8 * 1024;
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes + MULTIPART_SLACK) {
    throw AssetTooLarge(declaredLength, maxBytes);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // A malformed envelope, a missing boundary, or a body that is not multipart at all. The client's
    // mistake, and the parser's own message is not something to forward (it varies by runtime).
    throw InvalidRequest(["body: must be a multipart/form-data upload"]);
  }

  const fields: Record<string, string> = {};
  let file: File | undefined;
  for (const [key, value] of form.entries()) {
    // `File` before `string`: a file part is also a `FormDataEntryValue`, and testing for a string first
    // would classify it by whatever `String(file)` produces.
    if (typeof value === "string") fields[key] = value;
    else if (file === undefined) file = value;
  }

  if (!file) throw InvalidRequest(["file: is required"]);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw AssetTooLarge(bytes.byteLength, maxBytes);
  if (bytes.byteLength === 0) throw InvalidRequest(["file: is empty"]);

  return {
    bytes,
    // `File.name` is client-supplied and stored for DISPLAY only (`AssetMeta.filename`'s own note says
    // it never builds a storage key), but it is still bounded and stripped of path separators here: an
    // unbounded name would be persisted in the brand record, and `../` in a displayed name is confusing
    // even where it is inert.
    filename: safeFilename(file.name),
    declaredType: file.type,
    fields,
  };
}

/** Display-safe, bounded, no path separators. Not a storage key — see `readUpload`'s note. */
function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // Control characters are stripped, not replaced: a newline in a name that later reaches a log
  // line or a Content-Disposition header is an injection primitive, and no real filename has one.
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" ? "upload" : cleaned.slice(0, 200);
}

/* ─────────────────────────────── SSE ─────────────────────────────── */

/**
 * The SSE response (SPEC §3's streaming contract).
 *
 * ## Why the job runs inside `start` rather than before the Response is returned
 *
 * A `slide-done` must reach the browser while the *next* slide is still generating — that is the whole
 * point of streaming, and SPEC §9 requires the grid to "fill live". Awaiting the job first would produce
 * one response containing every frame at once, indistinguishable from a plain POST and useless for a
 * ten-slide deck that takes a minute.
 *
 * ## Why `emit` is synchronous and enqueue errors are swallowed
 *
 * `emit` is handed to the generation pipeline, which calls it inside the per-slide sequence. Once the
 * client disconnects, `enqueue` throws — and if that propagated, a closed tab would look like a
 * generation failure and abort the remaining slides. Instead the abort path (below) is what stops the
 * work, deliberately, and a late enqueue is a no-op.
 *
 * ## Client abort — §9's last row
 *
 * `request.signal` is forwarded to the job, which is how "remaining slides stop; completed slides
 * persisted" happens: the pipeline checks the signal between slides and each already-generated slide was
 * persisted before its event was emitted. Nothing here needs to know that; it only has to pass the signal
 * through rather than inventing its own.
 *
 * ## Why a fatal frame, not a status code
 *
 * The status line is already sent by the time any slide runs, so a failure mid-stream cannot become a
 * 502. It becomes one `fatal` event carrying `toReadable`'s text — §13's "readable request-level AND
 * in-stream", with `toFatalEvent` shared with the service layer so both say the same thing.
 */
export function sse(
  request: Request,
  job: (emit: (event: StreamEvent) => void, signal: AbortSignal) => Promise<void>,
  now: () => number = Date.now,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (frame: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // The client is gone. `request.signal` is what stops the work; this is just the write.
          open = false;
        }
      };

      try {
        await job((event) => send(toSseFrame(event)), request.signal);
      } catch (err) {
        send(toSseFrame(toFatalEvent(err, now())));
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by a client disconnect — closing twice throws and means nothing here.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      // Defeats nginx/ALB response buffering, which would otherwise hold frames until the stream ends
      // and turn a live feed into a single delivery — the exact failure this whole route shape exists
      // to avoid, and one that only appears behind a proxy (i.e. never in dev).
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}

/* ─────────────────────────────── binary ─────────────────────────────── */

/**
 * A file download (the PPTX export).
 *
 * `filename` is already sanitized by the one shared `exportFilename` (whitelist, not blacklist — see
 * that function). Both `filename=` and `filename*=` are sent: the plain form is ASCII-folded for old
 * clients, the RFC 5987 form carries the real name, and a browser that understands the second ignores
 * the first. Quotes and backslashes are stripped from the ASCII form because either would terminate the
 * quoted-string early and let a crafted deck title inject a header parameter.
 */
export function download(
  bytes: Uint8Array, contentType: string, filename: string,
): Response {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "");
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      "content-disposition":
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "no-store",
    },
  });
}

/**
 * An asset's bytes, streamed (`GET /api/assets/:id`).
 *
 * ## The headers are the security half of this function
 *
 * SPEC §5 allows SVG uploads, and an `image/svg+xml` response is a DOCUMENT: a browser will execute
 * script in it, in this origin, with access to this origin's cookies. `lib/domain/asset-bytes.ts` rejects
 * such files at upload, and these three headers are the second line — because "we validate on upload"
 * only protects assets uploaded *after* the validator existed, and because a validator gap is a stored
 * XSS without them:
 *
 *   - `Content-Security-Policy: default-src 'none'; …` — the sandbox. Even a script that reached storage
 *     can load nothing and reach nothing. `sandbox` (without `allow-same-origin`) puts the document in an
 *     opaque origin, so it cannot touch this origin's storage or cookies even if it does run.
 *   - `X-Content-Type-Options: nosniff` — stops a browser deciding a `image/png` response is really HTML.
 *   - `Content-Disposition: inline` with no filename — the asset is meant to render in an `<img>`, so
 *     `attachment` would break the preview; naming nothing avoids echoing a client-supplied filename.
 *
 * ## Caching
 *
 * `private, max-age=…, immutable`: assets are immutable (a change is a new id and a new URL), so a long
 * cache is correct and the preview's repeated loads should not re-hit the store. `private` is the
 * essential half — `resolveUrl` puts no userId in the path (see `BrandService.getAssetStream`), so a
 * SHARED cache keyed on URL alone would serve one user's background to another. This is the one response
 * in the app that is cacheable AND user-scoped, which is exactly the combination that needs saying out
 * loud.
 */
export function assetResponse(asset: {
  contentType: string; byteSize: number; body: ReadableStream<Uint8Array>;
}): Response {
  return new Response(asset.body, {
    headers: {
      "content-type": asset.contentType,
      "content-length": String(asset.byteSize),
      "content-disposition": "inline",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
