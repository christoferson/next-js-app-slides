# SPEC.md — On-Brand Deck Studio (Single Next.js, Config-Based Brands, Bedrock)

## 1. Overview

A single **Next.js (TypeScript)** application that generates **on-brand presentation decks**. Two areas:

1. **Brand management** — screens to create, view, and modify **Brand Definitions**: persisted configs holding colors, fonts, logo, tone, and **per-layout template backgrounds** (uploaded 16:9 images for title page, section divider, two-column, etc.) with **slot zones** (config-defined coordinate boxes where generated content is placed). Configs are fully viewable/editable, with raw JSON export/import.
2. **Deck generation** — a **multi-step wizard**: select Brand → **Briefing** → AI-generated, user-edited **Outline** (one-slide-one-message) → **Generate** per-slide with streaming → **deck workspace** (edit, regenerate-with-instruction, reorder, **PPTX export**).

Two defining architectural stances:

**A. Message/visual separation (spec-driven presentations).** The LLM (Bedrock) generates content only — structured JSON filling layout slot schemas. It never sees colors, fonts, images, or coordinates. The Brand Definition + Layout Registry deterministically own all visuals. Decks are on-brand **by construction**; the only brand input to generation is tone of voice. Design artifacts (briefing, outline) persist with the deck as reviewable spec docs.

**B. Pattern-driven layering with swappable infrastructure.** Strict **Facade → Service → Repository** layering, a **composition root** that selects concrete implementations by environment, and **Strategy/Chain-of-Responsibility** for every point of variation. Storage is **file system for local dev** and **DynamoDB (or file-on-EFS) for prod** — swapping backends is a new repository class + one factory case, with **zero changes** to services, facades, or routes.

Runs as one process, no external servers required locally. Local dev = `npm install` + `npm run dev`. Ships as a **single Docker image** (user deploys to ECS Fargate separately; **all infra out of scope**). **Multi-user by design, single-node by runtime** (every entity keyed by `userId`; auth stubbed behind `AuthProvider`).

Five mandates:

1. **Layering is law**: Routes (zod validate + delegate + stream) → Facade (use-case orchestration) → Services (business logic) → Repositories/Adapters (storage + SDKs). No layer skipping; enforced by lint rules.
2. **Registries are the extension mechanism**: layouts, models, fonts, tones are typed data + behavior registered as single entries. **Adding a layout or model = one registry entry; no `if (layoutId === …)` / `if (modelId === …)` at call sites.**
3. **All infrastructure behind interfaces, wired in one composition root.** File→DynamoDB, local-disk→S3, stub→Cognito are factory-case swaps.
4. **No visual vocabulary reaches the LLM.** Prompts carry slot keys/descriptions/budgets/tone/message/evidence only. Renderers and exporters consume tokens + zones + backgrounds.
5. **Defensive structured generation.** LLM output is schema-validated per layout; invalid → repair pass → fallback layout with visible reason. Per-slide failure isolation; never a crashed job or server.

Region via `AWS_REGION`; credentials via `AWS_PROFILE` locally / task role on Fargate. Bedrock clients server-only.

## 2. Goals & Non-Goals

### Goals

- **Brand Definition management (CRUD screens)**: name; colors (primary, secondary, accent, background, surface, textOnLight, textOnDark); fonts (heading/body from a curated registry with PPTX-safe mappings); logo (PNG/SVG, light/dark); tone (voice preset + traits + banned words); **templates per layout type** — optional 16:9 background image upload + editable **slot zones** (`{x,y,w,h,align,valign}` in percent, numeric inputs, pre-filled from layout registry defaults, live preview with zone outlines; no drag editor in v1). Raw **JSON view/export/import** (zod-validated). Delete blocked/warned when decks reference the brand.
- **Theme compilation**: brand → **design tokens** (derived tints/shades, type scale, **WCAG AA contrast auto-repair + notice**), pure function, computed at render/export time (brand edits re-theme decks on next open).
- **Wizard**: (1) Brand pick → (2) Briefing (audience, objective, desired outcome, topic/context, tone override, slide count 5–30, language, optional pasted source text) → (3) Outline — one LLM call producing **one-slide-one-message** slides `{question, message, evidence[], visualHint}` in sections; fully editable (add/remove/drag-reorder/edit); **regenerate outline or section with optional custom instruction**; deterministic layout auto-mapping badges, per-slide override → (4) Generate — options (speaker notes, density) → **SSE per-slide generation** (validate → repair → fallback), slides stream in live, cancellable (completed slides persist).
- **Deck workspace**: thumbnail rail + 16:9 canvas; inline slot editing with budget counters; **per-slide regenerate with optional custom instruction**; layout change with best-effort slot carry-over; reorder/duplicate/delete; speaker notes; **brand swap** (instant re-theme); persisted briefing/outline viewable read-only.
- **PPTX export (the only export)**: server-side `pptxgenjs` — background image full-bleed + text boxes at zone coordinates + brand fonts (pptxName) and colors + logo; token-styled serialization when a layout has no background. Opens correctly in PowerPoint.
- **Deck CRUD**; graceful error surfacing everywhere (Bedrock access/throttle/validation/timeout, post-repair generation failures, invalid uploads) — request-level AND in-stream.

### Non-Goals (v1 — design for, don't build)

- PPTX template upload/parsing (background-image templates only; `BrandDefinitionFactory` seam).
- Chat-driven interview flow (custom instructions on regeneration are the steering mechanism).
- Visual drag zone editor (zones are data; editor later writes the same `SlotZone[]`).
- GenAI/stock images in slides (`image` slot + `ImageProvider` seam reserved).
- HTML/PDF export (`Exporter` strategy seam only), icon sets, image→slide, MCP.
- Real auth, sharing, versioning; **DynamoDB/S3/Cognito implementations** (interfaces + factory cases designed; only file/local/stub impls built); all AWS infra (ECS/EFS/ALB/CDK).
- Doc-grounded generation (pasted text now; `SourceProvider` seam).

## 3. Architecture

```
Browser (React — wizard/workspace state; no AWS code)
  │
  │  /api/brands …                      brand CRUD + JSON import/export
  │  /api/brands/:id/assets             logo/background upload (multipart)
  │  /api/decks …                       deck CRUD
  │  /api/decks/:id/outline             POST generate {instruction?} · PATCH save edits
  │  /api/decks/:id/generate            SSE per-slide generation
  │  /api/decks/:id/slides/:sid         PATCH slots/layout/order/notes
  │  /api/decks/:id/slides/:sid/regenerate    POST {instruction?}
  │  /api/decks/:id/export/pptx         GET → .pptx
  │  /api/registry/layouts|models|fonts|tones   client-safe registries
  ▼
Route handlers (Node runtime) — zod + AuthProvider.currentUser() + Facade + SSE only
  ▼
FACADE    StudioFacade (lib/facade) — one method per use-case
  ▼
SERVICES  (lib/services — business logic; depend on INTERFACES only, constructor-injected)
  BrandService · OutlineService · LayoutMappingService · GenerationService
  DeckService · ExportService
  ▼
INTERFACES (ports)                     IMPLEMENTATIONS (v1 built / later swap)
  BrandRepository                      FileBrandRepository        → DynamoBrandRepository
  DeckRepository                       FileDeckRepository         → DynamoDeckRepository
  AssetStore                           LocalDiskAssetStore        → S3AssetStore
  AuthProvider                         StubAuthProvider           → CognitoAuthProvider
  LLMPort                              BedrockLLMAdapter (family-strategy request builders)
  Exporter                             PptxExporter               → HtmlExporter
  ▼
COMPOSITION ROOT  lib/container.ts — selects impls via STORAGE_BACKEND / ASSET_BACKEND /
                  AUTH_BACKEND env; the ONLY place concrete classes are constructed
  ▼
DATA (file backend): DATA_DIR/users/{userId}/{brands/{brandId}.json, assets/, decks/{deckId}/…}
Bedrock: outline + slide generation
```

**SSE event union** (`lib/stream/events.ts`): `deck-start | slide-start {slideId, layoutId} | slide-done {slideId, slots, notes, flags} | slide-error {slideId, reason} | deck-done {ok, failed} | error {code, message}`. Client tolerates unknown events (log + skip), never throws.

## 4. Design Patterns & Layer Contracts (core design #1)

### 4.1 Pattern map (named, placed, justified)

| Pattern | Where | Why |
|---|---|---|
| **Facade** | `StudioFacade` | One coarse method per use-case; routes never touch services; orchestration centralized |
| **Service Layer** | `lib/services/*` | One responsibility each; isolated from web + storage |
| **Repository** | `BrandRepository`, `DeckRepository` | Storage-agnostic persistence; **file (local) ⇄ DynamoDB (prod)** swap |
| **Adapter** | `BedrockLLMAdapter`, `AssetStore` impls | Wrap AWS SDKs / disk behind our ports; all AWS error mapping inside |
| **Abstract Factory + Composition Root** | `lib/container.ts` + `lib/repositories/factory.ts` | Env-driven selection of concrete impls; **the only construction site**; swap = one factory case |
| **Strategy** | `RenderMode` (templated vs token-styled), `Exporter`, model-`family` request builders | Interchangeable algorithms selected by data, not branching |
| **Chain of Responsibility** | Layout-mapping rules; generation `Validate → Repair → Fallback` pipeline | Ordered handlers; first-match / escalation semantics |
| **Template Method** | `GenerationService.generateSlide()` | Fixed pipeline (buildPrompt → invoke → validate → repair → fallback → persist) with pluggable steps |
| **Registry** | layouts, models, fonts, tones | Data-driven extension; add = one entry |
| **Observer (callbacks)** | Generation progress → SSE emitter | Decouple pipeline from transport; same events feed SSE now, queue later |

### 4.2 Layer rules (lint-enforced)

- **Routes** import facade + zod schemas + stream/error types only. No repositories, no adapters, no `@aws-sdk/*`, no `fs`, no business logic.
- **Facade** imports services only.
- **Services** import **interfaces** (`lib/ports`) + domain types; never concrete impls, never `@aws-sdk/*`/`fs`/`pptxgenjs`, never `app/`.
- **Repositories/Adapters** are the only code importing `@aws-sdk/*`, `fs`, `pptxgenjs`.
- **Components** import the typed API client + shared types only; never adapters/repos/SDKs.
- `lib/container.ts` is the **only** file that constructs concrete implementations; routes obtain the facade from it.
- Enforced via ESLint `no-restricted-imports` boundary rules — a violation fails the build.

### 4.3 Repository interfaces (designed for the DynamoDB swap — core design #2)

```ts
// lib/ports/repositories.ts — storage-agnostic: async, key-addressable,
// no fs concepts, IDs generated app-side (ULID), all access scoped by userId.
export interface BrandRepository {
  create(userId: string, brand: BrandDefinition): Promise<BrandDefinition>;
  get(userId: string, brandId: string): Promise<BrandDefinition | null>;
  list(userId: string): Promise<BrandSummary[]>;          // summaries, not full configs
  update(userId: string, brandId: string, brand: BrandDefinition): Promise<BrandDefinition>;
  delete(userId: string, brandId: string): Promise<void>;
}

export interface DeckRepository {
  create(userId: string, deck: DeckMeta): Promise<DeckMeta>;
  getMeta(userId: string, deckId: string): Promise<DeckMeta | null>;   // title, brandId, briefing, outline
  list(userId: string): Promise<DeckSummary[]>;
  updateMeta(userId: string, deckId: string, patch: Partial<DeckMeta>): Promise<DeckMeta>;
  delete(userId: string, deckId: string): Promise<void>;
  // Slides are FIRST-CLASS, individually addressable — deliberately, so a
  // DynamoDB impl stores one item per slide (PK=userId#deckId, SK=slide#order)
  // instead of one oversized deck blob (400KB item limit).
  listSlides(userId: string, deckId: string): Promise<Slide[]>;
  getSlide(userId: string, deckId: string, slideId: string): Promise<Slide | null>;
  putSlide(userId: string, deckId: string, slide: Slide): Promise<Slide>;
  deleteSlide(userId: string, deckId: string, slideId: string): Promise<void>;
  reorderSlides(userId: string, deckId: string, orderedIds: string[]): Promise<void>;
}

export interface AssetStore {
  put(userId: string, kind: AssetKind, data: Buffer, meta: AssetMeta): Promise<{ assetId: string }>;
  getStream(userId: string, assetId: string): Promise<ReadableAsset>;   // stream, not path
  resolveUrl(userId: string, assetId: string): Promise<string>;         // serving URL (local route / presigned S3)
  delete(userId: string, assetId: string): Promise<void>;
}
```

**Swap-readiness rules (acceptance-tested):**
- Every access pattern is `(userId)` or `(userId, id)` — maps directly to DynamoDB PK/SK; **no cross-user scans, no filesystem paths or sync IO in any interface**.
- `FileDeckRepository` stores slides as individual files under `decks/{deckId}/slides/` — mirroring the item-per-slide model so both impls share semantics.
- File impls use atomic writes (temp + rename) + per-file locks; path builders reject traversal (`..`) in ids.
- **EFS note**: the *file* backend runs unchanged on Fargate with `DATA_DIR` on an EFS mount — so prod can be **file-on-EFS** (zero new code) or **DynamoDB** (new repo classes + factory case). Services never know which.
- Selection: `STORAGE_BACKEND=file|dynamodb`, `ASSET_BACKEND=local|s3`, `AUTH_BACKEND=stub|cognito` — resolved once in `lib/container.ts`.

## 5. Brand Definition (config-based)

```ts
export interface SlotZone { slotKey: string; x: number; y: number; w: number; h: number;
                            align: 'left'|'center'|'right'; valign: 'top'|'middle'|'bottom'; }
export interface LayoutTemplate { backgroundAssetId?: string; zones: SlotZone[]; }

export interface BrandDefinition {
  id: string; userId: string; name: string;
  colors: { primary: string; secondary: string; accent: string; background: string;
            surface: string; textOnLight: string; textOnDark: string };
  fonts: { heading: string; body: string };            // FONTS registry ids (pptx-safe)
  logo?: { light?: string; dark?: string };            // asset ids
  tone: { voice: string; traits: string[]; bannedWords: string[] };
  templates: Record<string /* layoutId */, LayoutTemplate>;   // sparse — only customized layouts
  createdAt: string; updatedAt: string;
}
```

- Management screen = structured form + **raw JSON view/export/import** (imports zod-validated: hex colors, zones 0–100 non-degenerate, `slotKey`s exist on the layout, assets resolve).
- **Zone resolution**: brand `templates[layoutId].zones` → else layout `defaultZones`.
- Backgrounds: PNG/JPG/SVG ≤ 5MB; SVG sanitized; non-16:9 → letterbox warning in preview.
- **Live template preview**: layout rendered with sample content over the background, zone outlines toggleable; numeric edits reflect immediately.
- `compileTheme(brand): DesignTokens` — pure; tints/shades, type scale, **WCAG AA auto-repair + notice**.
- Fonts registry entries carry `pptxName` (⚠️ verify each renders in PowerPoint; flag unmapped).

## 6. Layout Registry & Rendering Strategies

```ts
export interface SlideLayout {
  id: string; displayName: string; description: string;
  intents: string[];                       // auto-mapping vocabulary
  slots: SlotSpec[];                       // {key,type,required,maxChars,maxItems,itemMaxChars,description}
  defaultZones: SlotZone[];                // seeds brand editor; fallback zones
  FallbackRenderer: React.ComponentType<{ slots: SlotValues; tokens: DesignTokens }>;
  toPptx(slide: unknown, args: { slots: SlotValues; tokens: DesignTokens;
         zones: SlotZone[]; background?: ResolvedAsset }): void;
}
```

**Seed layouts**: `title`, `agenda`, `section_divider`, `bullets` (fallback), `two_column`, `quote`, `stats`, `closing`. Every slide also carries `speakerNotes` (600 chars).

**Render-mode Strategy** (applies to canvas AND export):
- `TemplatedRender` — brand background full-bleed + slot content placed in resolved zones with tokens.
- `TokenStyledRender` — the layout's `FallbackRenderer` / token-styled `toPptx` path.
- Selected **by data** (does the brand define a template for this layout?) inside one strategy resolver — never branched at call sites.

Rules: per-layout zod compiled from `slots`; over-budget text truncated at word boundaries + `trimmed` flag/badge; renderers/exporters consume `(slots, tokens, zones, background)` only. **Adding a layout = one file + one registry line** — it then appears in the brand template editor, auto-mapping, prompting, validation, rendering, and export with zero other edits (**`git diff --stat` proof required**).

## 7. Content Generation Pipeline

### 7.1 Outline (one-slide-one-message)

```ts
interface OutlineSlide {
  question: string;         // what this slide answers for the audience
  message: string;          // the one-sentence answer
  evidence: string[];       // 0–4 supports (from sourceText when present)
  visualHint: string;       // 'opening'|'agenda'|'section'|'list'|'comparison'|'quote'|'metrics'|'closing'|'detail'
  layoutOverride?: string;
}
interface Outline { sections: { heading: string; slides: OutlineSlide[] }[]; }
```

`POST /api/decks/:id/outline { instruction?, sectionIndex? }` → one LLM call, zod-validated (count ±2, opening/closing at boundaries, one message per slide, tone fragment). Invalid → one repair pass → readable error. Outline + briefing persist as **spec docs**.

### 7.2 Layout mapping — Chain of Responsibility (no LLM)

Ordered rules, first match wins: `UserOverrideRule` → `PositionalRule` (first→`title`, last→`closing`, section heads→`section_divider`) → `IntentMatchRule` (visualHint ∈ layout.intents) → `FallbackRule` (→`bullets`). Rules are data-driven from the registry; adding a layout with new intents requires no rule changes.

### 7.3 Per-slide generation — Template Method + CoR

`generateSlide()` fixed pipeline: **buildPrompt** (briefing summary + section context + question/message/evidence + layout slot specs verbatim + tone + banned words + optional custom instruction + notes request — **zero visual vocabulary**) → **invoke** (LLMPort; family-strategy request builder) → **handle chain**: `ValidateHandler` (per-layout zod, truncate+flag) → `RepairHandler` (one pass, errors fed back) → `FallbackHandler` (`bullets` from message+evidence, `slide-error` reason; never blank) → **persist** (putSlide) → **notify** (Observer → SSE). Concurrency `GENERATION_CONCURRENCY` (default 2); abort stops remaining slides, completed persist.

### 7.4 Workspace edits

Inline slot edits (budget counters); regenerate-with-instruction (same pipeline, one slide); layout change with best-effort slot carry-over (`title→title`, `bullets→bullets`, first bullet→`body`); reorder/duplicate/delete; brand swap. All through `DeckRepository` per-slide methods.

## 8. Model Registry

`LLM_MODELS: [{ id, displayName, family, contextWindow, supportsTemperature, defaultTemperature }]`. The adapter selects a **family Strategy** (request body construction + stream decoding per family, e.g. Anthropic) — no model-id branching anywhere. Temperature UI-gated + server-clamped. Outline vs slide models independently configurable. Seed: Claude Sonnet on Bedrock — ⚠️ verify exact ID + schema in the account; **flag, don't guess**. Adding a model = one registry entry.

## 9. Frontend UX

- **Shell**: top nav **Brands | Decks**; dark chrome, light slide canvases; violet = brand, blue = content, amber = warnings (trimmed/contrast-repaired/fallback/letterboxed), red = errors.
- **Brands**: gallery (palette strip, logo, template thumbnails, usage count) → editor sections: Identity · Colors (derived-palette + contrast notices) · Fonts (specimens) · Logo · Tone · **Templates** (per-layout card: background dropzone, zone table with numeric inputs, live preview + outlines toggle, reset-to-default) · **JSON view** (copy/export/import).
- **Wizard** stepper Brand → Briefing → Outline → Generate:
  - *Outline*: draggable slide rows showing question / message / evidence chips / visualHint / layout badge (override dropdown); regenerate outline/section each with optional instruction input; count-vs-target indicator.
  - *Generate*: summary + options → grid fills live per `slide-done` (staggered animation); failed slides amber with reason + retry; auto-advance to workspace.
- **Workspace**: thumbnail rail (drag/duplicate/delete) · 16:9 canvas · right tabs **Edit** / **Notes** / **Slide** (layout switcher preview, regenerate + instruction) · header: title, brand swap, **Export PPTX**, **View spec** (read-only briefing/outline).
- Keyboard `←/→` slides, `⌘D` duplicate, `⌘E` export, `Esc` close; skeletons; no layout shift while streaming; `tabular-nums`; quality badges visible, never hidden.

## 10. Tech Stack & Runtime

- **Next.js (App Router) + TypeScript strict**; Node runtime for all API routes; single app.
- **AWS SDK v3** `@aws-sdk/client-bedrock-runtime` (server-only, streaming, pinned, verified per CLAUDE.md).
- **pptxgenjs** server-side (⚠️ gating spike: buffer export + background-image placement + zone coordinates + font mapping verified in real PowerPoint).
- **zod** (routes, brand schema, outline, per-layout slot schemas compiled from `SlotSpec[]`).
- **UI**: Tailwind + shadcn/ui + lucide-react + next-themes + `@dnd-kit`; native fetch/ReadableStream SSE.
- **Persistence v1**: file backend (atomic writes, per-file locks) + local asset store, under `DATA_DIR`. No DB server, no queue.
- **Local**: `npm install` + `npm run dev`. **Docker**: multi-stage build, Next `output: 'standalone'`, single image; `docker run -p 3000:3000 -v $(pwd)/data:/data -e DATA_DIR=/data …`. Fargate note: container FS is ephemeral — mount EFS at `DATA_DIR` (file backend unchanged) or set `STORAGE_BACKEND=dynamodb` once that impl exists. **All infra out of scope.**

## 11. Configuration

```bash
AWS_REGION=us-east-1
AWS_PROFILE=<profile>            # local; on Fargate use task role
DATA_DIR=./data
DEFAULT_USER_ID=local-user

STORAGE_BACKEND=file             # file | dynamodb   (v1 builds file only)
ASSET_BACKEND=local              # local | s3        (v1 builds local only)
AUTH_BACKEND=stub                # stub | cognito    (v1 builds stub only)

DEFAULT_LLM_MODEL_ID=<verified>  # ⚠️ verify in account
OUTLINE_MODEL_ID=                # optional override
GENERATION_CONCURRENCY=2
MAX_ASSET_MB=5
MAX_SOURCE_TEXT_CHARS=20000
```

Registries are typed code; brand definitions are user data in the configured backend.

## 12. Extensibility Seams

- **Storage/assets/auth**: `dynamodb`/`s3`/`cognito` factory cases (interfaces + env switches already in place).
- **Exporter Strategy**: `PptxExporter` now; `HtmlExporter`/`PdfExporter` later.
- **Visual zone editor**: writes the same `SlotZone[]` data.
- **PPTX template ingestion**: future `BrandDefinitionFactory` emitting a `BrandDefinition` — the config schema is the stable contract.
- **`image` slot + `ImageProvider`**; **`SourceProvider`** (doc-grounded generation); **`MetricsSink`** (no-op now).
- **Queue seam**: generation progress already flows through Observer callbacks — an SQS/worker transport can replace in-process execution without touching the pipeline.

## 13. Acceptance Criteria

- [ ] `npm install` + `npm run dev` → `localhost:3000`; `docker build`/`run -v …:/data` yields the identical app; no external servers.
- [ ] **Layering & construction discipline**: ESLint boundary rules pass; `lib/container.ts` is the only file constructing concrete impls; services depend on `lib/ports` interfaces only (verifiable by inspection + lint).
- [ ] **Swap-readiness proven**: repository/asset/auth interfaces contain no fs paths or sync IO; all access `(userId[, id])`-keyed; slides individually addressable; a mock second backend (in-memory) can be registered via one factory case and the full test suite passes against it — **demonstrating the DynamoDB/EFS swap path**.
- [ ] Brand CRUD: form + raw JSON view/export/import (invalid imports → readable zod errors); logo + per-layout background uploads; zone table edits live-update the preview with outlines; reset-to-default zones; contrast auto-repair + notice; non-16:9 letterbox warning; delete blocked/warned when referenced.
- [ ] Wizard end-to-end: outline in one-slide-one-message schema (±2 count, opening/closing boundaries); fully editable with drag-reorder; **outline/section regeneration honors custom instructions**; mapping badges (CoR rules) shown + overridable.
- [ ] Generation streams per-slide; templated layouts render brand background + zoned content, others token-styled (**strategy selected by data — no call-site branching**); double-invalid output lands as a fallback `bullets` slide with visible reason; cancel keeps completed slides.
- [ ] **No visual vocabulary in prompts** (verifiable in debug logs).
- [ ] Brand swap re-themes every slide with zero content change; brand edits re-theme on next open; over-budget text truncated + badged; no zone overflow on seed layouts.
- [ ] Workspace: inline edits persist (per-slide repo ops, atomic); regenerate-with-instruction works; layout change carries content; reorder/duplicate/delete persist; spec docs viewable.
- [ ] **PPTX opens correctly in PowerPoint**: full-bleed backgrounds, zone-positioned text, brand fonts/colors, logo; token-styled layouts serialize; 15-slide deck in reasonable time.
- [ ] **Adding a layout = one file + one registry line** (`git diff --stat` proof); adding a model = one registry entry; adding a storage backend = repo classes + one factory case, zero service/route changes.
- [ ] Bedrock errors readable request-level AND in-stream; malformed LLM output never crashes server/client; unknown SSE events logged + skipped.
- [ ] No AWS SDK / pptxgenjs in the client bundle; all data user-scoped; path traversal via crafted ids blocked.

## 14. Project Structure

```
/app
  layout.tsx  page.tsx                        # decks list
  /brands/page.tsx  /brands/[id]/page.tsx
  /wizard/[deckId]/page.tsx  /deck/[deckId]/page.tsx
  /api
    /brands/route.ts  /brands/[id]/route.ts  /brands/[id]/assets/route.ts
    /decks/route.ts   /decks/[id]/route.ts
    /decks/[id]/outline/route.ts  /decks/[id]/generate/route.ts        # SSE
    /decks/[id]/slides/[sid]/route.ts  /decks/[id]/slides/[sid]/regenerate/route.ts
    /decks/[id]/export/pptx/route.ts
    /registry/{layouts,models,fonts,tones}/route.ts
/lib
  container.ts                                # COMPOSITION ROOT (only construction site)
  /ports                                      # interfaces: repositories.ts asset-store.ts
                                              #   auth-provider.ts llm-port.ts exporter.ts
  /facade        studio-facade.ts
  /services      brand-service.ts outline-service.ts layout-mapping-service.ts
                 generation-service.ts deck-service.ts export-service.ts
  /repositories  factory.ts                   # STORAGE_BACKEND → impl
                 file/ (file-brand-repository.ts file-deck-repository.ts fs-util.ts)
                 memory/ (in-memory impls — tests + swap proof)
  /adapters      stub-auth-provider.ts local-disk-asset-store.ts
                 bedrock-llm-adapter.ts       # + /families (request/stream strategies)
  /layouts       types.ts registry.ts validate.ts render-mode.ts   # strategy resolver
    /defs        title.tsx agenda.tsx section-divider.tsx bullets.tsx two-column.tsx
                 quote.tsx stats.tsx closing.tsx
  /brand         types.ts brand-schema.ts theme.ts contrast.ts fonts.ts tones.ts
  /mapping       rules.ts                     # Chain of Responsibility
  /generation    prompts.ts pipeline.ts handlers.ts   # Template Method + CoR
  /export        pptx-exporter.ts
  /models        types.ts registry.ts
  /stream        events.ts
  /errors        errors.ts
/components      /brands /wizard /outline /deck /slides /ui
Dockerfile
.env.local.example
```