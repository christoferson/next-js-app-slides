/**
 * §2 step 13 — `PptxExporter`, asserted against the ACTUAL OOXML it emits.
 *
 * ## Why this suite unpacks the ZIP
 *
 * An exporter test that only checked "returned some bytes" would pass against every one of the five
 * §1.1 constraints being violated. So this one opens the package and reads the parts:
 *
 *   - `ppt/media/*` — the file count is C3's whole claim (pptxgenjs does not dedupe identical media).
 *   - `ppt/slideLayouts/*` — one per DISTINCT background, and no more. (Not `slideMasters/`: pptxgenjs
 *     emits exactly one of those regardless, so counting there would have passed while asserting nothing.
 *     See `Package.layoutNames`.)
 *   - `ppt/slides/slideN.xml` — `<a:off>`/`<a:ext>` in EMU, which is what §8's zone fidelity means:
 *     the same numbers the browser preview derives from the same `resolveZones` + percent math.
 *   - `<a:p>` counts, using the regexes `scripts/verify-pptx-paragraphs.ts` verified against real
 *     output — so C5's collapse would fail this suite rather than ship as a silently merged list.
 *
 * ## The gate this suite does NOT close
 *
 * Font substitution on a desktop Office install. Every assertion here is about bytes, and bytes cannot
 * tell you that PowerPoint on macOS quietly swapped Georgia for Calibri. `VERIFICATION.md` carries that
 * as ⚠️ VERIFY #1, deferred rather than waived, and CLAUDE.md §13's "opened in real PowerPoint" box
 * stays unchecked until someone opens `verify:pptx:opentest`'s output on a desktop install.
 */

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { AssetMeta, ResolvedAsset } from "@/lib/domain/asset";
import type { Slide } from "@/lib/domain/deck";
import type { ExportRequest } from "@/lib/ports/exporter";
import { compileTheme } from "@/lib/brand/theme";
import { PptxExporter, pickLogo, PPTX_CONTENT_TYPE } from "@/lib/export/pptx-exporter";
import { cardColumns } from "@/lib/layouts/defs/stats";
import { LAYOUTS } from "@/lib/layouts/registry";
import { resolveZones } from "@/lib/layouts/render-mode";
import { EMU_PER_INCH, SLIDE_16x9, zoneToInches } from "@/lib/layouts/zone-math";
import { brandInput, harness, type Harness } from "@/tests/service-harness";

/* ─────────────────────────────── OOXML readers ─────────────────────────────── */

interface Package {
  slides: string[];
  /**
   * Names of the slide *layout* parts, which is where `defineSlideMaster` actually lands.
   *
   * Probed, not assumed (`scripts/verify-pptx-paragraphs.ts`'s sibling probe): pptxgenjs emits exactly
   * ONE `slideMaster1.xml` no matter how many masters you define, and each defined master becomes a
   * `slideLayoutN.xml` whose `<p:cSld name>` is the title we passed. So "one master per distinct
   * background" is counted here, on the layout parts — counting `slideMasters/` would have read `1`
   * forever and the C3 assertion would have passed while doing nothing.
   */
  layoutNames: string[];
  media: string[];
  /** Notes text per slide, in slide order — `""` where the slide has none. */
  notes: string[];
  /** `dc:title`/`dc:subject`/`dc:creator` live here. */
  core: string;
  /** `Company` lives here, NOT in `core.xml` — probed, not assumed. */
  app: string;
}

async function unpack(bytes: Uint8Array): Promise<Package> {
  const zip = await JSZip.loadAsync(bytes);
  // `!dir`: JSZip lists folder entries too, and `ppt/media/` counted as an image would make every C3
  // assertion off by one in the direction that hides a duplicate.
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
  const read = async (pattern: RegExp): Promise<string[]> => {
    // Numeric sort: `slide10.xml` sorts before `slide2.xml` lexically, which would silently misalign
    // every per-slide assertion in a deck of ten or more.
    const matched = names.filter((n) => pattern.test(n))
      .sort((a, b) => (Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0)));
    return Promise.all(matched.map((n) => zip.file(n)!.async("string")));
  };

  const layouts = await read(/^ppt\/slideLayouts\/slideLayout\d+\.xml$/);
  // pptxgenjs writes a notes part for EVERY slide whether or not `addNotes` was called — the empty ones
  // carry `<a:t></a:t>` plus the slide number. So a count is meaningless and the TEXT is the assertion.
  const notes = await read(/^ppt\/notesSlides\/notesSlide\d+\.xml$/);

  return {
    slides: await read(/^ppt\/slides\/slide\d+\.xml$/),
    layoutNames: layouts.map((xml) => xml.match(/<p:cSld name="([^"]*)"/)?.[1] ?? ""),
    media: names.filter((n) => /^ppt\/media\/.+/.test(n)),
    // Drop the trailing slide-number run pptxgenjs appends, so an empty note reads as "".
    notes: notes.map((xml) =>
      [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]!).slice(0, -1).join("\n")),
    core: (await zip.file("docProps/core.xml")?.async("string")) ?? "",
    app: (await zip.file("docProps/app.xml")?.async("string")) ?? "",
  };
}

/** How many masters WE defined — pptxgenjs's own base layouts are not named `bg-N`. */
const brandMasters = (pkg: Package): string[] => pkg.layoutNames.filter((n) => /^bg-\d+$/.test(n));

/** Every `<p:sp>` in document order with its paragraph counts — the probe-verified shape. */
function shapes(xml: string): Array<{ paras: number; bulletParas: number; texts: string[] }> {
  return [...xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)].map((m) => {
    const body = m[1]!;
    return {
      paras: [...body.matchAll(/<a:p>/g)].length,
      // Verified against real output in `scripts/verify-pptx-paragraphs.ts` (Q3/Q5): a bullet paragraph
      // opens with `<a:pPr …>` and carries `<a:buChar>` or `<a:buAutoNum>` before its `</a:p>`.
      bulletParas: [...body.matchAll(
        /<a:p><a:pPr[^>]*>(?:(?!<\/a:p>)[\s\S])*?<a:bu(?:Char|AutoNum)/g)].length,
      texts: [...body.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]!),
    };
  });
}

/**
 * Shape offsets in EMU, in document order — the unit §8's fidelity claim is measured in.
 *
 * `\s*` between the two tags is load-bearing: pptxgenjs pretty-prints `<p:pic>` geometry with newlines
 * and leading spaces (`<a:off …/>\n  <a:ext …/>`) while text shapes are emitted adjacent. A regex
 * requiring adjacency silently returned zero matches for every image.
 */
const offsets = (xml: string): Array<{ x: number; y: number; cx: number; cy: number }> =>
  [...xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), cx: Number(m[3]), cy: Number(m[4]) }));

/**
 * Does this geometry look like a horizontal accent rule?
 *
 * Short, narrow, and — critically — of NON-ZERO size. Every slide part opens with the `<p:spTree>`'s own
 * `<a:xfrm>` at `0,0,0,0`, which `offsets` cannot distinguish from a shape and which satisfies any
 * "smaller than" filter. Omitting the positive-size check made a templated slide appear to still carry
 * a rule when what it carried was the group transform.
 *
 * Matching by shape rather than by exact coordinates is deliberate: the rule's position is DERIVED from
 * the title zone (`ruleAboveZone`), so writing its numbers here would restore exactly the duplicated
 * constant whose staleness caused the strike-through defect.
 */
const isRuleShaped = (o: { cx: number; cy: number }): boolean =>
  o.cx > 0 && o.cy > 0 && o.cx < EMU_PER_INCH * 3.3 && o.cy < EMU_PER_INCH * 0.2;

const allText = (xml: string): string =>
  [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]!).join("\n");

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const png = (): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const background = (layoutId: string, w = 1920, h = 1080): Omit<AssetMeta, "createdAt"> => ({
  filename: `bg-${layoutId}.png`, contentType: "image/png", byteSize: 4,
  width: w, height: h, kind: "background", layoutId,
});

const zonesOf = (layoutId: string) =>
  LAYOUTS.find((l) => l.id === layoutId)!.defaultZones.map((z) => ({ ...z }));

/**
 * Required slots only, derived from the layout's own `SlotSpec`s.
 *
 * Derived rather than written out for §4's reason: a layout that gains a required slot must not leave a
 * stale fixture here that silently exports an incomplete slide. Values are inside budget by construction.
 */
function slotsFor(layoutId: string, label = "Alpha"): Record<string, string | string[]> {
  const layout = LAYOUTS.find((l) => l.id === layoutId)!;
  return Object.fromEntries(layout.slots.filter((s) => s.required).map((spec) => [
    spec.key,
    spec.type === "list"
      ? Array.from({ length: Math.min(3, spec.maxItems ?? 3) },
        (_, i) => `${label} ${spec.key} ${i + 1}`.slice(0, spec.itemMaxChars ?? spec.maxChars))
      : `${label} ${spec.key}`.slice(0, spec.maxChars),
  ]));
}

/** A deck of the given layouts, exported through the container-wired service. */
async function exportDeck(
  h: Harness, layoutIds: readonly string[], title = "Q3 Review",
): Promise<{ bytes: Uint8Array; pkg: Package; brandId: string; deckId: string }> {
  const brand = await h.services.brands.create(h.userId, brandInput());
  const deck = await h.services.decks.create(h.userId, { title, brandId: brand.id });
  for (const layoutId of layoutIds) {
    await h.services.decks.addSlide(h.userId, deck.id, { layoutId, slots: slotsFor(layoutId) });
  }
  const result = await h.services.export.export(h.userId, deck.id, "pptx");
  return { bytes: result.bytes, pkg: await unpack(result.bytes), brandId: brand.id, deckId: deck.id };
}

/**
 * One slide, with the boilerplate every fixture would otherwise repeat.
 *
 * `flags: []` is required by `Slide` and easy to forget — vitest does not typecheck, so twelve inline
 * literals each missing it compiled fine under the test runner and only failed `npm run typecheck`.
 */
function slide(
  layoutId: string, order: number, overrides: Partial<Slide> = {}, label = "Alpha",
): Omit<Slide, "id" | "deckId"> {
  return {
    layoutId, order, slots: slotsFor(layoutId, label), flags: [],
    createdAt: AT, updatedAt: AT, ...overrides,
  };
}

const AT = "2026-07-01T00:00:00.000Z";

/** An `ExportRequest` built by hand, for the cases a service path cannot reach. */
async function requestFor(
  h: Harness, slides: readonly Omit<Slide, "id" | "deckId">[],
  extra: Partial<ExportRequest> = {},
): Promise<ExportRequest> {
  const brand = await h.services.brands.create(h.userId, brandInput());
  const full = await h.services.brands.get(h.userId, brand.id);
  return {
    deck: {
      id: "deck-1", userId: h.userId, brandId: brand.id, title: "Fixture",
      createdAt: h.clock.iso(), updatedAt: h.clock.iso(),
    },
    slides: slides.map((s, i) => ({ ...s, id: `slide-${i + 1}`, deckId: "deck-1" })) as Slide[],
    brand: full,
    tokens: compileTheme(full),
    backgroundsByLayoutId: {},
    ...extra,
  };
}

/* ─────────────────────────────── the suite ─────────────────────────────── */

describe("PptxExporter — the package it produces", () => {
  it("is a valid OOXML package with one slide per deck slide, in order", async () => {
    const h = harness();
    const { bytes, pkg } = await exportDeck(h, ["title", "bullets", "closing"]);

    // A .pptx is a ZIP; `PK\x03\x04` is the local file header.
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(pkg.slides).toHaveLength(3);
    // Deck order, not layout-registry order — the slides carry their own `order`.
    expect(allText(pkg.slides[0]!)).toContain("Alpha title");
    expect(allText(pkg.slides[1]!)).toContain("Alpha items 1");
    expect(allText(pkg.slides[2]!)).toContain("Alpha nextSteps 1");
  });

  it("declares the deck title in document properties, not the brand name", async () => {
    const h = harness();
    const { pkg } = await exportDeck(h, ["title"], "Billing Reliability");

    // Otherwise the file shows up in a recent-files list as "PowerPoint Presentation".
    expect(pkg.core).toContain("<dc:title>Billing Reliability</dc:title>");
    // The brand is the look; the deck is the document — so the brand is the creator, not the title.
    // Without `author`, pptxgenjs credits ITSELF as `dc:creator`.
    expect(pkg.core).toContain("<dc:creator>Loud Brand</dc:creator>");
    expect(pkg.core).not.toContain("PptxGenJS");
    // `company` lands in app.xml, not core.xml. Asserted where it actually goes, so this test cannot
    // pass by finding the string in the wrong part.
    expect(pkg.app).toContain("Loud Brand");
  });

  it("orders slides by `order`, not by the array it was handed", async () => {
    const h = harness();
    const exporter = new PptxExporter();
    const request = await requestFor(h, [
      // Deliberately reversed: an exporter that trusted array order would emit these backwards.
      slide("bullets", 1, {}, "Second"),
      slide("bullets", 0, {}, "First"),
    ]);

    const pkg = await unpack((await exporter.export(request)).bytes);
    expect(allText(pkg.slides[0]!)).toContain("First");
    expect(allText(pkg.slides[1]!)).toContain("Second");
  });

  it("writes speaker notes as a notes slide, and none when there are none", async () => {
    const h = harness();
    const exporter = new PptxExporter();
    const request = await requestFor(h, [
      slide("bullets", 0, { speakerNotes: "Pause here." }),
      slide("bullets", 1),
      // Whitespace-only: an empty notes part is noise in the package, and a presenter clicking
      // "notes" to find a blank pane reads as data loss.
      slide("bullets", 2, { speakerNotes: "   " }),
    ]);

    const pkg = await unpack((await exporter.export(request)).bytes);
    // pptxgenjs writes a notes part per slide regardless, so the TEXT is the assertion, not the count.
    expect(pkg.notes).toEqual(["Pause here.", "", ""]);
  });

  it("reports an unknown stored layoutId as a 400 naming the known layouts", async () => {
    const h = harness();
    const exporter = new PptxExporter();
    // Reachable by exporting a deck whose slides were written when a layout existed and is now gone.
    const request = await requestFor(h, [
      slide("bullets", 0, { layoutId: "carousel", slots: { title: "Gone" } }),
    ]);

    await expect(exporter.export(request)).rejects.toMatchObject({
      code: "UnknownLayout", status: 400,
    });
  });
});

describe("PptxExporter — §8 zone fidelity", () => {
  it("places text at the EMU the shared zone math derives, for every seed layout", async () => {
    const h = harness();
    const { pkg, brandId } = await exportDeck(h, LAYOUTS.map((l) => l.id));
    const brand = await h.services.brands.get(h.userId, brandId);

    expect(pkg.slides).toHaveLength(LAYOUTS.length);

    for (const [i, layout] of LAYOUTS.entries()) {
      const { zones } = resolveZones(brand, layout);
      const emitted = offsets(pkg.slides[i]!);
      const filled = slotsFor(layout.id);

      // Only the zones whose slot the fixture actually populated. A zone exists for every declared slot
      // including optional ones, and `paintPptx` correctly paints nothing for an absent slot — demanding
      // a box for `title`'s unset `subtitle` was asserting the opposite of the intended behaviour.
      //
      // Asserted as set membership rather than positionally, because a layout also paints ornaments
      // (panels, rules) with their own geometry — `quote`'s vertical rule, `stats`' card panels.
      for (const zone of zones.filter((z) => Object.hasOwn(filled, z.slotKey))) {
        const value = filled[zone.slotKey]!;

        // `stats` is the one seed layout whose zones are *bands* it subdivides — a card column is not
        // separately positionable (its own header says so). So the expectation comes from `cardColumns`,
        // the very function the layout uses, rather than from a hand-copied column geometry here.
        const expected = layout.id === "stats" && Array.isArray(value)
          ? cardColumns(zone, value.length)
          : [zone];

        for (const target of expected) {
          const inches = zoneToInches(target);
          const want = {
            x: Math.round(inches.x * EMU_PER_INCH), y: Math.round(inches.y * EMU_PER_INCH),
            cx: Math.round(inches.w * EMU_PER_INCH), cy: Math.round(inches.h * EMU_PER_INCH),
          };
          // ±1 EMU (1/914400 inch) absorbs pptxgenjs's own rounding. Anything larger is a real divergence
          // from the preview, which derives its percentages from the same `resolveZones` call.
          const hit = emitted.some((o) =>
            Math.abs(o.x - want.x) <= 1 && Math.abs(o.y - want.y) <= 1
            && Math.abs(o.cx - want.cx) <= 1 && Math.abs(o.cy - want.cy) <= 1);
          expect(hit, `${layout.id}: no shape at zone ${zone.slotKey} (${JSON.stringify(want)}) — `
            + `emitted ${JSON.stringify(emitted)}`).toBe(true);
        }
      }
    }
  });

  it("honours a brand's customized zones rather than the layout's defaults", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput());
    const current = await h.services.brands.get(h.userId, brand.id);
    // Deliberately asymmetric, per §8's fixture note: an off-centre title is the case where a hardcoded
    // default would still look plausible in isolation.
    const moved = zonesOf("bullets").map((z) =>
      z.slotKey === "title" ? { ...z, x: 8, y: 12, w: 60, h: 18 } : z);
    await h.services.brands.update(h.userId, brand.id, {
      ...brandInput(),
      templates: { ...current.templates, bullets: { zones: moved } },
    });

    const deck = await h.services.decks.create(h.userId, { title: "Zones", brandId: brand.id });
    await h.services.decks.addSlide(h.userId, deck.id, {
      layoutId: "bullets", slots: slotsFor("bullets"),
    });
    const pkg = await unpack((await h.services.export.export(h.userId, deck.id, "pptx")).bytes);

    const inches = zoneToInches({ x: 8, y: 12, w: 60, h: 18 });
    expect(offsets(pkg.slides[0]!)).toContainEqual({
      x: Math.round(inches.x * EMU_PER_INCH), y: Math.round(inches.y * EMU_PER_INCH),
      cx: Math.round(inches.w * EMU_PER_INCH), cy: Math.round(inches.h * EMU_PER_INCH),
    });
  });
});

/**
 * Both cases here are regressions from the §2 step-13 fixture render — defects that the whole suite
 * above was green through, and that only became visible when a human looked at
 * `out/render/fixture-token/page-0*.png`. Both are asserted against the serialized XML so the eye is
 * needed once, not every time.
 */
describe("PptxExporter — regressions from the step-13 fixture render", () => {
  it("numbers a numbered list 1..n instead of restarting each item at 1", async () => {
    const h = harness();
    // `agenda` is the seed layout with `marker: "number"`; derived from the registry rather than
    // named so that a second numbered layout is covered automatically.
    const numbered = LAYOUTS.filter((l) => l.id === "agenda" || l.id === "closing");
    const { pkg } = await exportDeck(h, numbered.map((l) => l.id));

    for (const [i, layout] of numbered.entries()) {
      const items = Object.values(slotsFor(layout.id)).find(Array.isArray) as string[];
      const starts = [...pkg.slides[i]!.matchAll(/<a:buAutoNum[^>]*?startAt="(\d+)"/g)]
        .map((m) => Number(m[1]));

      // The defect emitted [1,1,1,…]: pptxgenjs writes `startAt` on EVERY numbered paragraph and
      // defaults it to 1, and in OOXML a `startAt` RESTARTS the sequence. The rendered agenda read
      // "1. 1. 1." while every assertion about paragraph counts and geometry stayed green.
      expect(starts, `${layout.id} numbering`).toEqual(items.map((_, n) => n + 1));
    }
  });

  it("keeps the accent rule clear of the title zone even when the title wraps", async () => {
    const h = harness();
    // Every layout that paints a rule above its title. Their zones are two lines tall, and the rule
    // used to carry a hardcoded `y` chosen for a ONE-line title — so a wrapped title (the common case
    // at full budget) was struck through by its own ornament.
    const ruled = ["title", "agenda", "bullets", "closing"];
    const { pkg, brandId } = await exportDeck(h, ruled);
    const brand = await h.services.brands.get(h.userId, brandId);

    for (const [i, layoutId] of ruled.entries()) {
      const layout = LAYOUTS.find((l) => l.id === layoutId)!;
      const title = resolveZones(brand, layout).zones.find((z) => z.slotKey === "title")!;
      const titleTopEmu = Math.round(zoneToInches(title).y * EMU_PER_INCH);

      // Identified as "short and narrow" rather than by exact geometry: the point of this test is the
      // RELATIONSHIP to the title zone, and hardcoding the rule's own coordinates here would just
      // reintroduce the duplicated number that caused the defect. `cy` is part of the filter so a tall
      // narrow shape (`quote`'s vertical rule) could never be mistaken for a horizontal one.
      const thin = offsets(pkg.slides[i]!).filter(isRuleShaped);
      expect(thin.length, `${layoutId}: expected an accent rule shape`).toBeGreaterThan(0);

      for (const rule of thin) {
        expect(rule.y + rule.cy, `${layoutId}: rule bottom must not reach the title zone`)
          .toBeLessThanOrEqual(titleTopEmu);
      }
    }
  });

  it("suppresses the rule in Templated mode, matching the preview", async () => {
    // §8: the preview draws ornaments only when token-styled, so the export must agree. A rule
    // stamped over a brand background is the "off-brand by accident" case templates exist to prevent.
    // Both requests differ ONLY in `backgroundsByLayoutId`, so the rule's absence cannot be explained
    // by anything else.
    const h = harness();
    const thin = (xml: string) => offsets(xml).filter(isRuleShaped).length;

    const slides = [slide("bullets", 0)];
    const tokenStyled = await unpack((await new PptxExporter()
      .export(await requestFor(h, slides))).bytes);

    const asset: ResolvedAsset = {
      id: "bg-1", url: "/api/assets/bg-1", contentType: "image/png",
      bytes: png(), width: 1920, height: 1080,
    };
    const templated = await unpack((await new PptxExporter()
      .export(await requestFor(h, slides, { backgroundsByLayoutId: { bullets: asset } }))).bytes);

    expect(thin(tokenStyled.slides[0]!)).toBeGreaterThan(0);
    expect(thin(templated.slides[0]!)).toBe(0);
  });
});

describe("PptxExporter — §1.1/C5 bullet paragraphs", () => {
  it("emits one paragraph per list item across every layout with a list slot", async () => {
    const h = harness();
    const listLayouts = LAYOUTS.filter((l) => l.slots.some((s) => s.type === "list" && s.required));
    const { pkg } = await exportDeck(h, listLayouts.map((l) => l.id));

    // At least `bullets`, `agenda`, `closing`, `two_column`, `stats` — asserted so a registry change
    // that dropped every list slot couldn't turn this into a vacuously passing test.
    expect(listLayouts.length).toBeGreaterThanOrEqual(4);

    for (const [i, layout] of listLayouts.entries()) {
      const slots = slotsFor(layout.id);
      const items = Object.values(slots).filter(Array.isArray).flat().length;
      const sps = shapes(pkg.slides[i]!);
      const bulletParas = sps.reduce((n, s) => n + s.bulletParas, 0);

      // `stats` renders its lists as card text, not bullets — so the assertion is the C5 *invariant*
      // (no bulleted box may collapse), not a fixed count. Every box that HAS bullets must have one
      // paragraph per item, which is what a collapse violates: 3 items would appear as 1.
      for (const sp of sps) {
        if (sp.bulletParas === 0) continue;
        expect(sp.bulletParas, `${layout.id}: a bulleted box has ${sp.bulletParas} paragraphs for `
          + `${sp.texts.length} runs — the §1.1/C5 collapse`).toBe(sp.texts.length);
      }
      // And no layout may lose items outright: every item's text is present somewhere on the slide.
      const text = allText(pkg.slides[i]!);
      for (const item of Object.values(slots).filter(Array.isArray).flat()) {
        expect(text, `${layout.id}: item "${item}" is missing from the slide`).toContain(item as string);
      }
      expect(bulletParas).toBeGreaterThanOrEqual(0);
    }
  });

  it("throws rather than silently collapsing when a layout bypasses the bullet helper", async () => {
    const h = harness();
    const exporter = new PptxExporter();
    const request = await requestFor(h, [
      slide("bullets", 0),
    ]);

    // A layout writing bullet runs WITHOUT `breakLine` — the exact C5 defect. Patched onto the registry
    // entry rather than added as a fixture layout, so the assertion is about the adapter's guard.
    const layout = LAYOUTS.find((l) => l.id === "bullets")!;
    const original = layout.toPptx;
    (layout as { toPptx: typeof original }).toPptx = (target) => {
      target.addText(
        ["A", "B", "C"].map((text) => ({ text, options: { bullet: true } })),
        { ...zoneToInches({ x: 8, y: 30, w: 84, h: 50 }), align: "left", fit: "none" },
      );
    };
    try {
      // Loud, not silent: the collapse leaves the text present, so a deck with silently merged lists
      // opens looking populated and the defect ships.
      await expect(exporter.export(request)).rejects.toThrow(/C5|breakLine/);
    } finally {
      (layout as { toPptx: typeof original }).toPptx = original;
    }
  });
});

describe("PptxExporter — §1.1/C3 backgrounds and masters", () => {
  it("defines ONE master and embeds ONE media part for a background shared by two layouts", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput());
    const { assetId } = await h.services.brands.addAsset(
      h.userId, brand.id, png(), background("bullets"));
    const current = await h.services.brands.get(h.userId, brand.id);
    await h.services.brands.update(h.userId, brand.id, {
      ...brandInput(),
      templates: {
        ...current.templates,
        bullets: { zones: zonesOf("bullets"), backgroundAssetId: assetId },
        closing: { zones: zonesOf("closing"), backgroundAssetId: assetId },
      },
    });

    const deck = await h.services.decks.create(h.userId, { title: "Shared", brandId: brand.id });
    // Four slides, two layouts, one background — the shape a brand with a single house image has.
    for (const layoutId of ["bullets", "closing", "bullets", "closing"]) {
      await h.services.decks.addSlide(h.userId, deck.id, { layoutId, slots: slotsFor(layoutId) });
    }
    const pkg = await unpack((await h.services.export.export(h.userId, deck.id, "pptx")).bytes);

    expect(pkg.slides).toHaveLength(4);
    // THE C3 assertion. pptxgenjs does not dedupe identical media, so four slide-level images would be
    // four copies of the bytes — 611 KB / 15 parts became 146 KB / 1 part in the §1.1 probe. One master
    // is only possible because `resolveRenderAssets` hands out the same object for both layouts.
    expect(pkg.media).toHaveLength(1);
    // One master for the one distinct background, shared by four slides across two layouts.
    expect(brandMasters(pkg)).toEqual(["bg-1"]);
  });

  it("defines a master per DISTINCT background, not per layout", async () => {
    const h = harness();
    const brand = await h.services.brands.create(h.userId, brandInput());
    const a = await h.services.brands.addAsset(h.userId, brand.id, png(), background("bullets"));
    // Distinct bytes, so this is genuinely a second image rather than the same one re-registered.
    const b = await h.services.brands.addAsset(
      h.userId, brand.id, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]), background("closing"));
    const current = await h.services.brands.get(h.userId, brand.id);
    await h.services.brands.update(h.userId, brand.id, {
      ...brandInput(),
      templates: {
        ...current.templates,
        bullets: { zones: zonesOf("bullets"), backgroundAssetId: a.assetId },
        closing: { zones: zonesOf("closing"), backgroundAssetId: b.assetId },
      },
    });

    const deck = await h.services.decks.create(h.userId, { title: "Two", brandId: brand.id });
    for (const layoutId of ["bullets", "closing", "bullets"]) {
      await h.services.decks.addSlide(h.userId, deck.id, { layoutId, slots: slotsFor(layoutId) });
    }
    const pkg = await unpack((await h.services.export.export(h.userId, deck.id, "pptx")).bytes);

    expect(pkg.media).toHaveLength(2);
    // Two masters for two distinct backgrounds — NOT three for three slides.
    expect(brandMasters(pkg)).toEqual(["bg-1", "bg-2"]);
  });

  it("falls back to a slide-level letterboxed image for a non-16:9 background (C2/C3)", async () => {
    const h = harness();
    const exporter = new PptxExporter();
    const request = await requestFor(h, [
      slide("bullets", 0),
    ], {
      backgroundsByLayoutId: {
        // 4:3. A master background always stretches (`<a:stretch><a:fillRect/>`, no `srcRect`), so using
        // one here would distort the brand's imagery — the export forfeits dedup for this asset instead.
        bullets: { id: "a1", contentType: "image/png", url: "/a1", bytes: png(), width: 1024, height: 768 },
      },
    });

    const pkg = await unpack((await exporter.export(request)).bytes);
    expect(brandMasters(pkg)).toEqual([]);        // no master was defined for it
    expect(pkg.media).toHaveLength(1);
    // `contain`: pillarboxed, centred, undistorted. 5.625 × (4/3) = 7.5in wide, so 1.25in of bar
    // on each side. The image is a `<p:pic>`, whose geometry these EMU describe.
    const pic = pkg.slides[0]!.match(/<p:pic>[\s\S]*?<\/p:pic>/)![0];
    const box = offsets(pic)[0]!;
    expect(box.cy).toBe(Math.round(SLIDE_16x9.height * EMU_PER_INCH));
    expect(box.cx).toBe(Math.round(7.5 * EMU_PER_INCH));
    expect(box.x).toBe(Math.round(1.25 * EMU_PER_INCH));
    expect(box.y).toBe(0);
  });

  it("degrades to token-styled rather than failing the export when bytes are missing (C4)", async () => {
    const h = harness();
    const exporter = new PptxExporter();
    const request = await requestFor(h, [
      slide("bullets", 0),
    ], {
      // pptxgenjs validates nothing (C4), so handing this to `addImage` would throw at `write()` — i.e.
      // fail the WHOLE deck at the very end. A token-styled slide is a complete slide.
      backgroundsByLayoutId: {
        bullets: { id: "a1", contentType: "image/png", url: "/a1", width: 1920, height: 1080 },
      },
    });

    const pkg = await unpack((await exporter.export(request)).bytes);
    expect(pkg.media).toHaveLength(0);
    expect(brandMasters(pkg)).toEqual([]);
    // The content still exported — that is the whole point of degrading rather than throwing.
    expect(allText(pkg.slides[0]!)).toContain("Alpha items 1");
  });
});

describe("PptxExporter — logos", () => {
  it("picks the light logo on a dark background and the dark on a light one", () => {
    const asset = (id: string) => ({ id, contentType: "image/png" as const, url: `/${id}` });
    const light = asset("light");
    const dark = asset("dark");

    // Chosen by computed luminance, not a user setting — the light mark is the one designed to sit on
    // a dark surface, and `compileTheme` already treats legibility as computed rather than declared.
    expect(pickLogo({ light, dark }, "0B0B14")).toBe(light);
    expect(pickLogo({ light, dark }, "FFFFFF")).toBe(dark);
    // One variant only: used regardless of fit. A logo in the wrong variant is a visible imperfection;
    // a missing logo reads as a broken export.
    expect(pickLogo({ dark }, "0B0B14")).toBe(dark);
    expect(pickLogo({ light }, "FFFFFF")).toBe(light);
    expect(pickLogo(undefined, "FFFFFF")).toBeUndefined();
  });

  it("places a logo on token-styled slides and suppresses it under a brand background", async () => {
    const h = harness();
    const exporter = new PptxExporter();
    const logo = {
      id: "logo", contentType: "image/png" as const, url: "/logo",
      bytes: png(), width: 200, height: 100,
    };
    const slides = [
      slide("bullets", 0),
    ];

    const tokenStyled = await unpack((await exporter.export(
      await requestFor(h, slides, { logos: { light: logo } }))).bytes);
    expect(tokenStyled.media).toHaveLength(1);
    // 2:1 at 9% of slide height → 0.50625in tall, 1.0125in wide.
    const box = offsets(tokenStyled.slides[0]!.match(/<p:pic>[\s\S]*?<\/p:pic>/)![0])[0]!;
    expect(box.cx / box.cy).toBeCloseTo(2, 5);

    const templated = await unpack((await exporter.export(await requestFor(h, slides, {
      logos: { light: logo },
      backgroundsByLayoutId: {
        bg: { id: "bg", contentType: "image/png", url: "/bg", bytes: png(), width: 1920, height: 1080 },
        bullets: { id: "bg", contentType: "image/png", url: "/bg", bytes: png(), width: 1920, height: 1080 },
      },
    }))).bytes);
    // Suppressed under a brand background, for the same reason accent rules are: the background almost
    // always contains the logo already, and a second copy stamped on top is off-brand by accident.
    expect(templated.media).toHaveLength(1);
    expect(templated.slides[0]).not.toMatch(/<p:pic>/);
  });
});

describe("PptxExporter — the port contract", () => {
  it("reports the format and content type the download route needs", async () => {
    const h = harness();
    const exporter = new PptxExporter();
    expect(exporter.format).toBe("pptx");

    const result = await exporter.export(await requestFor(h, [
      slide("bullets", 0),
    ]));
    expect(result.contentType).toBe(PPTX_CONTENT_TYPE);
    // Derived from the deck title via the shared sanitizer — the same one `ExportService` uses for
    // `Content-Disposition`, which is why it lives in `lib/util/filename.ts` and not in either layer.
    expect(result.filename).toBe("Fixture.pptx");
  });
});
