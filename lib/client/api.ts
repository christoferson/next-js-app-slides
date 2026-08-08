/**
 * The typed API client — the browser's ONLY contact with the server (CLAUDE.md §2 step 16).
 *
 * Every component fetches through here. That is not tidiness: it is what makes §5's client-side boundary
 * checkable, because a component reaching the network any other way is a grep away, and it is what gives
 * the whole UI ONE error type to render instead of a `catch` per call site.
 *
 * ## Why `ApiError` carries the envelope rather than a string
 *
 * `toErrorBody` (`lib/errors/errors.ts`) serializes `{ code, message, retryable, issues? }`, and every one
 * of those four drives a different UI decision: `message` is what the user reads, `code` picks the
 * treatment (a `BrandInUse` needs a "which decks?" affordance, a `ModelThrottled` needs a Retry),
 * `retryable` decides whether that Retry exists at all, and `issues` are the field-level zod messages the
 * brand JSON importer shows inline (§12: "invalid config → field-level readable zod errors"). Flattening
 * this to `throw new Error(message)` at the boundary would throw away three of them and force every screen
 * to re-parse prose.
 *
 * ## Imports types, never runtime server code
 *
 * The domain/registry/stream types below are `import type` only, so nothing server-side is pulled into the
 * client bundle — §0.5's guarantee. `lib/stream/events` is the one exception with a runtime import
 * (`isStreamEvent`), and it is deliberately pure data-validation with no server dependency; §12's bundle
 * grep is what keeps that honest.
 */

import type { ErrorBody, ErrorCode } from "@/lib/errors/errors";
import type { StreamEvent } from "@/lib/stream/events";
// The ONE runtime import from `lib/` in this module — deliberately so, which is what makes §12's bundle
// grep meaningful: if that grep ever finds server code in the client chunk, this is the only line that
// could have pulled it in. `lib/stream/events` is pure data validation with no server dependency.
import { isStreamEvent } from "@/lib/stream/events";

/**
 * A non-2xx response, with the server's envelope intact.
 *
 * Also used for transport failures (offline, DNS, an aborted fetch), which have no envelope — those get a
 * synthesized `Internal`/`retryable: true` body, because from the UI's point of view "the network dropped"
 * and "the server had an internal error" want the identical affordance: a readable line and a Retry.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly issues: readonly string[];
  readonly status: number;

  constructor(body: ErrorBody, status: number) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.retryable = body.retryable;
    this.issues = body.issues ?? [];
    this.status = status;
  }
}

/** True when `value` looks like the server's error envelope rather than an arbitrary JSON body. */
function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["code"] === "string" && typeof v["message"] === "string";
}

/**
 * The one fetch.
 *
 * A 204 (or any empty body) resolves to `undefined` rather than throwing on an empty JSON parse — several
 * routes legitimately return no content (DELETE, PATCH order), and making each caller special-case that
 * would be the same duplication this module exists to remove.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        // Only set JSON content-type when there IS a body, and never for FormData — the browser must be
        // left to write its own multipart boundary, and overriding it is the classic silent upload break.
        ...(init?.body !== undefined && !(init.body instanceof FormData)
          ? { "content-type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    // Transport-level: no envelope exists to read. An aborted request is the caller's own doing, so it is
    // rethrown untouched rather than dressed up as a server error the UI would then offer to retry.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(
      { code: "Internal", message: "Could not reach the server. Check your connection and try again.", retryable: true },
      0,
    );
  }

  const text = await response.text();
  const parsed: unknown = text === "" ? undefined : safeJson(text);

  if (!response.ok) {
    throw isErrorBody(parsed)
      ? new ApiError(parsed, response.status)
      // A non-2xx that is not our envelope means something upstream of the route answered (a proxy, a
      // Next.js framework error page). Status-derived text, never the raw HTML body.
      : new ApiError(
        { code: "Internal", message: `The server returned ${response.status}. Please try again.`, retryable: response.status >= 500 },
        response.status,
      );
  }

  return parsed as T;
}

/** `JSON.parse` that cannot throw — a malformed 200 body becomes `undefined`, handled by the caller's type. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const json = (body: unknown): RequestInit["body"] => JSON.stringify(body);

/* ─────────────────────────────── the surface ─────────────────────────────── */

/**
 * Grouped by resource to mirror `app/api/**`, so a screen's data needs read as a path.
 *
 * Deliberately untyped in its RETURN shapes at this layer (`unknown`-free but structurally loose): the
 * server's domain types are imported by the screens that use them. Adding a `Promise<BrandDefinition>`
 * here would be correct but would also mean this file grows an import for every domain type in the app,
 * and the screens already need those imports anyway.
 */
export const api = {
  registry: {
    layouts: <T>() => request<T>("/api/registry/layouts"),
    fonts: <T>() => request<T>("/api/registry/fonts"),
    tones: <T>() => request<T>("/api/registry/tones"),
    models: <T>() => request<T>("/api/registry/models"),
  },

  brands: {
    list: <T>() => request<T>("/api/brands"),
    get: <T>(brandId: string) => request<T>(`/api/brands/${encodeURIComponent(brandId)}`),
    create: <T>(body: unknown) => request<T>("/api/brands", { method: "POST", body: json(body) }),
    /** `PUT`: the editor and the JSON importer both submit whole configs, and the route is a full
     *  replace of the editable surface — see its own note on why it is not a `PATCH`. */
    update: <T>(brandId: string, body: unknown) =>
      request<T>(`/api/brands/${encodeURIComponent(brandId)}`, { method: "PUT", body: json(body) }),
    remove: (brandId: string) =>
      request<void>(`/api/brands/${encodeURIComponent(brandId)}`, { method: "DELETE" }),
    /** Raw JSON import that CREATES a new brand (§12) — zod failures arrive as `ApiError.issues`. */
    import: <T>(body: unknown) => request<T>("/api/brands/import", { method: "POST", body: json(body) }),
    /**
     * Raw JSON import that REPLACES this brand.
     *
     * A separate method rather than an optional `brandId` on `import`, because the two hit different
     * routes with different verbs — and because "create from this file" and "overwrite the brand I have
     * open with this file" are decisions the user makes explicitly, not a parameter to be defaulted.
     */
    importInto: <T>(brandId: string, body: unknown) =>
      request<T>(`/api/brands/${encodeURIComponent(brandId)}/import`, {
        method: "PUT", body: json(body),
      }),

    /**
     * Asset upload. `FormData`, so `request` leaves the multipart boundary to the browser.
     *
     * `layoutId` is sent only for backgrounds — a logo has no layout, and sending an empty string would
     * make the route's schema reject it rather than treat it as absent.
     */
    upload: <T>(brandId: string, file: File, meta: { kind: "logo" | "background"; layoutId?: string; variant?: string }) => {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", meta.kind);
      if (meta.layoutId !== undefined) form.set("layoutId", meta.layoutId);
      if (meta.variant !== undefined) form.set("variant", meta.variant);
      return request<T>(`/api/brands/${encodeURIComponent(brandId)}/assets`, { method: "POST", body: form });
    },
    removeAsset: (brandId: string, assetId: string) =>
      request<void>(
        `/api/brands/${encodeURIComponent(brandId)}/assets/${encodeURIComponent(assetId)}`,
        { method: "DELETE" },
      ),
  },

  decks: {
    list: <T>() => request<T>("/api/decks"),
    get: <T>(deckId: string) => request<T>(`/api/decks/${encodeURIComponent(deckId)}`),
    create: <T>(body: unknown) => request<T>("/api/decks", { method: "POST", body: json(body) }),
    update: <T>(deckId: string, body: unknown) =>
      request<T>(`/api/decks/${encodeURIComponent(deckId)}`, { method: "PATCH", body: json(body) }),
    remove: (deckId: string) =>
      request<void>(`/api/decks/${encodeURIComponent(deckId)}`, { method: "DELETE" }),

    /** Everything one workspace screen needs, in one round trip — deck + brand tokens + slides. */
    workspace: <T>(deckId: string) =>
      request<T>(`/api/decks/${encodeURIComponent(deckId)}/workspace`),

    /**
     * The outline editor's read: plan + advisories + mapping preview in one round trip. The three must
     * describe the same document, which is why the server composes them (`OutlineService.view`).
     */
    outlineView: <T>(deckId: string) =>
      request<T>(`/api/decks/${encodeURIComponent(deckId)}/outline`),

    outline: <T>(deckId: string, body?: unknown) =>
      request<T>(`/api/decks/${encodeURIComponent(deckId)}/outline`, {
        method: "POST",
        ...(body !== undefined ? { body: json(body) } : {}),
      }),
    saveOutline: <T>(deckId: string, body: unknown) =>
      request<T>(`/api/decks/${encodeURIComponent(deckId)}/outline`, { method: "PATCH", body: json(body) }),
    /**
     * `PUT`, not `PATCH`: the route replaces the pin outright, and `null` clears it — "absent" and
     * "explicitly cleared" have to stay distinguishable. A mismatched verb here is a 405 no test would
     * have caught, since the smoke script calls the path directly.
     */
    setSlideLayout: <T>(deckId: string, sectionIndex: number, slideIndex: number, body: unknown) =>
      request<T>(
        `/api/decks/${encodeURIComponent(deckId)}/outline/sections/${sectionIndex}`
        + `/slides/${slideIndex}/layout`,
        { method: "PUT", body: json(body) },
      ),

    updateSlide: <T>(deckId: string, slideId: string, body: unknown) =>
      request<T>(
        `/api/decks/${encodeURIComponent(deckId)}/slides/${encodeURIComponent(slideId)}`,
        { method: "PATCH", body: json(body) },
      ),
    removeSlide: (deckId: string, slideId: string) =>
      request<void>(
        `/api/decks/${encodeURIComponent(deckId)}/slides/${encodeURIComponent(slideId)}`,
        { method: "DELETE" },
      ),
    duplicateSlide: <T>(deckId: string, slideId: string) =>
      request<T>(
        `/api/decks/${encodeURIComponent(deckId)}/slides/${encodeURIComponent(slideId)}/duplicate`,
        { method: "POST" },
      ),
    regenerateSlide: <T>(deckId: string, slideId: string, body: unknown) =>
      request<T>(
        `/api/decks/${encodeURIComponent(deckId)}/slides/${encodeURIComponent(slideId)}/regenerate`,
        { method: "POST", body: json(body) },
      ),
    /** `PUT`: the body is the whole permutation, not a move — see the route's note. */
    reorderSlides: <T>(deckId: string, body: unknown) =>
      request<T>(`/api/decks/${encodeURIComponent(deckId)}/slides/order`, {
        method: "PUT", body: json(body),
      }),
  },

  /** Asset bytes by id — an `<img src>`, not a fetch. Built here so the URL shape has one owner. */
  assetUrl: (assetId: string): string => `/api/assets/${encodeURIComponent(assetId)}`,

  /** Export download URL — a navigation, so the browser handles `content-disposition` itself. */
  exportUrl: (deckId: string, format = "pptx"): string =>
    `/api/decks/${encodeURIComponent(deckId)}/export/${encodeURIComponent(format)}`,
};

/* ─────────────────────────────── SSE ─────────────────────────────── */

/**
 * Generation's streaming POST — §12's SINGLE choke point for parsing SSE.
 *
 * `fetch` + a manual parser rather than `EventSource`, for two reasons that are requirements rather than
 * preferences: `EventSource` cannot issue a POST (generation needs a body), and it cannot be aborted
 * deterministically, which §9's "client abort mid-generation" row requires.
 *
 * ## Tolerance rules, all from §12
 *
 *  - **Unknown event types are skipped**, via `isStreamEvent` — the same predicate the server's own union
 *    exports, so adding an event variant is backward-compatible by construction rather than by convention.
 *  - **Malformed frames never throw.** A frame whose `data:` is not JSON is dropped and counted; one bad
 *    frame mid-stream must not lose the 40 good ones after it.
 *  - A frame split across two network chunks is held in `buffer` until its blank-line terminator arrives,
 *    which is the bug this kind of parser always has when written per-call-site instead of once.
 *
 * `onEvent` is called for every recognized event including `ping`; callers ignore what they don't need.
 * Resolves when the stream ends normally — a `fatal` event is data, not an exception, because the caller
 * has usually already rendered several successful slides by then and throwing would discard that context.
 */
export async function streamGeneration(
  deckId: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  // A pre-stream failure (bad body, unknown deck, auth) is a normal JSON error response, so it goes through
  // the same envelope path as every other call rather than being reported as an empty stream.
  if (!response.ok || response.body === null) {
    const text = await response.text();
    const parsed: unknown = text === "" ? undefined : safeJson(text);
    throw isErrorBody(parsed)
      ? new ApiError(parsed, response.status)
      : new ApiError(
        { code: "Internal", message: `Generation could not start (${response.status}).`, retryable: true },
        response.status,
      );
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      // Frames are separated by a blank line. Split on the last complete separator and keep the remainder:
      // the tail is very often a partial frame, and parsing it early is how events get silently dropped.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) dispatch(frame, onEvent);
    }
    // A stream that ends without a trailing blank line still has one real frame left in the buffer.
    if (buffer.trim() !== "") dispatch(buffer, onEvent);
  } finally {
    // Releasing the lock lets an aborted response be collected promptly; without it a cancelled generation
    // holds the connection until GC.
    reader.releaseLock();
  }
}

/**
 * One SSE frame → at most one event.
 *
 * Only `data:` lines are read. The server mirrors the type into the SSE `event:` field for clients that
 * prefer `addEventListener`, but the JSON payload carries `type` too, so trusting the payload keeps ONE
 * source of truth — and a frame whose `event:` and `data.type` disagreed would otherwise be ambiguous.
 */
function dispatch(frame: string, onEvent: (event: StreamEvent) => void): void {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    // Per the SSE spec, exactly one optional leading space after the colon is stripped; multi-line `data:`
    // fields are joined with a newline.
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");

  if (data === "") return;                    // a comment/keep-alive frame carries no data line

  const parsed = safeJson(data);
  if (parsed === undefined) return;      // malformed JSON: skip, never throw (§12)
  if (!isStreamEvent(parsed)) return;    // unknown type: skip (§12)
  onEvent(parsed);
}
