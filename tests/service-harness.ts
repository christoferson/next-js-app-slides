/**
 * Shared harness for the §2 step-12 service suites.
 *
 * ## Why every service test goes through `createContainer`
 *
 * §6.3 asks for the integration tests to run "against the memory backend selected via
 * `STORAGE_BACKEND`-style factory wiring" — not against hand-wired services. The difference is the
 * whole point of the requirement: a test that does `new OutlineService({ decks: new DeckService(...) })`
 * proves the service works, but proves nothing about the composition root, and it would stay green if
 * `lib/container.ts` wired `config.outlineModelId` into the wrong field. Building the graph the way
 * production builds it means the wiring is under test too.
 *
 * It also keeps the tests honest about §1.3: the LLM port arrives as a `PortOverrides.llm`, so nothing
 * here can accidentally construct a Bedrock client, and the suites need no AWS at all.
 *
 * ## The clock is mutable, not fixed
 *
 * `now` is a counter with an explicit `tick()`. A frozen clock cannot distinguish "this write updated
 * `updatedAt`" from "this write did nothing", which is exactly what the brand-swap and slide-edit
 * assertions turn on. Advancing it deliberately — rather than using real time — keeps those assertions
 * exact instead of flaky.
 */

import type { Container, Services } from "@/lib/container";
import type { AppConfig } from "@/lib/config";
import type { LLMPort, LlmRequest, LlmResponse, LlmTextDelta } from "@/lib/ports/llm-port";
import type { Outline, VisualHint } from "@/lib/domain/deck";
import type { SlideLayout } from "@/lib/layouts/types";
import type { StreamEvent } from "@/lib/stream/events";
import type { BrandInput } from "@/lib/brand/brand-schema";
import { createContainer } from "@/lib/container";
import { DEFAULT_MODEL_ID } from "@/lib/models/registry";
import { AT } from "@/tests/fixtures";

/* ─────────────────────────────── the scripted model ─────────────────────────────── */

/**
 * One scripted model call. `throwsAfter` yields its text and *then* throws — the only honest way to
 * reproduce a throttle that lands mid-response, which the handler chain treats differently from one
 * that lands before any text (see `tests/generation-matrix.test.ts`).
 */
export type Script =
  | { text: string }
  | { throws: unknown }
  | { text: string; throwsAfter: unknown };

export interface ScriptedLlm {
  port: LLMPort;
  /** Every request the services actually made, in order — so "which model id" is assertable. */
  calls: LlmRequest[];
  /** Queue more steps. Appended rather than fixed at construction so a test can arrange, then act. */
  push: (...steps: Script[]) => void;
  remaining: () => number;
}

/**
 * A queue-backed `LLMPort`.
 *
 * An unscripted call THROWS with a count rather than returning empty text. A silent empty response
 * would be interpreted by the handler chain as a validation failure and quietly become a fallback
 * slide — so a test that under-scripted would still pass, asserting the wrong thing.
 */
export function scriptedLlm(initial: readonly Script[] = []): ScriptedLlm {
  const queue: Script[] = [...initial];
  const calls: LlmRequest[] = [];
  let served = 0;

  const next = (request: LlmRequest): Script => {
    calls.push(request);
    const step = queue.shift();
    served += 1;
    if (step === undefined) {
      throw new Error(`scriptedLlm: call ${served} was not scripted (${calls.length} calls made)`);
    }
    return step;
  };

  return {
    calls,
    push: (...steps) => { queue.push(...steps); },
    remaining: () => queue.length,
    port: {
      async complete(request): Promise<LlmResponse> {
        const step = next(request);
        if ("throws" in step) throw step.throws;
        if ("throwsAfter" in step) throw step.throwsAfter;
        return { text: step.text };
      },
      stream(request): AsyncIterable<LlmTextDelta> {
        const step = next(request);
        return {
          async *[Symbol.asyncIterator]() {
            if ("throws" in step) throw step.throws;
            for (const chunk of chunks(step.text)) yield { text: chunk };
            if ("throwsAfter" in step) throw step.throwsAfter;
          },
        };
      },
    },
  };
}

const chunks = (text: string, size = 24): string[] =>
  text === "" ? [] : Array.from({ length: Math.ceil(text.length / size) },
    (_, i) => text.slice(i * size, (i + 1) * size));

/* ─────────────────────────────── the harness ─────────────────────────────── */

export interface Clock {
  now: () => number;
  /** Advance and return the new ISO stamp — what the next write will record. */
  tick: (ms?: number) => string;
  iso: () => string;
}

export interface Harness {
  container: Container;
  services: Services;
  userId: string;
  clock: Clock;
  llm: ScriptedLlm;
  /** Sequential, greppable ids: `id-1`, `id-2`. Order of allocation is therefore assertable. */
  ids: () => readonly string[];
}

/**
 * Build a container over the memory backend with a scripted model.
 *
 * `generationConcurrency: 1` by default, and that default matters: with 2 workers the scripted queue
 * is consumed in completion order, so a per-slide script becomes nondeterministic. A test that wants
 * to exercise concurrency raises it and scripts responses that are valid for every layout.
 */
export function harness(config: Partial<AppConfig> = {}): Harness {
  let millis = Date.parse(AT);
  const clock: Clock = {
    now: () => millis,
    tick: (ms = 1_000) => { millis += ms; return new Date(millis).toISOString(); },
    iso: () => new Date(millis).toISOString(),
  };

  const minted: string[] = [];
  const newId = (): string => {
    const id = `id-${minted.length + 1}`;
    minted.push(id);
    return id;
  };

  const llm = scriptedLlm();
  const container = createContainer(
    {
      storageBackend: "memory",
      assetBackend: "memory",
      defaultLlmModelId: DEFAULT_MODEL_ID,
      outlineModelId: DEFAULT_MODEL_ID,
      generationConcurrency: 1,
      // Explicit rather than inherited: a developer with DEBUG_PROMPTS=1 exported would otherwise get
      // every prompt printed through these suites.
      debugPrompts: false,
      ...config,
    },
    { llm: llm.port, now: clock.now, newId },
  );

  return {
    container,
    services: container.services,
    userId: "user-a",
    clock,
    llm,
    ids: () => minted,
  };
}

/* ─────────────────────────────── fixtures ─────────────────────────────── */

/**
 * The editable surface only. `makeBrand` in `tests/fixtures.ts` builds a full `BrandDefinition` —
 * correct for repository tests, wrong here: `brandInputSchema` is a `strictObject`, so passing a
 * persisted brand to `BrandService.create` fails on `id`/`userId`/timestamps. That failure is the
 * service doing its job, and it is asserted directly in the brand suite.
 */
export function brandInput(overrides: Partial<BrandInput> = {}): Record<string, unknown> {
  return {
    name: "Loud Brand",
    colors: {
      primary: "#FF00AA",
      secondary: "#00FFAA",
      accent: "#AA00FF",
      background: "#0B0B14",
      surface: "#1A1A2E",
      textOnLight: "#111111",
      textOnDark: "#FAFAFA",
    },
    fonts: { heading: "georgia", body: "georgia" },
    // `voice` is a TONES id, not free text (`brandToneSchema`) — "wry" would be rejected. The loud
    // values that the §7 purity test greps for live in `colors`, which has no closed vocabulary.
    tone: { voice: "executive", traits: ["direct"], bannedWords: ["synergy"] },
    templates: {},
    ...overrides,
  };
}

/** An outline of one section, one slide per hint. Section headings drive `sectionHeading` on jobs. */
export function outlineOf(hints: readonly VisualHint[], heading = "Where we are"): Outline {
  return {
    sections: [{
      heading,
      slides: hints.map((visualHint, i) => ({
        question: `What does point ${i + 1} answer?`,
        message: `Message ${i + 1} states the claim.`,
        evidence: [`Evidence ${i + 1}`],
        visualHint,
      })),
    }],
  };
}

/**
 * A clean model response for an ARBITRARY layout, derived from its own `SlotSpec`s.
 *
 * Derived rather than written out because the mapping chain decides which layout each slide gets: a
 * 3-slide deck is `title` → `bullets` → `closing`, so three hand-written `bullets` fixtures would
 * produce two fallbacks and the counts would read as a bug in the service. §4 also wants it this way —
 * a new layout needs no edit here, and a budget change cannot leave a stale fixture behind.
 */
export function slideResponseFor(layout: SlideLayout, label = "Value"): string {
  return JSON.stringify({
    slots: Object.fromEntries(layout.slots.filter((s) => s.required).map((spec) => [
      spec.key,
      spec.type === "list"
        ? Array.from({ length: Math.min(2, spec.maxItems ?? 2) },
          (_, i) => cut(`${label} item ${i + 1}`, spec.itemMaxChars ?? spec.maxChars))
        : cut(`${label} for ${spec.key}`, spec.maxChars),
    ])),
  });
}

/** Hard cut, not word-boundary: a fixture must be inside budget by construction, not by luck. */
const cut = (text: string, maxChars: number): string => text.slice(0, maxChars);

/** Collects SSE events so ordering and "exactly one terminal event per slide" stay assertable. */
export function recorder(): { emit: (event: StreamEvent) => void; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  return { events, emit: (event) => { events.push(event); } };
}

export const typesOf = (events: readonly StreamEvent[]): string[] => events.map((e) => e.type);
