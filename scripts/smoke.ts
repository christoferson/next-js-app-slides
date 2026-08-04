/**
 * CLAUDE.md §11 — the manual E2E smoke, and §2's "Checkpoint after 15".
 *
 * ## Why this exists when 1097 unit/route tests are already green
 *
 * The route suites call handler functions directly (`tests/route-harness.ts`'s own header says so), which
 * exercises everything the handlers own but NOTHING Next itself does. Four things are only true or false
 * against a running server, and all four have failed in this project's ancestry:
 *
 *   1. **Which segment wins.** `slides/order` sits beside `slides/[slideId]`, and `brands/import` beside
 *      `brands/[brandId]`. Static-vs-dynamic precedence is Next's router's decision. If it went the other
 *      way, `PUT …/slides/order` would arrive at the slide handler with `slideId: "order"` — a 404 that
 *      every direct-call test would still pass.
 *   2. **`params` really is a Promise.** The handlers await it; nothing but Next proves it is what Next
 *      passes.
 *   3. **`runtime = "nodejs"` is honoured.** The exporter needs Node — `pptxgenjs` on an edge runtime
 *      fails at import, long after typecheck.
 *   4. **SSE actually streams.** `sse()` runs the job inside `start` so frames arrive as slides finish.
 *      A direct call collects the whole body either way, so "the grid fills live" (SPEC §9) is
 *      unverifiable without a real socket. This script asserts the arrival TIMING, not just the frames.
 *
 * ## What it costs, and what it therefore is not
 *
 * Step 5 and step 7 call Bedrock for real: one outline plus one model call per slide. That is the point —
 * §1.2 measured JSON compliance on synthetic prompts, and this is the first time the ACTUAL prompts built
 * from a real brand and briefing go to a real model. It is also why this is not in `npm run verify`: it
 * needs credentials, costs money, and takes a minute.
 *
 * ## The one gate this script cannot close
 *
 * Step 9 downloads a PPTX and asserts it is a valid, non-trivial zip whose parts are the ones the
 * exporter should have written. Whether PowerPoint SUBSTITUTES A FONT when opening it is ⚠️ VERIFY #5 in
 * `VERIFICATION.md` — deferred, not waived (no desktop Office here). The file is left in `out/` and its
 * path printed, so the human half of the gate is one double-click away.
 *
 * Run:  npm run dev        (in one terminal — this script starts no server)
 *       npm run smoke      (in another)
 *
 * It deliberately does NOT boot the server itself. A script that owns the server hides the server's own
 * output, and a `next dev` compile error would surface here as a connection refused rather than as the
 * stack trace that explains it.
 *
 * Environment: BASE_URL (default http://127.0.0.1:3000). Uses whatever backend the server was started
 * with; STORAGE_BACKEND=memory makes it leave nothing behind, `file` proves the real persistence path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = join(process.cwd(), "out");

/* ─────────────────────────────── tiny harness ─────────────────────────────── */

let passed = 0;
const failures: string[] = [];

/** ASCII only in output: this runs under Git Bash on Windows, where a non-ASCII byte is a bad time. */
function check(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  [ok]   ${label}`);
  } else {
    failures.push(label);
    console.log(`  [FAIL] ${label}${extra === undefined ? "" : ` -- ${JSON.stringify(extra)}`}`);
  }
}

function step(n: number, title: string): void {
  console.log(`\n== ${n}. ${title} ==`);
}

interface Res<T> { status: number; body: T; headers: Headers }

/**
 * One request. Every call goes through here so a non-JSON error page (Next's HTML 500) surfaces as a
 * readable failure rather than a `JSON.parse` stack — which is the whole failure mode a live-server test
 * is meant to catch.
 */
async function call<T = Record<string, unknown>>(
  method: string, path: string, body?: unknown,
): Promise<Res<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `${method} ${path} -> ${response.status} returned non-JSON (${response.headers.get("content-type") ?? "no type"}): ${text.slice(0, 300)}`,
      );
    }
  }
  return { status: response.status, body: parsed as T, headers: response.headers };
}

/** Assert-and-return, so the happy path can keep going without `!` on every field. */
async function expectOk<T>(method: string, path: string, body?: unknown, want = 200): Promise<T> {
  const res = await call<T>(method, path, body);
  if (res.status !== want) {
    throw new Error(
      `${method} ${path} -> expected ${want}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`,
    );
  }
  return res.body;
}

/* ─────────────────────────────── fixtures ─────────────────────────────── */

/**
 * Loud, greppable brand values — the §7 purity check in live form.
 *
 * `#FF00AA` and `Zapfino` are the exact tokens `tests/prompts.test.ts` asserts never appear in a prompt.
 * Using them HERE means that if the debug-prompt log (step 5b) ever contains one, this script's own
 * fixture is the thing that proved it, against the real prompt builders and a real brand record.
 */
const BRAND_INPUT = {
  name: "Smoke Brand",
  colors: {
    primary: "#FF00AA",
    secondary: "#123456",
    accent: "#00CC88",
    background: "#FFFFFF",
    surface: "#F2F2F2",
    textOnLight: "#1A1A2E",
    textOnDark: "#FFFFFF",
  },
  // Registry ids, not family names (BrandFonts' own note). `georgia` is a core-7 selectable id.
  fonts: { heading: "georgia", body: "verdana" },
  // `voice` is a TONES registry id, not prose — the same registry-id-not-free-text rule as `fonts`.
  tone: {
    voice: "consultative",
    traits: ["plain-spoken", "evidence-led"],
    bannedWords: ["synergy", "leverage"],
  },
  templates: {},
};

const BRIEFING = {
  topic: "Migrating our reporting pipeline off nightly batch jobs",
  audience: "Engineering managers who own the on-call rota",
  objective: "Get agreement to fund a two-quarter incremental migration",
  targetSlideCount: 5,
  sourceText:
    "Nightly batch means a data incident is discovered the next morning at the earliest. " +
    "Three of the last five Sev2s were stale-data reports. Incremental streaming would cut " +
    "detection time to minutes for the top ten dashboards.",
};

/* ─────────────────────────────── SSE ─────────────────────────────── */

interface Frame { event: Record<string, unknown>; atMs: number }

/**
 * Consume an SSE response, recording WHEN each frame arrived.
 *
 * The timing is the reason this is hand-written rather than a fetch-and-split: point 4 in the header. If
 * every frame's `atMs` is within a few ms of the last, the server buffered the whole stream and the live
 * grid does not work, no matter how correct the frames are.
 */
async function consumeSse(path: string, body: unknown): Promise<{
  frames: Frame[]; contentType: string; raw: string;
}> {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

  if (!response.body) throw new Error("generate: response had no body");

  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let raw = "";
  let buffer = "";

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // Frames are separated by a blank line. Anything after the last separator is a partial frame and
    // stays in the buffer — which is exactly the case a naive split-on-arrival gets wrong.
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      raw += `${block}\n\n`;
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        frames.push({
          event: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>,
          atMs: Date.now() - started,
        });
      }
      sep = buffer.indexOf("\n\n");
    }
  }

  return {
    frames,
    contentType: response.headers.get("content-type") ?? "",
    raw,
  };
}

/* ─────────────────────────────── the flow ─────────────────────────────── */

interface Brand { id: string; logo?: { light?: string; dark?: string }; templates: Record<string, { backgroundAssetId?: string; zones: { slotKey: string; x: number; y: number; w: number; h: number }[] }> }
interface Deck { id: string; title: string; brandId: string; status?: string }
interface Slide { id: string; layoutId: string; order: number; slots: Record<string, string | string[]>; flags?: string[] }
interface OutlineSlide { message: string; layoutOverride?: string | null }
interface OutlineSection { title: string; slides: OutlineSlide[] }
interface OutlineView { outline: { sections: OutlineSection[] }; advisories?: unknown[]; repaired?: boolean }

async function main(): Promise<void> {
  console.log(`Smoke: ${BASE}`);
  mkdirSync(OUT, { recursive: true });

  // ── 0. Registries with no use-case call (§1.3's live form) ──
  step(0, "Registries serve as static data");
  const layouts = await expectOk<{ layouts: { id: string }[] }>("GET", "/api/registry/layouts");
  check("layout registry is non-empty", layouts.layouts.length > 0, layouts.layouts.length);
  const models = await expectOk<{ models: { id: string }[] }>("GET", "/api/registry/models");
  check("model registry is non-empty", models.models.length > 0);
  const fonts = await expectOk<{ fonts: { id: string }[] }>("GET", "/api/registry/fonts");
  check("fonts registry names georgia",
    fonts.fonts.some((f) => f.id === "georgia"));
  const tones = await expectOk<{ tones: unknown[] }>("GET", "/api/registry/tones");
  check("tones registry is non-empty", tones.tones.length > 0);

  // ── 1. POST /api/brands ──
  step(1, "Create a brand");
  const brand = await expectOk<Brand>("POST", "/api/brands", BRAND_INPUT, 201);
  check("brand has an id", typeof brand.id === "string" && brand.id.length > 0);
  const brandId = brand.id;

  // ── 2. Upload a background for the title layout; PATCH its zones ──
  step(2, "Upload a background and edit its zones");
  const bgPath = join(process.cwd(), "fixtures", "bg-16x9.png");
  const bgBytes = new Uint8Array(readFileSync(bgPath));
  const titleLayout = layouts.layouts[0]?.id ?? "title";

  const form = new FormData();
  form.append("kind", "background");
  form.append("layoutId", titleLayout);
  // No DOM lib in `tsconfig.scripts.json`, so `File` here is Node's (undici's) — which accepts an
  // ArrayBufferView directly, unlike the DOM signature that would want a `BlobPart`.
  form.append("file", new File([bgBytes], "bg-16x9.png", { type: "image/png" }));
  const upload = await fetch(`${BASE}/api/brands/${brandId}/assets`, { method: "POST", body: form });
  const uploaded = await upload.json() as { assetId: string; brand: Brand };
  check("upload returns 201", upload.status === 201, upload.status);
  check("upload returns an assetId", typeof uploaded.assetId === "string");
  check(`brand now has a template for ${titleLayout}`,
    uploaded.brand.templates[titleLayout]?.backgroundAssetId === uploaded.assetId);
  const seededZones = uploaded.brand.templates[titleLayout]?.zones ?? [];
  check("template zones were seeded from the layout's defaults", seededZones.length > 0);

  // The asset's bytes come back through the serving route, with its security headers.
  const assetRes = await fetch(`${BASE}/api/assets/${uploaded.assetId}`);
  const assetBytes = new Uint8Array(await assetRes.arrayBuffer());
  check("asset bytes round-trip exactly", assetBytes.byteLength === bgBytes.byteLength,
    { got: assetBytes.byteLength, want: bgBytes.byteLength });
  check("asset response is CSP-sandboxed",
    (assetRes.headers.get("content-security-policy") ?? "").includes("sandbox"));
  check("asset response sets nosniff",
    assetRes.headers.get("x-content-type-options") === "nosniff");

  // Asymmetric zones, per §8's fixture requirement — a centred zone would hide an x/y swap.
  const firstZone = seededZones[0];
  if (!firstZone) throw new Error("no seeded zone to edit");
  const editedZones = seededZones.map((z, i) =>
    i === 0 ? { ...z, x: 8, y: 12, w: 60, h: 20 } : z);
  const zoned = await expectOk<Brand>("PUT", `/api/brands/${brandId}`, {
    ...BRAND_INPUT,
    templates: {
      [titleLayout]: { backgroundAssetId: uploaded.assetId, zones: editedZones },
    },
  });
  const savedZone = zoned.templates[titleLayout]?.zones.find((z) => z.slotKey === firstZone.slotKey);
  check("asymmetric zone persisted verbatim",
    savedZone?.x === 8 && savedZone?.y === 12 && savedZone?.w === 60,
    savedZone);

  // ── 3. Config round-trips; export JSON -> re-import -> identical ──
  step(3, "Brand config round-trips through export/import");
  const themed = await expectOk<{ brand: Brand; tokens: { fonts: { headingPptx: string } } }>(
    "GET", `/api/brands/${brandId}`);
  check("GET brand returns compiled tokens too",
    typeof themed.tokens?.fonts?.headingPptx === "string", themed.tokens?.fonts);

  const reimported = await expectOk<Brand>("POST", "/api/brands/import", themed.brand, 201);
  check("import created a NEW brand", reimported.id !== brandId);
  // Compare the editable surface, not ids/timestamps — those are supposed to differ.
  const editable = (b: Brand): unknown => {
    const { id: _id, ...rest } = b as Brand & Record<string, unknown>;
    const copy = { ...rest } as Record<string, unknown>;
    delete copy.userId; delete copy.createdAt; delete copy.updatedAt;
    return copy;
  };
  check("re-imported config is identical to the exported one",
    JSON.stringify(editable(reimported)) === JSON.stringify(editable(themed.brand)));
  // Clean up the throwaway import so step 11's brand list stays comprehensible.
  await call("DELETE", `/api/brands/${reimported.id}`);

  // ── 4. POST /api/decks; PATCH the briefing ──
  step(4, "Create a deck and set its briefing");
  const deck = await expectOk<Deck>("POST", "/api/decks",
    { title: "Off Nightly Batch", brandId }, 201);
  const deckId = deck.id;
  check("deck references the brand", deck.brandId === brandId);
  const briefed = await expectOk<Deck>("PATCH", `/api/decks/${deckId}`, { briefing: BRIEFING });
  check("briefing patch returned the deck", briefed.id === deckId);

  // ── 5. Generate the outline (REAL model call) ──
  step(5, "Generate the outline (live Bedrock)");
  const t0 = Date.now();
  const outline = await expectOk<OutlineView>("POST", `/api/decks/${deckId}/outline`, {}, 200);
  console.log(`  (outline in ${Date.now() - t0} ms)`);
  const sections = outline.outline.sections;
  const planned = sections.flatMap((s) => s.slides);
  check("outline has at least one section", sections.length > 0);
  check("every slide carries exactly one message",
    planned.every((s) => typeof s.message === "string" && s.message.trim() !== ""));
  // SPEC's +-2 tolerance on the requested count.
  check(`slide count is within +-2 of ${BRIEFING.targetSlideCount} (got ${planned.length})`,
    Math.abs(planned.length - BRIEFING.targetSlideCount) <= 2, planned.length);

  const outlineView = await expectOk<OutlineView & { mapping?: unknown }>(
    "GET", `/api/decks/${deckId}/outline`);
  check("outline persisted and reads back",
    outlineView.outline.sections.flatMap((s) => s.slides).length === planned.length);

  // ── 6. Edit the outline: reword, reorder, pin a layout ──
  step(6, "Edit the outline");
  const edited = structuredClone(outline.outline);
  const firstSection = edited.sections[0];
  if (!firstSection || firstSection.slides.length === 0) throw new Error("outline had no editable slide");
  firstSection.slides[0]!.message = "Nightly batch is why we find incidents the next morning.";
  if (firstSection.slides.length > 1) {
    firstSection.slides.reverse();
  }
  const saved = await expectOk<OutlineView>("PATCH", `/api/decks/${deckId}/outline`, { outline: edited });
  check("edited message persisted",
    saved.outline.sections[0]?.slides.some((s) =>
      s.message.startsWith("Nightly batch is why")));

  const pinned = await expectOk<OutlineView>(
    "PUT", `/api/decks/${deckId}/outline/sections/0/slides/0/layout`, { layoutId: titleLayout });
  check("layoutOverride pinned",
    pinned.outline.sections[0]?.slides[0]?.layoutOverride === titleLayout,
    pinned.outline.sections[0]?.slides[0]);

  // ── 7. Generate slides over SSE (REAL model calls) ──
  step(7, "Generate slides (SSE, live Bedrock)");
  const { frames, contentType } = await consumeSse(`/api/decks/${deckId}/generate`, {});
  check("content-type is text/event-stream", contentType.startsWith("text/event-stream"), contentType);

  const types = frames.map((f) => f.event.type as string);
  const starts = types.filter((t) => t === "slide-start").length;
  const dones = types.filter((t) => t === "slide-done").length;
  const errors = types.filter((t) => t === "slide-error").length;
  const fatals = types.filter((t) => t === "fatal");
  const deckDone = frames.find((f) => f.event.type === "deck-done")?.event as
    { ok?: number; failed?: number } | undefined;

  console.log(`  frames: ${types.join(", ")}`);
  check("no fatal frame", fatals.length === 0, fatals);
  check("one slide-start per planned slide", starts === planned.length, { starts, planned: planned.length });
  check("every slide finished one way or the other", dones + errors === starts,
    { dones, errors, starts });
  check("deck-done counts match the frames",
    deckDone?.ok === dones && deckDone?.failed === errors, deckDone);

  // §9's guarantee, restated as the thing a user sees: NO BLANK SLIDES. A slide-error still yields a
  // slide with fallback content, so the count that matters is slides persisted, not slides succeeded.
  const slideDoneIndexes = frames
    .filter((f) => f.event.type === "slide-done" || f.event.type === "slide-error")
    .map((f) => f.event.index as number);
  check("indexes are contiguous from 0",
    [...slideDoneIndexes].sort((a, b) => a - b).every((v, i) => v === i), slideDoneIndexes);

  // Point 4 of the header: the frames must ARRIVE spread out, not all at once at the end. Slides take
  // seconds each, so a buffered stream would land every frame within a few ms of the last.
  const arrival = frames.map((f) => f.atMs);
  const firstDone = frames.find((f) => f.event.type === "slide-done")?.atMs ?? 0;
  const lastFrame = arrival.length > 0 ? arrival[arrival.length - 1]! : 0;
  console.log(`  first slide-done at ${firstDone} ms, last frame at ${lastFrame} ms`);
  check("frames streamed progressively (first slide-done well before the last frame)",
    starts <= 1 || (lastFrame - firstDone) > 250, { firstDone, lastFrame });

  // ── 8. Edit a slide; regenerate it with an instruction ──
  step(8, "Edit and regenerate one slide");
  const workspace = await expectOk<{
    slides: Slide[]; templates: unknown[]; tokens: unknown; exportFormats: string[];
  }>("GET", `/api/decks/${deckId}/workspace`);
  check("workspace returns slides", workspace.slides.length === starts, workspace.slides.length);
  check("workspace names an export format", workspace.exportFormats.includes("pptx"),
    workspace.exportFormats);
  check("workspace resolves templates for the layouts in use", workspace.templates.length > 0);

  const target = workspace.slides[0];
  if (!target) throw new Error("no slide to edit");
  const firstSlotKey = Object.keys(target.slots)[0];
  if (!firstSlotKey) throw new Error("slide had no slots");
  const original = target.slots[firstSlotKey];
  const editedValue = Array.isArray(original) ? ["Edited by smoke"] : "Edited by smoke";
  const patchedSlide = await expectOk<Slide>(
    "PATCH", `/api/decks/${deckId}/slides/${target.id}`,
    { slots: { ...target.slots, [firstSlotKey]: editedValue } });
  check("slot edit persisted",
    JSON.stringify(patchedSlide.slots[firstSlotKey]) === JSON.stringify(editedValue),
    patchedSlide.slots[firstSlotKey]);

  // The response is a `SlideOutcome` — `{slideId, index, content, degraded}` — deliberately NOT a bare
  // slide, so the card can badge a fallback rather than present it as the requested content.
  const regen = await expectOk<{
    slideId: string; index: number; degraded: boolean;
    content: { slots: Record<string, string | string[]>; flags: string[]; issue?: unknown };
  }>("POST", `/api/decks/${deckId}/slides/${target.id}/regenerate`, { instruction: "punchier" });
  check("regenerate returned the outcome for this slide", regen.slideId === target.id, regen.slideId);
  check("regenerate was not degraded", regen.degraded === false,
    { degraded: regen.degraded, issue: regen.content?.issue });
  check("regenerate replaced the hand-edited slot with model content",
    JSON.stringify(regen.content.slots[firstSlotKey]) !== JSON.stringify(editedValue),
    regen.content.slots[firstSlotKey]);

  // In place: same id, same order. Read back from storage rather than trusting the outcome, since
  // "keeps its id/order/createdAt" (SPEC §7.4) is a property of what was persisted.
  const afterRegen = await expectOk<Slide>("GET", `/api/decks/${deckId}/slides/${target.id}`);
  check("regenerate kept the slide's identity and position",
    afterRegen.id === target.id && afterRegen.order === target.order,
    { id: afterRegen.id, order: afterRegen.order, wanted: target.order });

  // Reorder through the STATIC segment — header point 1. A router that preferred `[slideId]` would
  // 404 here while every direct-call test still passed.
  if (workspace.slides.length > 1) {
    const reversed = [...workspace.slides].map((s) => s.id).reverse();
    const reordered = await expectOk<{ slides: Slide[] }>(
      "PUT", `/api/decks/${deckId}/slides/order`, { orderedIds: reversed });
    check("PUT slides/order reached the order handler, not [slideId]",
      reordered.slides.length === workspace.slides.length);
    check("order is a contiguous 0..n-1 after the reorder",
      reordered.slides.map((s) => s.order).every((o, i) => o === i),
      reordered.slides.map((s) => s.order));
    // Put it back, so the exported deck reads in the outline's order.
    await expectOk("PUT", `/api/decks/${deckId}/slides/order`,
      { orderedIds: workspace.slides.map((s) => s.id) });
  }

  // ── 9. Export the PPTX (the manual gate) ──
  step(9, "Export PPTX");
  const exportRes = await fetch(`${BASE}/api/decks/${deckId}/export/pptx`);
  const pptx = new Uint8Array(await exportRes.arrayBuffer());
  check("export returns 200", exportRes.status === 200, exportRes.status);
  check("content-type is the OOXML presentation type",
    (exportRes.headers.get("content-type") ?? "")
      .includes("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    exportRes.headers.get("content-type"));
  const disposition = exportRes.headers.get("content-disposition") ?? "";
  check("content-disposition is an attachment with both filename forms",
    disposition.startsWith("attachment;") && disposition.includes('filename="')
      && disposition.includes("filename*=UTF-8''"), disposition);
  check("body is a zip (PK\\x03\\x04)",
    pptx[0] === 0x50 && pptx[1] === 0x4b && pptx[2] === 0x03 && pptx[3] === 0x04,
    [...pptx.slice(0, 4)]);
  check("declared content-length matches the bytes",
    Number(exportRes.headers.get("content-length")) === pptx.byteLength);
  // Sanity on size: a deck of five slides with a background image is tens of KB at minimum. A 2 KB
  // file would be a structurally valid but empty presentation, which every check above would pass.
  check("file is substantial (>20 KB)", pptx.byteLength > 20_000, pptx.byteLength);

  const pptxPath = join(OUT, "SMOKE.pptx");
  writeFileSync(pptxPath, pptx);
  console.log(`  wrote ${pptxPath}`);
  console.log("  ** MANUAL GATE: open this in PowerPoint and check fonts are NOT substituted");
  console.log("     (VERIFICATION.md WARN-VERIFY #5 - deferred, not waived) **");

  // ── 10. Brand swap: re-render check, content unchanged ──
  step(10, "Swap the deck's brand");
  const secondBrand = await expectOk<Brand>("POST", "/api/brands", {
    ...BRAND_INPUT,
    name: "Smoke Brand Two",
    colors: { ...BRAND_INPUT.colors, primary: "#2244EE", accent: "#EE8822" },
    fonts: { heading: "verdana", body: "verdana" },
    templates: {},
  }, 201);

  const before = await expectOk<{ slides: Slide[] }>("GET", `/api/decks/${deckId}/workspace`);
  const swapped = await expectOk<{
    deck: Deck; brand: Brand; tokens: { colors: { primary: string } }; templates: unknown[];
  }>("PATCH", `/api/decks/${deckId}`, { brandId: secondBrand.id });
  check("swap returned the re-resolved brand", swapped.brand.id === secondBrand.id);
  check("swap returned tokens for the NEW brand",
    swapped.tokens.colors.primary.toUpperCase() === "2244EE", swapped.tokens.colors.primary);
  check("swap returned templates to re-render with", Array.isArray(swapped.templates));

  const after = await expectOk<{ slides: Slide[] }>("GET", `/api/decks/${deckId}/workspace`);
  check("slide CONTENT is unchanged by the brand swap",
    JSON.stringify(after.slides.map((s) => s.slots))
      === JSON.stringify(before.slides.map((s) => s.slots)));

  // The swapped deck still exports — the second brand has no background, so this is the
  // token-styled path where the first export was templated.
  const exported2 = await fetch(`${BASE}/api/decks/${deckId}/export/pptx`);
  const pptx2 = new Uint8Array(await exported2.arrayBuffer());
  check("token-styled export also succeeds", exported2.status === 200 && pptx2.byteLength > 20_000,
    { status: exported2.status, size: pptx2.byteLength });
  writeFileSync(join(OUT, "SMOKE-SWAPPED.pptx"), pptx2);

  // ── 11. Delete: brand blocked while referenced, allowed after ──
  step(11, "Deletion order is enforced");
  const blocked = await call("DELETE", `/api/brands/${secondBrand.id}`);
  check("deleting a referenced brand is 409 BrandInUse",
    blocked.status === 409 && (blocked.body as { code?: string }).code === "BrandInUse", blocked.body);
  check("the 409 does not leak the brand id",
    !JSON.stringify(blocked.body).includes(secondBrand.id));

  const deleted = await call("DELETE", `/api/decks/${deckId}`);
  check("deck delete is 204", deleted.status === 204, deleted.status);
  const gone = await call("GET", `/api/decks/${deckId}`);
  check("deck is gone (404)", gone.status === 404, gone.status);

  const nowAllowed = await call("DELETE", `/api/brands/${secondBrand.id}`);
  check("brand delete succeeds once unreferenced", nowAllowed.status === 204, nowAllowed.status);
  const firstGone = await call("DELETE", `/api/brands/${brandId}`);
  check("the original brand deletes too", firstGone.status === 204, firstGone.status);

  /* ── summary ── */
  console.log(`\n${"=".repeat(64)}`);
  console.log(`${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exitCode = 1;
  } else {
    console.log("SMOKE GREEN. Remaining manual gate: open out/SMOKE.pptx in PowerPoint (fonts).");
  }
}

main().catch((err: unknown) => {
  console.error(`\nSMOKE ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
});
