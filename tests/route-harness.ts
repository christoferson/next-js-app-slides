/**
 * Harness for the §2 step-15 route suites.
 *
 * ## What these tests are for, and what they deliberately are not
 *
 * The service suites already prove the behaviour. What is untested until now is the HTTP EDGE: the status
 * code, the response envelope, the params-are-a-Promise contract, and — the one that actually protects
 * something — that an error response carries the taxonomy's readable text and NONE of `AppError.detail`.
 * §6.3 asks for exactly this: "integration tests against the memory backend selected via a
 * `STORAGE_BACKEND`-style factory wiring", which is what proves a backend swap needs no route change.
 *
 * So a route test asserts what only the route decides. It does not re-assert that a brand's colours are
 * validated (the brand suite's job) or that a slide's budgets are enforced (the deck suite's) — that
 * duplication is how a route suite ends up the slowest and least useful file in the repo.
 *
 * ## Why the route handlers are imported directly
 *
 * There is no HTTP server here. A Next route handler IS a function from `Request` to `Response`, and
 * calling it directly exercises everything this layer owns while making the whole suite synchronous and
 * millisecond-fast. What it does NOT exercise is Next's own routing — which segment wins between
 * `slides/order` and `slides/[slideId]`, whether `runtime = "nodejs"` is honoured. That gap is real and
 * covered instead by `tests/architecture.test.ts` (file layout) plus the §11 smoke script (a live server).
 *
 * ## The singleton is the test's container
 *
 * Routes call `getFacade()`, which reaches the module singleton — so `install()` puts the harness's
 * memory-backed, scripted-model container there and `afterEach` clears it. Without that a generation
 * route would construct a real Bedrock client (§1.3).
 */

import { afterEach } from "vitest";
import { resetContainer } from "@/lib/container";
import type { AppConfig } from "@/lib/config";
import { type Harness, harness } from "@/tests/service-harness";

/** Anything to be JSON-encoded as a request body. `undefined` sends no body at all. */
type Body = unknown;

export interface RouteHarness extends Harness {
  /** `{ params }` for a route that takes path segments, with the Promise Next 16 actually passes. */
  ctx: <T extends Record<string, string>>(params: T) => { params: Promise<T> };
}

/**
 * Build a memory-backed container and INSTALL it as the singleton the routes will reach.
 *
 * Registered `afterEach` here rather than in each suite: forgetting the reset leaks one test's data into
 * the next through a module-level singleton, and the failure surfaces as an unrelated test's assertion —
 * the worst kind to debug.
 */
export function routeHarness(config: Partial<AppConfig> = {}): RouteHarness {
  const h = harness(config);
  resetContainer(h.container);
  return {
    ...h,
    ctx: (params) => ({ params: Promise.resolve(params) }),
  };
}

afterEach(() => resetContainer());

/* ─────────────────────────────── requests ─────────────────────────────── */

/**
 * A `Request` with a JSON body.
 *
 * The URL is a placeholder: route handlers under test read path segments from `ctx.params` (Next's
 * router provides them), never by parsing `request.url`. Anything that DID parse the URL would be
 * silently broken here, which is a reason to keep that out of routes rather than to build a realistic URL.
 */
export function req(method: string, body?: Body, init: RequestInit = {}): Request {
  return new Request("http://test.local/api", {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
    ...init,
  });
}

/** A `Request` with a raw (possibly malformed) body — for the "not valid JSON" cases. */
export function rawReq(method: string, body: string): Request {
  return new Request("http://test.local/api", {
    method,
    body,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A multipart `Request` for the upload route.
 *
 * `Content-Length` is NOT set: `fetch`'s own `FormData` encoder leaves it to the runtime, and
 * `readUpload`'s header check is therefore exercised separately with an explicit header (see the upload
 * suite). Sending a wrong one here would make every upload test depend on the encoder's exact overhead.
 */
export function uploadReq(
  file: { bytes: Uint8Array; filename: string; type: string },
  fields: Record<string, string> = {},
): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append(
    "file",
    new File([file.bytes as unknown as BlobPart], file.filename, { type: file.type }),
  );
  return new Request("http://test.local/api", { method: "POST", body: form });
}

/* ─────────────────────────────── responses ─────────────────────────────── */

/** Status + parsed JSON body, since almost every assertion wants both. */
export async function readBody<T = Record<string, unknown>>(
  response: Response,
): Promise<{ status: number; body: T }> {
  return { status: response.status, body: (await response.json()) as T };
}

export interface ErrorBody {
  code: string;
  message: string;
  issues?: string[];
  retryable?: boolean;
}

/**
 * Assert-and-return an error response.
 *
 * Returns the body rather than asserting inside, so a caller can then check the *absence* of leaked
 * detail — which is the assertion these suites exist for and one that has to name the specific id that
 * must not appear.
 */
export async function readError(response: Response): Promise<{ status: number; body: ErrorBody }> {
  return readBody<ErrorBody>(response);
}

/** The whole SSE body as decoded text — the generate route's response is a stream. */
export async function readStream(response: Response): Promise<string> {
  return await new Response(response.body).text();
}

/**
 * SSE text → the parsed `data:` payloads, in order.
 *
 * Deliberately a hand-rolled split rather than a reuse of the client parser: this suite's job is to prove
 * the frames on the wire are well-formed, and parsing them with the same code that produced them would
 * make a framing bug invisible.
 */
export function sseEvents(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

/* ─────────────────────────────── fixtures ─────────────────────────────── */

/**
 * A real, minimal PNG — 1×1, and valid enough for `sniffAssetType` AND `imageSize`.
 *
 * A truncated 4-byte header (what the service suites use) would pass the sniff and return `null`
 * dimensions, so the letterbox assertions could not distinguish "no dimensions read" from "dimensions
 * read and square". Base64 of a real file, so the IHDR width/height are genuinely 1×1.
 */
export const PNG_1x1 = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
), (c) => c.charCodeAt(0));

/** A wide PNG (16×9 in pixels — the aspect matters, not the size), for the letterbox-free path. */
export function pngOfSize(width: number, height: number): Uint8Array {
  const png = new Uint8Array(PNG_1x1);
  // IHDR payload starts at byte 16: width and height are big-endian uint32s. Patched rather than
  // re-encoded because `imageSize` reads exactly these eight bytes and nothing downstream in these
  // suites decodes the pixels — the PPTX exporter's own fixtures use real images.
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return png;
}
