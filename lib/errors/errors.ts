/**
 * CLAUDE.md §2 step 2 — the error taxonomy + `toReadable()`.
 *
 * Two hard rules this file exists to enforce:
 *  1. Every error surfaced to a user is READABLE (§13) — never a raw AWS/fs message. §1.2
 *     measured the real Bedrock messages (e.g. "Invocation of model ID … with on-demand
 *     throughput isn't supported") and they are useless to an end user.
 *  2. Only the adapters know about SDK errors. They translate into these types at the boundary,
 *     so services/routes never branch on an SDK error name.
 */

export type ErrorCode =
  // domain
  | "BrandNotFound"
  | "BrandInUse"
  | "DeckNotFound"
  | "SlideNotFound"
  | "InvalidBrandConfig"
  | "InvalidSlideOrder"
  | "InvalidSlideContent"
  | "UnknownLayout"
  | "AssetNotFound"
  | "DeckNotReady"
  | "UnknownExportFormat"
  // generation
  | "GenerationFailed"
  // model/adapter (mapped from Bedrock — shapes verified in §1.2)
  | "ModelAccessDenied"
  | "ModelThrottled"
  | "ModelInvalidRequest"
  | "ModelUnavailable"
  | "ModelTimeout"
  // generic
  | "Unauthorized"
  | "Internal";

/** HTTP status per code — routes map this directly, so status choice stays in one place. */
const STATUS: Record<ErrorCode, number> = {
  BrandNotFound: 404,
  BrandInUse: 409,
  DeckNotFound: 404,
  SlideNotFound: 404,
  InvalidBrandConfig: 400,
  InvalidSlideOrder: 400,
  InvalidSlideContent: 400,
  UnknownLayout: 400,
  AssetNotFound: 404,
  DeckNotReady: 409,
  UnknownExportFormat: 400,
  GenerationFailed: 502,
  ModelAccessDenied: 502,
  ModelThrottled: 503,
  ModelInvalidRequest: 500,
  ModelUnavailable: 502,
  ModelTimeout: 504,
  Unauthorized: 401,
  Internal: 500,
};

/** Whether retrying the same request could plausibly succeed — drives client retry affordances. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "ModelThrottled", "ModelUnavailable", "ModelTimeout",
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  /** Safe to show a user. Never contains SDK text, ids, or paths. */
  readonly readable: string;
  /** Extra context for logs only — never serialized to a client. */
  readonly detail?: unknown;

  constructor(code: ErrorCode, readable: string, options?: { detail?: unknown; cause?: unknown }) {
    // `message` keeps the readable text so stack traces stay useful; `detail` holds the rest.
    super(readable, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = code;
    this.code = code;
    this.readable = readable;
    this.detail = options?.detail;
  }

  get status(): number { return STATUS[this.code]; }
  get retryable(): boolean { return RETRYABLE.has(this.code); }
}

/* ── Constructors: one per code, so call sites can't invent inconsistent wording. ── */

export const BrandNotFound = (id: string) =>
  new AppError("BrandNotFound", "That brand no longer exists.", { detail: { id } });

export const BrandInUse = (id: string, deckCount: number) =>
  new AppError("BrandInUse",
    `This brand is still used by ${deckCount} deck${deckCount === 1 ? "" : "s"}. Delete or reassign them first.`,
    { detail: { id, deckCount } });

export const DeckNotFound = (id: string) =>
  new AppError("DeckNotFound", "That deck no longer exists.", { detail: { id } });

export const SlideNotFound = (id: string) =>
  new AppError("SlideNotFound", "That slide no longer exists.", { detail: { id } });

export const InvalidBrandConfig = (issues: string[]) =>
  new AppError("InvalidBrandConfig", "This brand configuration isn't valid.", { detail: { issues } });

/**
 * A reorder request that doesn't describe a valid permutation (duplicate, unknown, or missing
 * slide ids). Distinct from `SlideNotFound`: nothing is missing from storage — the REQUEST is
 * malformed, and a partial apply would leave duplicate `order` values behind.
 */
export const InvalidSlideOrder = (reason: string, detail?: unknown) =>
  new AppError("InvalidSlideOrder", "That slide order couldn't be applied. Please reload and try again.",
    { detail: { reason, ...(detail && typeof detail === "object" ? detail : { detail }) } });

/**
 * A user's own slide edit that breaks a slot's budget (SPEC §7.4's inline editor).
 *
 * Deliberately NOT the same as the generation path's response to an over-long value. A model's output
 * is truncated and flagged (§1.1/C1 — truncation is our only overflow guard), because the alternative
 * is spending a repair call on cosmetics. A *person's* typing is rejected with the offending field
 * named, because silently rewriting what someone wrote is worse than telling them it does not fit —
 * and the editor already shows a live counter, so this is the backstop, not the first signal.
 *
 * `issues` are field-level so the editor can highlight the slot (§12).
 */
export const InvalidSlideContent = (issues: string[]) =>
  new AppError("InvalidSlideContent", "That slide content doesn't fit the layout.", { detail: { issues } });

/**
 * A layoutId that is not in the registry, arriving from a request body or URL.
 *
 * Distinct from `requireLayout`'s throw, which is an internal invariant failure (a persisted slide
 * naming a layout that was removed) and correctly surfaces as a 500. This one is the user's input being
 * wrong, so it is a 400 — conflating them would either hide our own bug or blame the user for it.
 */
export const UnknownLayout = (layoutId: string, known: readonly string[]) =>
  new AppError("UnknownLayout", "That slide layout isn't available.", { detail: { layoutId, known } });

export const AssetNotFound = (id: string) =>
  new AppError("AssetNotFound", "A referenced image is missing.", { detail: { id } });

/**
 * A step was attempted before its prerequisite: generate slides with no outline, export with no slides,
 * generate an outline with no briefing.
 *
 * **Not `GenerationFailed`.** That code is a 502 and means *the AI failed us*; this means the request
 * arrived out of order, and nothing upstream was even called. Conflating them would put "fill in the
 * briefing" behind a Bad Gateway with `retryable: false`, telling the user to wait for a service that is
 * working fine.
 *
 * 409 rather than 400: the request is well-formed, the deck's *state* is what does not permit it — and
 * the fix is an action on the deck, not a correction to the request. `readable` names that action,
 * because "which of the three wizard steps" is the entire useful content of the error.
 */
export const DeckNotReady = (readable: string, detail?: unknown) =>
  new AppError("DeckNotReady", readable, { detail });

/**
 * A format segment naming an exporter this deployment doesn't have. The available list is in the
 * readable text: a download URL is typed or bookmarked, and "pptx isn't available, try html" is
 * actionable where "unsupported format" is not.
 */
export const UnknownExportFormat = (format: string, available: readonly string[]) =>
  new AppError("UnknownExportFormat",
    available.length > 0
      ? `That export format isn't available. You can export as: ${available.join(", ")}.`
      : "Exporting isn't available in this deployment.",
    { detail: { format, available } });

/** The AI genuinely failed — see `DeckNotReady` for the precondition case this must not absorb. */
export const GenerationFailed = (readable: string, detail?: unknown) =>
  new AppError("GenerationFailed", readable, { detail });

export const Unauthorized = () =>
  new AppError("Unauthorized", "Please sign in to continue.");

export const Internal = (cause?: unknown) =>
  new AppError("Internal", "Something went wrong on our side. Please try again.", { cause });

/* ── Model errors: readable text chosen for END USERS, per §1.2's measured shapes. ── */

export const ModelAccessDenied = (modelId: string, cause?: unknown) =>
  new AppError("ModelAccessDenied",
    "The AI model isn't available to this deployment. An administrator needs to enable access.",
    { detail: { modelId }, cause });

export const ModelThrottled = (cause?: unknown) =>
  new AppError("ModelThrottled",
    "The AI service is busy right now. Please try again in a moment.", { cause });

export const ModelInvalidRequest = (detail?: unknown, cause?: unknown) =>
  // Our bug, not the user's — §1.2 showed these are malformed-body / wrong-model-id cases.
  new AppError("ModelInvalidRequest",
    "We couldn't complete that AI request due to a configuration problem.", { detail, cause });

export const ModelUnavailable = (modelId: string, cause?: unknown) =>
  new AppError("ModelUnavailable",
    "The configured AI model isn't available in this region.", { detail: { modelId }, cause });

export const ModelTimeout = (cause?: unknown) =>
  new AppError("ModelTimeout", "The AI service took too long to respond. Please try again.", { cause });

/**
 * The single place any thrown value becomes user-safe text. Anything unrecognized collapses to
 * a generic Internal message — an unexpected error must never leak its raw text (§13).
 */
export function toReadable(err: unknown): { code: ErrorCode; message: string; status: number; retryable: boolean } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.readable, status: err.status, retryable: err.retryable };
  }
  const internal = Internal(err);
  return { code: internal.code, message: internal.readable, status: internal.status, retryable: false };
}

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;
