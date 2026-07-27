/**
 * Deck domain types — SPEC §7.1 (outline) and §7.4 (workspace edits).
 *
 * The key structural decision: `DeckMeta` and `Slide` are SEPARATE aggregates. A deck's meta
 * (title, brand, briefing, outline) is one record; each slide is its own record. That mirrors
 * the DynamoDB item-per-slide model (PK=userId#deckId, SK=slide#order) and keeps any single
 * record far below the 400 KB item limit — see `lib/ports/repositories.ts`.
 */

import type { QualityFlag } from "@/lib/stream/events";
import type { SlotValues } from "@/lib/domain/slots";

/** Mapping vocabulary produced by the outline and consumed by the CoR rules (SPEC §7.2). */
export type VisualHint =
  | "opening"
  | "agenda"
  | "section"
  | "list"
  | "comparison"
  | "quote"
  | "metrics"
  | "closing"
  | "detail";

/** One slide's *intent*, decided before any content is generated (SPEC §7.1). */
export interface OutlineSlide {
  /** What this slide answers for the audience. */
  question: string;
  /** The one-sentence answer — "one slide, one message". */
  message: string;
  /** 0–4 supports, drawn from `sourceText` when present. */
  evidence: string[];
  visualHint: VisualHint;
  /** Set by the user in the outline editor; `UserOverrideRule` honours it first (SPEC §7.2). */
  layoutOverride?: string;
}

export interface OutlineSection {
  heading: string;
  slides: OutlineSlide[];
}

export interface Outline {
  sections: OutlineSection[];
}

/** The user's input to generation. Persisted as a spec doc alongside the outline. */
export interface Briefing {
  topic: string;
  audience: string;
  objective: string;
  /** Target slide count; the outline is validated to within ±2 (SPEC §7.1). */
  targetSlideCount: number;
  /** Optional grounding text, capped by `MAX_SOURCE_TEXT_CHARS`. */
  sourceText?: string;
}

export interface DeckMeta {
  id: string;
  userId: string;
  title: string;
  /** Swappable at any time; re-themes every slide with zero content change (SPEC §13). */
  brandId: string;
  briefing?: Briefing;
  outline?: Outline;
  createdAt: string;
  updatedAt: string;
}

/**
 * Why a slide's content is not what the model produced. Mirrors `SlideErrorEvent.reason` so a
 * persisted slide and the stream event that announced it tell the same story.
 */
export type SlideIssueReason = "validation-failed" | "repair-failed" | "model-error" | "internal";

export interface SlideIssue {
  reason: SlideIssueReason;
  /** Already user-readable (§13) — never a raw SDK string. */
  message: string;
}

export interface Slide {
  id: string;
  /** 0-based position. `reorderSlides` is the only thing that may rewrite it. */
  order: number;
  layoutId: string;
  slots: SlotValues;
  /** ≤600 chars (SPEC §6). */
  speakerNotes?: string;
  /** The outline entry this slide was generated from — kept so regeneration has its intent. */
  source?: OutlineSlide;
  /** Amber badges in the UI (§12) — never suppressed. */
  flags: QualityFlag[];
  /** Present when the slide fell back rather than generating cleanly. */
  issue?: SlideIssue;
  createdAt: string;
  updatedAt: string;
}

/** Deck list row — no slides, no outline; counts only. */
export interface DeckSummary {
  id: string;
  title: string;
  brandId: string;
  slideCount: number;
  createdAt: string;
  updatedAt: string;
}
