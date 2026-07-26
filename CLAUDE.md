# CLAUDE.md — Build Guide & Verification for the On-Brand Deck Studio

Operational companion to `SPEC.md`. `SPEC.md` defines *what* to build; this file defines *how, in what order, and what MUST be verified before anything depends on it*. Read `SPEC.md` first. If they conflict: `SPEC.md` wins on *what*, this file wins on *process*.

## 0. Prime Directives

1. **Never guess a Bedrock model ID, request schema, pptxgenjs capability, or font mapping.** If you cannot verify it (docs, a probe script, an actual PowerPoint open-test), **stop and flag it** with a `⚠️ VERIFY` note. Plausible-looking constants written from memory are the #1 failure mode.
2. **The two product guarantees are testable, not aspirational**:
   - *On-brand by construction* — no visual vocabulary in any LLM prompt (log-verifiable).
   - *Swap-ready infrastructure* — the full test suite passes against a second (in-memory) backend registered via one factory case (§6).
3. **Layering and construction discipline are lint-enforced.** Routes → Facade → Services → Ports → Impls. `lib/container.ts` is the ONLY file that constructs concrete implementations. A violation is a build failure, not a code-review nitpick (§5).
4. **Defensive generation.** LLM output is hostile input: validate → repair → fallback, per-slide isolation. A malformed response never crashes a job, never yields a blank slide.
5. **Server-only SDKs.** No `@aws-sdk/*`, no `pptxgenjs`, no `AWS_PROFILE` in the client bundle. Grep the built bundle to prove it.

## 1. Gating Spikes (do these FIRST — before feature code)

Record all results in `VERIFICATION.md`. Each spike gates the layers that depend on it.

### 1.1 pptxgenjs spike — THE critical one (gates layouts + export)

The entire template/zone design assumes pptxgenjs can do specific things server-side. **Prove them with a throwaway script before writing any layout's `toPptx`:**

```ts
// scripts/verify-pptx.ts — build one slide exercising every capability we depend on
import pptxgen from "pptxgenjs";

const pptx = new pptxgen();
pptx.defineLayout({ name: "16x9", width: 10, height: 5.625 });
pptx.layout = "16x9";
const slide = pptx.addSlide();

// 1. Full-bleed background image (our brand template backgrounds)
slide.addImage({ path: "./fixtures/bg-16x9.png", x: 0, y: 0, w: 10, h: 5.625 });

// 2. Text box at PERCENT-derived coordinates (our SlotZone model: x/y/w/h in %)
const zone = { x: 8, y: 12, w: 84, h: 20 };  // percent
slide.addText("Zone-positioned title — 日本語も確認", {
  x: (zone.x / 100) * 10, y: (zone.y / 100) * 5.625,
  w: (zone.w / 100) * 10, h: (zone.h / 100) * 5.625,
  align: "left", valign: "top",
  fontFace: "Georgia", fontSize: 28, color: "1A1A2E",
});

// 3. Bullets with itemized runs; 4. shrink-to-fit behavior; 5. logo image in a corner
// ✅ VERIFIED 4.0.1 — `breakLine` is MANDATORY on every item: a shape-level `align` otherwise
// collapses all runs into ONE paragraph, silently dropping every item's bullet but the first
// (VERIFICATION.md C5). `shrinkText` is deprecated in 4.0.1 → use `fit`, but note it is inert
// at export (C1): truncate in our own code.
slide.addText([{ text: "Point one", options: { bullet: true, breakLine: true } },
               { text: "Point two", options: { bullet: true, breakLine: true } }],
  { x: 0.8, y: 2.2, w: 8.4, h: 2.5, fontSize: 18, fit: "shrink" });

// 6. Server-side buffer output (no fs write required by the route)
const buf = await pptx.write({ outputType: "nodebuffer" });   // ✅ VERIFIED on 4.0.1
console.log("pptx buffer OK", (buf as Buffer).length);
```

**Then OPEN THE FILE IN REAL POWERPOINT** (and ideally Keynote/Google Slides) and verify:
- [ ] Background is truly full-bleed at 16:9 (no white margins).
- [ ] Text lands where the percent math says (compare against the browser preview of the same zone — §8).
- [ ] `align`/`valign` behave as expected; bullets render; long text doesn't silently overflow the box (note the actual overflow behavior — it drives our truncation budgets).
- [ ] Each candidate font's `pptxName` renders (not silently substituted with Calibri) — test every FONTS registry entry; **flag any that substitute**.
- [ ] `nodebuffer` output works on the pinned version (API names have shifted across pptxgenjs versions — verify, don't assume).

❌ If any capability is missing → **stop and flag**; the zone model may need adjusting before layouts are built.

> **STATUS: §1.1 PASSED** (2026-07-26) — see `VERIFICATION.md` for the 5 constraints (C1–C5) the
> exporter must be written around. Zone math is EMU-exact (0 delta). The render gate ran on
> LibreOffice, **not PowerPoint** — the "open in real PowerPoint" checkbox above and in §13 is
> **deferred, not waived**; `npm run verify:render:all` is the harness for when PowerPoint is
> available. Two notes for anyone building layouts: bullet runs must go through one shared helper
> that always sets `breakLine` (C5), and truncation is our job, not PowerPoint's (C1).

### 1.2 Bedrock spike (gates generation)

```ts
// scripts/verify-bedrock.ts
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand }
  from "@aws-sdk/client-bedrock-runtime";
// 1. Verify DEFAULT_LLM_MODEL_ID is invocable in THIS account/region.
// 2. Verify the family's exact request schema (e.g. Anthropic messages format) — ⚠️ VERIFY, don't guess.
// 3. Verify streaming chunk envelope: where the text delta lives.
// 4. Structured-output check: ask for a small JSON object matching a zod schema;
//    run it 10×; record how often it parses clean vs needs repair.  ← calibrates §7 repair loop.
// 5. Trigger AccessDenied (fake model id) + observe error shape for the adapter's mapping.
```

Record: model ID, request schema per family, stream decode path, JSON-compliance rate, error shapes. **Any unverifiable ID/schema → `⚠️ VERIFY` flagged to the user.**

### 1.3 Environment sanity

- App boots and serves `/api/registry/*` with **no** AWS credentials (registries are static data; only generation needs Bedrock).
- `sharp`/image handling (if used for letterbox detection) imports cleanly on the platform.
- Next.js `output: 'standalone'` Docker build runs (`docker build` + `docker run` smoke) — do this early, not at the end.

## 2. Build Order (bottom-up; each layer tested before the next)

1. **`lib/stream/events.ts`** — typed SSE union. The wire contract; everything streams through it.
2. **`lib/errors/errors.ts`** — taxonomy (`BrandNotFound`, `BrandInUse`, `DeckNotFound`, `InvalidBrandConfig`, `GenerationFailed`, Bedrock access/throttle/validation/timeout) + `toReadable()`.
3. **`lib/ports/*`** — ALL interfaces (repositories, asset store, auth, LLMPort, Exporter). **Write these before any implementation** — they are the swap contract.
4. **`lib/repositories/memory/*`** — in-memory impls FIRST (trivial, and they're both the test harness and the swap proof — §6).
5. **`lib/repositories/file/*`** — file impls (atomic temp+rename writes, per-file locks, per-slide files, path-traversal guards). Test against the same shared repository test suite as memory (§6).
6. **`lib/container.ts` + `repositories/factory.ts`** — composition root; env-driven selection. From here on, nothing else constructs impls.
7. **`lib/brand/*`** — `brand-schema.ts` (zod incl. zone bounds + slotKey cross-check), `theme.ts` (pure `compileTheme`), `contrast.ts` (AA check + deterministic repair — table-test known failing pairs), `fonts.ts`/`tones.ts` registries.
8. **`lib/layouts/*`** — types, `validate.ts` (SlotSpec→zod compiler — table-test budgets/truncation/flags), `render-mode.ts` (strategy resolver: brand template present → Templated, else TokenStyled), then `/defs/*` one file per layout (slots + defaultZones + FallbackRenderer + toPptx, built on the §1.1-verified API).
9. **`lib/mapping/rules.ts`** — CoR: UserOverride → Positional → IntentMatch → Fallback. Table-test each rule and precedence.
10. **`lib/models/*` + `lib/adapters/bedrock-llm-adapter.ts`** — registry + family request/stream strategies (from §1.2). All AWS error mapping here. Mock-test the adapter surface.
11. **`lib/generation/*`** — `prompts.ts` (builders — **assert no hex/font/coordinate tokens in output**, §7), `pipeline.ts` (Template Method), `handlers.ts` (Validate → Repair → Fallback CoR). Test with canned good/bad/mixed LLM responses.
12. **`lib/services/*`** — Brand, Outline, LayoutMapping, Generation, Deck, Export — each unit-tested against memory repos + mocked LLMPort.
13. **`lib/export/pptx-exporter.ts`** — assemble per-layout `toPptx` + zones + backgrounds + tokens → buffer. Manual PowerPoint open-test with a fixture deck covering every seed layout, templated AND token-styled.
14. **`lib/facade/studio-facade.ts`** — use-case orchestration.
15. **`app/api/*`** — thin routes; integration tests per endpoint (memory backend).
16. **Frontend** — typed API client + SSE parser (tolerates unknown events) → Brands screens (incl. zone table + live preview + JSON import/export) → Wizard → Workspace → polish.

**Checkpoint after 15**: full headless flow via script (§9) — create brand → upload background → create deck → outline → generate → edit slide → export PPTX → open it — before writing React.

## 3. Composition Root Discipline

- `lib/container.ts` reads `STORAGE_BACKEND` / `ASSET_BACKEND` / `AUTH_BACKEND` once, constructs impls, wires services → facade, exports a singleton accessor for routes.
- **No `new FileBrandRepository()` (or any concrete impl) anywhere else.** Grep-testable: concrete class names appear only in their own file, the factory, and tests.
- Unknown backend value → **fail fast at startup** with a readable message (never silently default in prod paths).
- Tests build their own container with memory impls — proving the container itself is swappable.

## 4. Layout Registry Rules

- A layout definition file exports ONE object: `{ id, displayName, description, intents, slots, defaultZones, FallbackRenderer, toPptx }`. The registry is an array of these.
- `defaultZones` MUST cover every required slot; add a registry-load-time invariant check (fail fast on mismatch) — this protects the brand editor seeding.
- Prompt construction, zod validation, brand-editor zone seeding, mapping intents, rendering, and export must ALL read from the registry entry — **never** from a parallel hardcoded table.

## 5. Lint-Enforced Boundaries (set up before feature code)

ESLint `no-restricted-imports` (or `eslint-plugin-boundaries`):

- `app/**` → may import `lib/container`, `lib/facade`, `lib/stream`, `lib/errors`, zod schemas, registry *types*. **Forbidden**: `lib/repositories/**`, `lib/adapters/**`, `@aws-sdk/*`, `pptxgenjs`, `fs`.
- `lib/facade/**` → `lib/services/**`, `lib/errors` only.
- `lib/services/**` → `lib/ports/**`, domain/brand/layouts/mapping/generation/models/stream/errors. **Forbidden**: concrete repos/adapters, `@aws-sdk/*`, `fs`, `pptxgenjs`, `app/**`.
- `lib/repositories/**`, `lib/adapters/**`, `lib/export/**` → the ONLY locations allowed to import `fs`, `@aws-sdk/*`, `pptxgenjs`.
- `components/**` → typed API client + `lib/stream/events` types + UI libs. **Forbidden**: everything server-side.

A boundary violation = failing build. This is how "layering holds" gets *guaranteed*, not reviewed.

## 6. Swap-Readiness Proof (core acceptance)

1. Write ONE shared repository contract test suite (`tests/repository-contract.ts`) exercising every `BrandRepository`/`DeckRepository`/`AssetStore` method: CRUD, user scoping (user A cannot read user B's entities), per-slide put/get/delete/reorder, list summaries, delete cascade.
2. Run it against **both** `memory/` and `file/` impls — same suite, both green.
3. Run the **service/facade/route integration tests against the memory backend selected via `STORAGE_BACKEND`-style factory wiring** — proving a backend swap is one factory case with zero service/route changes.
4. Interface hygiene checks: no method returns a filesystem path (assets return streams/URLs); no sync IO in any port signature; all methods `(userId[, id])`-keyed.
5. File impl specifics: concurrent `putSlide`/`updateMeta` calls don't clobber (atomic write + lock test with `Promise.all`); crafted ids (`../../etc`) rejected by the path builder.

## 7. Prove "No Visual Vocabulary in Prompts" (core acceptance)

- `prompts.ts` unit test: build outline + slide prompts from a brand with loud, greppable values (`#FF00AA`, font `Zapfino`, a zone at `x:42`) — assert the prompt string contains **none** of: any hex pattern `#[0-9a-fA-F]{3,8}`, any FONTS registry name, any coordinate/zone token, any asset id/filename. Tone `promptFragment` and banned words ARE allowed (they're content).
- Add a `DEBUG_PROMPTS=1` mode that logs final prompts — the acceptance criterion says "verifiable in debug logs"; make that real.

## 8. Zone Fidelity — Browser Preview vs PPTX Export

The user trusts the live preview; the export must match it.

- Both the React templated renderer and `toPptx` must consume the **same** zone-resolution function (`resolveZones(brand, layout)`) and the same percent→dimension math (one shared util, two consumers).
- Fixture test: a brand with deliberately asymmetric zones (e.g. title at `x:8,y:12,w:60`, off-center) → render preview screenshot + export PPTX → manually overlay/compare. Positions must visually match. Record the check in `VERIFICATION.md`.
- Letterbox path: upload a 4:3 background → preview shows the letterbox warning → export places the image without distortion (document the chosen behavior: contain vs cover).

## 9. Defensive Generation Test Matrix

Canned LLM responses through the Validate → Repair → Fallback chain:

| Canned response | Expectation |
|---|---|
| Valid slot JSON, within budgets | `slide-done`, no flags |
| Valid JSON, one field over budget | truncated at word boundary + `trimmed` flag |
| JSON wrapped in markdown fences / preamble text | extractor recovers it (build a tolerant extractor), validates |
| Missing required slot | repair pass invoked with zod errors; canned repair response succeeds → `slide-done` |
| Repair also invalid | **fallback `bullets`** populated from message+evidence + `slide-error` reason; slide never blank |
| Non-JSON garbage | same fallback path; no throw |
| Bedrock ThrottlingException mid-deck | that slide errors readable; other slides continue; `deck-done {ok, failed}` accurate |
| Client abort mid-generation | remaining slides stop; completed slides persisted |

Outline equivalents: invalid outline JSON → one repair → readable error (no crash); slide-count wildly off target → regenerate guidance surfaced.

## 10. "One-File Layout" Proof (core acceptance)

1. Add a throwaway layout `checklist` (title + ≤6 checkbox items) as **one file in `/lib/layouts/defs` + one registry array line**.
2. With zero other edits, assert it appears in: `/api/registry/layouts`; the brand editor's Templates section (with `defaultZones` seeded); mapping (give it an intent, outline a slide with that visualHint); generation (prompt built from its slots; validation from its schema); workspace layout switcher; PPTX export.
3. `git diff --stat` must show **only** the new file + one registry line. Anything else changed = the abstraction leaked; fix before shipping.

Do the same one-entry check for a model registry addition.

## 11. Manual E2E Smoke (`scripts/smoke.ts` — keep green)

```
 1. POST /api/brands                        → brandId (custom colors/fonts/tone)
 2. POST /api/brands/:id/assets (bg → title layout) → assetId; PATCH zones
 3. GET  /api/brands/:id                    → config round-trips; export JSON → re-import → identical
 4. POST /api/decks {brandId}               → deckId; PATCH briefing
 5. POST /api/decks/:id/outline             → one-message-per-slide schema; sections; ±2 count
 6. PATCH outline (edit a message, reorder, set a layoutOverride)
 7. POST /api/decks/:id/generate (SSE)      → slide-start/done per slide; deck-done {ok, failed}
 8. PATCH a slide's slots; POST regenerate {instruction:"punchier"} → changed content
 9. GET  /api/decks/:id/export/pptx         → buffer; OPEN IN POWERPOINT (manual gate)
10. Brand swap on the deck                  → re-render check; content unchanged
11. DELETE deck; DELETE brand               → brand delete blocked while referenced, allowed after
```

## 12. Frontend Verification Notes

- Zone table numeric edits reflect in the live preview **immediately** (shared render path with the canvas — same `resolveZones`).
- JSON import: invalid config → field-level readable zod errors, nothing partially applied.
- SSE parser: single choke point; unknown event types logged + skipped; malformed frames never throw.
- Regenerate-with-instruction inputs exist at outline (whole/section) and per-slide; verify the instruction demonstrably alters output.
- Amber quality badges (`trimmed`, fallback, contrast-repaired, letterboxed) are visible on affected slides/brands — never suppressed.
- Grep the production client bundle for `@aws-sdk`, `pptxgenjs`, `AWS_PROFILE` — must be absent.

## 13. Definition of Done (per feature)

- [ ] Boundary lint passes; concrete impls constructed only in container/factory (grep-verified).
- [ ] Repository contract suite green on memory AND file; integration suite green via memory backend (§6).
- [ ] No guessed Bedrock/pptxgenjs/font facts shipped — `⚠️ VERIFY` items resolved or explicitly listed.
- [ ] Prompt purity test passes (§7); generation matrix passes (§9).
- [ ] Zone fidelity check recorded (§8); export opened in real PowerPoint.
- [ ] One-file layout proof holds for any new layout (§10).
- [ ] Errors readable request-level AND in-stream; no blank slides, no crashed jobs.
- [ ] Smoke script (§11) green end-to-end.

## 14. When to Stop and Ask (don't guess)

- pptxgenjs can't do full-bleed backgrounds, zone-accurate text boxes, or buffer output on the pinned version (§1.1) — the zone model itself may need rework; surface it.
- A FONTS entry has no PowerPoint-safe `pptxName` that survives the open-test.
- Bedrock model ID/request schema unverifiable in the account, or structured-output compliance is so poor (§1.2) that the single repair pass is insufficient — propose alternatives (different model, stricter prompting) rather than silently degrading.
- Preview-vs-export zone positions diverge beyond small tolerance and the shared-math fix doesn't close it.
- Any feature would require breaking a lint boundary or constructing an impl outside the container — that's a design smell; surface it, don't punch through.