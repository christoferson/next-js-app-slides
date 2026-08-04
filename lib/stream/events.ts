/**
 * CLAUDE.md §2 step 1 — the typed SSE union. This is THE wire contract: every streaming
 * response is a sequence of these, and both the route serializer and the browser parser are
 * built from this one definition.
 *
 * Design rules baked in here:
 *  - Every event carries a literal `type`, so the client can discriminate without guessing.
 *  - Errors are ALWAYS readable (`message`), never a raw SDK string (§13: "errors readable
 *    request-level AND in-stream").
 *  - Per-slide isolation: a `slide-error` is terminal for one slide only; the deck continues
 *    and `deck-done` reports accurate {ok, failed} counts (§9).
 *  - The client parser must SKIP unknown event types rather than throw (§12), so adding a
 *    variant here is backward-compatible by construction.
 */

import { type ErrorCode, toReadable } from "@/lib/errors/errors";

/** Quality flags surfaced as amber badges (§12) — never suppressed. */
export type QualityFlag =
  | "trimmed"           // text exceeded the slot budget and was truncated at a word boundary (C1)
  | "fallback"          // slot content came from the fallback renderer, not the model
  | "contrast-repaired" // a colour pair failed AA and was deterministically adjusted
  | "letterboxed";      // a non-16:9 background was contained rather than stretched (C2)

export interface StreamEventBase {
  type: string;
  /** ms since epoch, stamped by the server when the event is emitted. */
  at: number;
}

/** Deck generation has begun; `total` lets the client render a determinate progress bar. */
export interface DeckStartEvent extends StreamEventBase {
  type: "deck-start";
  deckId: string;
  total: number;
}

export interface SlideStartEvent extends StreamEventBase {
  type: "slide-start";
  slideId: string;
  index: number;
  layoutId: string;
}

/** Incremental model text for a slide, for live preview. */
export interface SlideDeltaEvent extends StreamEventBase {
  type: "slide-delta";
  slideId: string;
  text: string;
}

export interface SlideDoneEvent extends StreamEventBase {
  type: "slide-done";
  slideId: string;
  index: number;
  flags: QualityFlag[];
}

/**
 * One slide failed. NOT terminal for the deck — generation continues (§9). `message` is
 * already user-readable; `reason` is a stable machine code for UI treatment.
 */
export interface SlideErrorEvent extends StreamEventBase {
  type: "slide-error";
  slideId: string;
  index: number;
  reason: "validation-failed" | "repair-failed" | "model-error" | "internal";
  message: string;
}

export interface DeckDoneEvent extends StreamEventBase {
  type: "deck-done";
  deckId: string;
  ok: number;
  failed: number;
}

/**
 * The whole job failed (auth, model unreachable, aborted before any slide).
 *
 * `code` and `retryable` mirror the JSON error body's fields, for the same reason `SlideErrorEvent` pairs
 * a readable `message` with a machine `reason`: without them an SSE client cannot tell a throttle worth a
 * Retry button from a `DeckNotReady` that needs the user to go back a step. Matching the JSON envelope
 * exactly is what lets one client-side error renderer serve both transports — §13's "readable
 * request-level AND in-stream" means the same information, not merely the same tone.
 *
 * `detail` is still absent, on both transports and for the same reason (`toErrorBody`'s allowlist).
 */
export interface FatalEvent extends StreamEventBase {
  type: "fatal";
  message: string;
  /** The taxonomy code — `Internal` for anything that was not an `AppError`. */
  code: ErrorCode;
  retryable: boolean;
}

/** Keep-alive so proxies don't close an idle stream during a long model call. */
export interface PingEvent extends StreamEventBase {
  type: "ping";
}

export type StreamEvent =
  | DeckStartEvent
  | SlideStartEvent
  | SlideDeltaEvent
  | SlideDoneEvent
  | SlideErrorEvent
  | DeckDoneEvent
  | FatalEvent
  | PingEvent;

export type StreamEventType = StreamEvent["type"];

/** Narrow an unknown parsed frame to a known event. Unknown types are skipped, not thrown (§12). */
const KNOWN: ReadonlySet<string> = new Set<StreamEventType>([
  "deck-start", "slide-start", "slide-delta", "slide-done",
  "slide-error", "deck-done", "fatal", "ping",
]);

export function isStreamEvent(value: unknown): value is StreamEvent {
  return (
    typeof value === "object" && value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    KNOWN.has((value as { type: string }).type)
  );
}

/**
 * Serialize one event as an SSE frame. Single choke point (§12) — the `type` is mirrored into
 * the SSE `event:` field so clients may use either addEventListener or a data-only parser.
 */
export function toSseFrame(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Turn a thrown value into the one `fatal` frame a stream may end with (§13: readable in-stream).
 *
 * **Here rather than in a service**, which is where it used to live. §5 forbids `app/**` from importing
 * `lib/services/**`, and the streaming ROUTE is a caller: a stream that dies before the facade is even
 * reached (an unauthenticated request, a malformed body) still owes the client a readable terminal frame,
 * and the route is the only layer that knows that happened. Both callers now share one implementation —
 * `lib/services/generation-service.ts` re-exports this — so the two cannot drift into telling the client
 * different stories about the same failure.
 *
 * `toReadable` is the single place any value becomes user-safe text, so a raw SDK message cannot arrive
 * here by another path.
 */
export function toFatalEvent(err: unknown, at: number): StreamEvent {
  const { code, message, retryable } = toReadable(err);
  return { type: "fatal", at, message, code, retryable };
}
