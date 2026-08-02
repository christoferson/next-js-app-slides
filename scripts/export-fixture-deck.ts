/**
 * §2 step 13's manual gate: "a fixture deck covering every seed layout, templated AND token-styled."
 *
 * ## Why this is a separate artifact from `verify-pptx-opentest.ts`
 *
 * That script is a §1.1 *spike*: it hand-builds pptxgenjs calls (with its own copies of the zone and
 * letterbox math) to probe what the library can do, and it deliberately does not touch our code. This
 * one is the opposite — it drives the REAL path, `createContainer()` → `ExportService` → `PptxExporter`
 * → each layout's own `toPptx`, so what a human opens is byte-identical to what a user would download.
 * A spike passing proves pptxgenjs works; only this proves *we* drove it correctly.
 *
 * Two decks, because the two render strategies emit genuinely different XML and a defect in either is
 * invisible from the other:
 *
 *   - `out/FIXTURE-TOKEN.pptx`     — no backgrounds. Solid `<p:bg>`, each layout's token-styled
 *                                   ornaments (accent rules, cards), and the bottom-right logo.
 *   - `out/FIXTURE-TEMPLATED.pptx` — a background on every layout, so slides draw from slide masters
 *                                   and each layout suppresses its ornaments and the logo (§1.1/C3).
 *
 * Every slide names its own layout and mode in its title, so the human check needs no separate key:
 * page N of the render is registry entry N.
 *
 * ## What a human opening these is actually checking
 *
 * `tests/pptx-exporter.test.ts` already asserts the EMU geometry, the master/media counts and the C5
 * paragraph counts against the unpacked XML — all of that is automated and needs no eyes. What bytes
 * CANNOT show is **font substitution**: whether a desktop Office install silently swapped Georgia or
 * Verdana for Calibri. That single unverifiable fact is ⚠️ VERIFY #1 in `VERIFICATION.md`, and it is
 * the whole reason this gate stays manual.
 *
 * Run: npm run verify:pptx:fixture           (writes both files)
 *      npm run verify:pptx:fixture:render    (rasters them via LibreOffice for a diffable check)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContainer } from "@/lib/container";
import { LAYOUTS } from "@/lib/layouts/registry";
import type { SlotValue, SlotValues } from "@/lib/domain/slots";
import type { SlotSpec } from "@/lib/layouts/types";

const OUT = join(process.cwd(), "out");
const FIXTURES = join(process.cwd(), "fixtures");

type Mode = "token" | "templated";

/**
 * Content for every slot a layout declares — including OPTIONAL ones, unlike
 * `tests/service-harness.ts`'s `slideResponseFor`, which fills only the required set.
 *
 * The difference is deliberate and is the point of this fixture: an optional slot that is never
 * populated is a zone whose geometry no test and no human has ever looked at. `paintPptx` correctly
 * skips absent slots, so the only way to see `title`'s `subtitle` or `stats`' caption land in the right
 * place is to fill them here.
 *
 * Derived from the registry rather than written out (§4): a new layout, or a changed budget, needs no
 * edit to this file — and cannot leave a stale over-budget fixture behind.
 */
function slotsFor(specs: readonly SlotSpec[], layoutId: string, mode: Mode): SlotValues {
  const out: Record<string, SlotValue> = {};
  for (const spec of specs) {
    if (spec.type === "list") {
      // Fill lists to their declared maximum, not to a comfortable 2–3. A budget is only a real
      // constraint at the item count the layout claims to support, and overflow past a zone's bottom
      // edge is exactly the C1 failure this deck exists to make visible.
      const n = spec.maxItems ?? 3;
      out[spec.key] = Array.from({ length: n }, (_, i) =>
        fill(`Item ${i + 1} — Georgia? Verdana? 日本語`, spec.itemMaxChars ?? spec.maxChars));
      continue;
    }
    out[spec.key] = spec.key === "title"
      ? fill(`${layoutId} · ${mode}`, spec.maxChars)
      : fill(`${spec.key} — Aa Bb 0123 日本語`, spec.maxChars);
  }
  return out;
}

/**
 * Pad to just under budget, then hard-cut.
 *
 * Padding matters: a fixture whose text is far inside its budget cannot reveal that `maxChars` was set
 * too generously for the zone, and C1 means nothing shrinks to rescue it. Cutting at the end keeps the
 * slide inside budget by construction rather than by luck, so `addSlide` never flags it as `trimmed`
 * and the render shows the intended worst case.
 */
function fill(text: string, maxChars: number): string {
  let s = text;
  while (s.length < maxChars) s += ` ${text}`;
  return s.slice(0, maxChars);
}

async function build(mode: Mode): Promise<void> {
  // A fresh memory-backed container per deck: the two runs cannot see each other's assets, so the
  // script needs no cleanup and cannot pass because of state the other one left behind. Note that
  // nothing here constructs an implementation — §3 holds even in a script.
  const c = createContainer({ storageBackend: "memory", assetBackend: "memory" });
  const { brands, decks, export: exporter } = c.services;
  const userId = "fixture-user";

  const brand = await brands.create(userId, {
    name: "Fixture Brand",
    colors: {
      primary: "#3D5AFE", secondary: "#00BFA5", accent: "#FFAB00",
      background: "#0B0B14", surface: "#1A1A2E",
      textOnLight: "#111111", textOnDark: "#FAFAFA",
    },
    // Georgia heading / Verdana body, and NOT the same face for both. The gate is font substitution,
    // so a brand that used Calibri — or one face twice — could not show a swap even if it happened.
    fonts: { heading: "georgia", body: "verdana" },
    tone: { voice: "executive", traits: ["direct"], bannedWords: [] },
    templates: {},
  });

  // `addAsset` attaches the asset itself: a logo lands on `brand.logo.light`, and a background is
  // attached to its layout's template with `defaultZones` seeded. So there is no `update` call here —
  // going through the service is what keeps this fixture honest about the real write path.
  await brands.addAsset(userId, brand.id, readFileSync(join(FIXTURES, "logo.png")), {
    filename: "logo.png", contentType: "image/png", byteSize: 640, kind: "logo",
    width: 200, height: 100,
  });

  if (mode === "templated") {
    const bytes = readFileSync(join(FIXTURES, "bg-1920.png"));
    for (const layout of LAYOUTS) {
      // One `addAsset` per layout, because `layoutId` is part of the asset's identity. These are
      // DISTINCT assets with identical bytes, which is the harder case for §1.1/C3: the exporter keys
      // its master registry on the resolved-asset object, so this deck should show 8 masters and 8
      // media parts, while a brand reusing one asset shows 1 of each (asserted in the test suite).
      await brands.addAsset(userId, brand.id, bytes, {
        filename: `bg-${layout.id}.png`, contentType: "image/png", byteSize: bytes.byteLength,
        kind: "background", layoutId: layout.id, width: 1920, height: 1080,
      });
    }
  }

  const deck = await decks.create(userId, {
    title: `Fixture ${mode}`,
    brandId: brand.id,
    briefing: {
      topic: "Every seed layout, one slide each",
      audience: "Whoever runs the §13 open-test",
      objective: "Confirm brand fonts survive and zones land where the preview says",
      targetSlideCount: LAYOUTS.length,
    },
  });

  // One slide per registry entry, in registry order — so page N is layout N.
  for (const layout of LAYOUTS) {
    await decks.addSlide(userId, deck.id, {
      layoutId: layout.id,
      slots: slotsFor(layout.slots, layout.id, mode),
      speakerNotes: `${layout.id} (${mode}). CHECK: headings render in Georgia and body in Verdana, `
        + "NOT Calibri; every list item carries its own bullet; no text spills past its zone.",
    });
  }

  const result = await exporter.export(userId, deck.id, "pptx");
  const path = join(OUT, `FIXTURE-${mode.toUpperCase()}.pptx`);
  writeFileSync(path, result.bytes);

  console.log(
    `${path}\n  ${LAYOUTS.length} slides, ${Math.round(result.bytes.byteLength / 1024)} KB`
    + `, download name "${result.filename}"`,
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await build("token");
  await build("templated");

  console.log(`
Open BOTH files. The one thing the automated suite cannot check (⚠️ VERIFY #1):

  · heading text renders in GEORGIA and body text in VERDANA — not silently swapped to Calibri.
    Every slide's title states its layout, so a substitution is traceable to a specific layout.

Also worth a glance while they are open, since these are the human-visible consequences of C1/C3:
  · TOKEN deck: a logo bottom-right on every slide; no text spilling past its zone at full budget.
  · TEMPLATED deck: the brand background full-bleed on every slide, and NO second logo stamped on it.

Zone EMU geometry, master/media counts and bullet paragraph counts are asserted against the unpacked
XML in tests/pptx-exporter.test.ts — those need no eyes here.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
