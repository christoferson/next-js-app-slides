# VERIFICATION.md

Record of gating-spike results per `CLAUDE.md` §1. Each entry states what was proven,
how, and what remains `⚠️ VERIFY`.

---

## §1.1 pptxgenjs spike — **PASSED (with 5 constraints on the design)**

**Date:** 2026-07-25 (OOXML gate) · **2026-07-26** (render gate, after LibreOffice install)
**Pinned version:** `pptxgenjs@4.0.1` (exact; API names have shifted across majors — do not float this)
**Node:** v22.14.0 · **Platform:** win32 10.0.19045
**Renderer:** LibreOffice 26.2.5.2 (headless → PDF → pdfjs raster)
**Harness:** `npm run verify:pptx:all` + `npm run verify:pptx:render` + `npm run verify:fonts` (re-runnable; green)

### Method

Eyeballing a deck proves little, so the spike asserts geometry **from the OOXML itself**:
`scripts/verify-pptx.ts` builds a deck exercising every capability, then
`scripts/verify-pptx-assert.ts` unzips it and compares `<a:off>` / `<a:ext>` EMU values
against the percent→inch math (914400 EMU/inch). 48/48 checks pass.
`scripts/verify-pptx-thirdparty.ts` re-reads the package with an unrelated parser
(`officeparser`) to catch structurally-broken output our own regexes would accept.

**Render gate** (added 2026-07-26): `scripts/render-pptx.ts` converts the deck with headless
LibreOffice and rasterizes every page, so the visual checks are repeatable and diffable rather
than dependent on someone's memory of what they saw. LibreOffice is an **independent
implementation** of the same spec, so its agreement with our EMU assertions is real corroboration
— but it is **not PowerPoint** (see ⚠️ VERIFY #1). This gate caught a real bug the OOXML
assertions had passed (C5), which is precisely why it was worth doing.

### Capability results

| # | Capability | Result | Evidence |
|---|---|---|---|
| 1 | Custom 16:9 layout (`defineLayout` 10×5.625in) | ✅ | `<p:sldSz cx="9144000" cy="5143500">`, ratio 1.777778 exactly |
| 2 | Full-bleed background image | ✅ | `off=(0,0)`, `ext=(9144000,5143500)` — pixel-exact to slide extent |
| 3 | Text box at percent-derived coords | ✅ | **worst delta across all 5 probe zones = 0 EMU** |
| 4 | `align` / `valign` | ✅ | left/center/right → `algn="l|ctr|r"`; top/middle/bottom → `anchor="t|ctr|b"` |
| 5 | Bullets, itemized runs, nesting | ✅ **but see C5** | `<a:buChar>`, `<a:buAutoNum>`, `lvl="1"` — requires `breakLine` per item |
| 6 | Server-side buffer output | ✅ | `write({outputType:"nodebuffer"})` → real `Buffer` |
| 7 | Logo image in a corner | ✅ | second `<p:pic>` at declared offset |
| 8 | Speaker notes | ✅ | `ppt/notesSlides/notesSlide1.xml` with the text |
| 9 | CJK (`日本語も確認`) | ✅ | round-trips unescaped in `<a:t>`; `<a:ea>` typeface set too (see C1) |
| 10 | Token-styled path (no bg image) | ✅ | `<p:bg>` solid fill + `addShape('rect')` accent bar |
| 11 | Both render modes in ONE deck | ✅ | templated slides → master layout; token slides → own `<p:bg>` (probe O) |
| 12 | 15-slide deck timing | ✅ | 23–129 ms to buffer — nowhere near a concern |
| 13 | Base64 (`data:`) image input | ✅ | works for slide images AND master backgrounds — **no filesystem paths needed**, so §6.4 (ports must not return fs paths) holds |

**Zone model is sound as specified.** Percent→inch→EMU is exact, so `resolveZones()` can be
shared verbatim between the React preview and `toPptx` (§8) with no fudge factors.

### Render-gate results (LibreOffice 26.2.5.2 · `out/render/page-*.png`)

Every `CONFIRM:` line in `out/OPEN-TEST.pptx` (21 slides) was checked against the rasterized page.

| §1.1 checklist item | Result | What the render showed |
|---|---|---|
| Background truly full-bleed at 16:9, no white margins | ✅ | The fixture's magenta 1%-inset border touches all four page edges; corner markers all present |
| Text lands where the percent math says | ✅ | Slide 2 draws each zone's outline at the same coordinates as its label — every label sits inside its box, at the stated corner |
| `align` / `valign` behave as expected | ✅ | left/center/right and top/middle/bottom all correct, incl. the right+bottom sidebar and centered footer |
| Bullets render | ⚠️ → ✅ | **Initially FAILED** — three items collapsed onto one line with a single bullet. Root-caused to C5; after the `breakLine` fix: three bullets, one nested/indented, one numbered `1.` |
| Long text doesn't silently overflow | ✅ (confirms C1) | Text spills visibly above *and* below both boxes; `fit:'shrink'` behaved identically to `fit:'none'` — no shrinking, exactly as C1 predicted |
| CJK renders | ✅ | `日本語も確認` renders correctly, no tofu |
| Each font's `pptxName` renders (not silently substituted) | ✅ 15/16 | See the Fonts section — only `Aptos` substituted |
| Letterbox places the image without distortion | ✅ | 4:3 asset pillarboxed with symmetric black bars; grid cells square, not stretched |
| Token-styled path (solid bg + accent bar, no image) | ✅ | Correct |
| Logo image in a corner | ✅ | Present at its declared offset |

### The 5 constraints the design must absorb

These are library facts, verified in source and output — not blockers, but the exporter must
be written around them.

#### C1 — `fit:'shrink'` is inert at export time (affects truncation budgets)

`fit:'shrink'` emits `<a:normAutofit/>` **with no `fontScale` attribute**. The library's own
typings say it plainly (`types/index.d.ts` ~L1810): *"There is no way for this library to
trigger that behavior."* PowerPoint computes the scale factor only when a user edits or
resizes the shape — so **on first open, over-long text overflows its box** rather than shrinking.

`fit:'none'` emits no autofit element at all; text silently spills past the box with no clipping.

→ **Truncation must be enforced in our code, not delegated to PowerPoint.** This makes the
§9 `trimmed` flag load-bearing rather than cosmetic. First-cut budgets from measured box
widths (avg advance ≈ 0.5em) are in `scripts/verify-pptx-probe2.ts` probe C — e.g. a 60%-wide
title at 28pt holds ~30 chars/line; a 52%×34% bullets zone at 16pt holds ~46 chars × 7 lines.
Calibrate `SlotSpec.maxChars` against these, then re-check on the real fonts.

Also note `shrinkText` (used in the CLAUDE.md §1.1 example snippet) is **deprecated** in 4.0.1
in favour of `fit`. The example should be updated.

#### C2 — Native `sizing: {type:'contain'|'cover'}` is unusable; use explicit letterbox math

The library derives its aspect ratios from the **declared `w`/`h`**, not the image's intrinsic
pixels (`dist/pptxgen.cjs.js`: `ImageSizingXml` ~L5056 + call site ~L5560). Consequences:

- `sizing:{type:'contain', w:10, h:5.625}` on a 4:3 source produced `srcRect="0,0,0,0"` and a
  **stretched, distorted** 16:9 image — it did not letterbox.
- A mismatched box (`w:4,h:5`) produced `srcRect t="-61111" b="-61111"` — **negative crop
  values, invalid OOXML**.

→ Do **not** use `sizing`. `scripts/letterbox.ts` implements `placeBackground()` +
`imageSize()` (PNG/JPEG intrinsic dimensions, no image dependency) and is table-tested in
`scripts/verify-pptx-letterbox-test.ts` — 7 aspect cases (16:9, near-16:9, 4:3, 21:9, 9:16,
contain/cover/stretch), all centred, aspect preserved, and proven end-to-end to serialize with
no negative `srcRect`. Near-16:9 (within 0.5%) snaps to full-bleed; sub-1% distortion is the
deliberate trade. **Documented choice for §8: `contain` (pillarbox/letterbox), `letterboxed: true`
drives the amber badge.**

#### C3 — Media is NOT deduplicated; put brand backgrounds on slide masters

`addImage` embeds a **separate copy per slide**, even for a byte-identical `path` or `data:`
string. Measured with a 33 KB 1920×1080 background over 15 slides:

| Approach | Deck size | Media parts |
|---|---|---|
| `addImage` per slide (`path`) | 611 KB | 15 (1 distinct) |
| `addImage` per slide (`data:`) | 611 KB | 15 (1 distinct) |
| **`defineSlideMaster({background})`** | **146 KB** | **1** |

→ **The exporter must define one slide master per distinct brand template background**
(`defineSlideMaster({title, background:{data}})`, slides added with `{masterName}`). Verified:
3 distinct backgrounds over 15 slides → exactly 3 media parts; zone text geometry is
**unaffected** by using a master (still EMU-exact); base64 masters work; templated and
token-styled slides coexist in one deck.

Caveat: a master background **always** stretches to the slide (`<a:stretch><a:fillRect/>`, no
`srcRect`). So a non-16:9 asset would be **distorted** as a master background — such assets
must fall back to slide-level `addImage` with C2's contain math, forfeiting dedup for that
asset. Acceptable: non-16:9 uploads are the warned edge case, not the norm.

#### C4 — Zero input validation; our zod schemas are the only guard

- Out-of-bounds zones are **not clamped**: a zone at `x:90,w:40` serialized to `off.x=8229600`
  with `ext.cx=3657600` — i.e. 1.9 in off the right edge of a 10 in slide. Negative coords pass
  through as negative EMU.
  → §1.1's requirement that brand-schema zod enforce `0..100` non-degenerate bounds is
  **load-bearing**, not belt-and-braces.
- Unknown `fontFace` is written verbatim with no error (PowerPoint substitutes silently).
- A missing image path **throws** at `write()` time (`ERROR: Unable to read media: …`) — so the
  exporter must resolve assets defensively; one dangling `backgroundAssetId` otherwise fails
  the entire export, not one slide.
- Every slide gets a `notesSlide` part even with no `addNotes` call (19 of 20 empty in the
  probe deck) — harmless, just deck-size noise.

#### C5 — A shape-level `align` silently destroys bullet lists unless every item sets `breakLine`

**Found by the render gate, missed by the OOXML assertions** — those checked that `<a:buChar>`,
`<a:buAutoNum>` and `lvl="1"` were *emitted somewhere*, not that they were attached to
*separate paragraphs*. The rendered page showed all three items run together on one line.

Cause (`dist/pptxgen.cjs.js` "STEP 5: Group textObj into lines", ~L6186):

```js
if (arrTexts.length > 0 && (textObj.options.align || opts.align)) {
    if (textObj.options.align !== arrTextObjects[idx - 1].options.align) { /* new paragraph */ }
}
else if (arrTexts.length > 0 && textObj.options.bullet) { /* new paragraph */ }
```

The bullet branch is an **`else if`**. A shape-level `align` makes the first condition true for
every run, so the bullet branch never executes — and because per-run `align` is `undefined`
everywhere, the "align changed" test never fires either. Result: all runs land in **one `<a:p>`**.
Measured on the pre-fix deck: `1 paragraph, 3 runs, 1 <a:buChar>` — items 2 and 3 lost their
`indentLevel` and their numbered-bullet type **with no warning**.

This is not an edge case: `SlotZone` carries `align`, so **every** bullets slot rendered through
the zone model would have hit it.

→ **Fix: set `breakLine: true` on every bullet item's options.** That path (branch C) runs
unconditionally after the if/else-if, so paragraphs split regardless of align.
`scripts/verify-bullets3.ts` proves it holds for `align: left | center | right` and for no
align at all — 3 paragraphs, 3 bullets, nesting and numbering preserved in every case.
The bisect that isolated it (`verify-bullets2.ts`) also cleared `color`, `margin`, `valign`
and `fit` of involvement.

→ **The exporter must own this**, not each layout's `toPptx`: build bullet runs through one
shared helper that always stamps `breakLine`, so a new layout can't reintroduce the bug.
Add an export-time assertion that a bullets slot with *n* items produced *n* `<a:p>` elements.

### Fonts

All 16 candidate `pptxName` values are written verbatim into the OOXML —
**pptxgenjs performs no substitution or validation of its own** (`dist/pptxgen.cjs.js` L5963
sets `<a:latin>`, `<a:ea>`, and `<a:cs>` all to the given name, which also means one
`fontFace` covers CJK runs; no separate East-Asian font control is available or needed).

Candidate registry: `scripts/fonts-candidates.ts` (SPEC.md calls for a "curated registry with
PPTX-safe mappings" but does not enumerate it — this is the **proposal**, not yet ratified).
15 of 16 are installed on this dev machine; `Aptos` is not.

**Font embedding is not supported by pptxgenjs** (no `embedFont`/`fntdata` anywhere in the
dist), so substitution risk cannot be eliminated in-library — only managed by choosing
widely-installed faces. Substitution is a **render-time** behaviour, invisible in the XML;
it can only be cleared by the human open-test below.

#### Substitution measured: 15 of 16 honoured

`scripts/verify-font-substitution.ts` (`npm run verify:fonts`) renders one slide per candidate
at identical geometry plus a deliberately-missing control font (`ZZ_NoSuchFont_ZZ`), converts
via LibreOffice, then reads the **`/BaseFont` descriptors embedded in the PDF**. That is the
authoritative signal: the renderer embeds the *resolved, post-substitution* face and names it,
so "asked for Aptos, got ArialUnicodeMS" is the substitution stated by the renderer itself.
Bitmap comparison against the control corroborates it.

| Tier | Entries | Requested → embedded | Verdict |
|---|---|---|---|
| `core` | Arial, Georgia, Verdana, Tahoma, Times New Roman, Trebuchet MS, Courier New | ArialMT, Georgia, Verdana, Tahoma, TimesNewRomanPSMT, TrebuchetMS, CourierNewPSMT | ✅ all honoured |
| `office` | Calibri, Cambria, Candara, Constantia, Corbel, Franklin Gothic Book, Garamond | Calibri, Cambria, Candara, Constantia, Corbel, FranklinGothic-Book, Garamond | ✅ all honoured |
| `risky` | Segoe UI | SegoeUI | ✅ honoured (Windows; expect substitution on macOS) |
| `risky` | **Aptos** | *not embedded* → **ArialUnicodeMS** | ❌ **SUBSTITUTED** |

`Aptos` is not installed on this machine, so this confirms the prediction from the installed-font
enumeration and also confirms the detector works (it correctly flags the one font that is absent,
and its bitmap matches the bogus control's). The only fallback face present in the whole PDF is
`ArialUnicodeMS`, which no candidate requested.

→ **Recommendation: drop `aptos` from the proposed `FONTS` registry** per §14 ("a FONTS entry
has no PowerPoint-safe `pptxName` that survives the open-test"). It is a new Office 2024 default,
so it will be missing on any older Office, LibreOffice, and Google Slides. `segoe_ui` survives
here but is Windows-only — keep it flagged, or drop it too if cross-platform fidelity matters
more than having 16 entries.

#### Mitigation while the PowerPoint open-test is deferred (⚠️ VERIFY #1)

Substitution is the only deferred unknown with real product impact — a substituted font is a
visibly off-brand deck, which contradicts the "on-brand by construction" guarantee. It can be
mostly retired **by decision rather than by testing**:

→ **Ship the 7 `core` entries; gate `office` + `risky` behind the open-test.** Arial, Georgia,
Verdana, Tahoma, Times New Roman, Trebuchet MS and Courier New have shipped with both Windows
and Mac Office for ~two decades and are the least likely to surprise. The `office` tier is
*probably* fine on any real Office install — but "probably" is exactly what the open-test is for,
and 7 fonts is not a limiting palette for a first release.

This is a **product call, not a verification finding** — `FONT_CANDIDATES` is left intact and
unratified (⚠️ VERIFY #2). Record the decision here when made.

Belt-and-braces regardless of tier: because pptxgenjs cannot embed fonts and writes any
`fontFace` verbatim (C4), a substituted font is **undetectable at export time**. If per-font
fidelity guarantees are ever needed, the only mechanisms are (a) restricting the registry, or
(b) rendering text to images — the latter defeats editability and is not recommended.

### ⚠️ VERIFY — open

1. **The render gate is cleared on LibreOffice, NOT on PowerPoint.** All §1.1 visual checks now
   pass against LibreOffice 26.2.5.2 (table above), which is independent-implementation evidence
   and caught a real bug (C5). But PowerPoint itself is still not installed here, so these remain
   **PowerPoint-unverified**:
   - **Font substitution on Office's own font stack** — LibreOffice resolved 15/16 using the
     system fonts; PowerPoint on **macOS** is the expected divergence (`Segoe UI`, `Aptos`).
     Google Slides is a third distinct resolver.
   - **`fit:'shrink'` behaviour on click/edit** — C1's claim that PowerPoint computes `fontScale`
     only on user interaction is from the library's own typings, not observed. Either way our
     code must truncate, so this doesn't change the design.
   - **Speaker-notes pane** — the notes part exists in the OOXML; PDF conversion doesn't show it.
   → `out/OPEN-TEST.pptx` + `npm run verify:pptx:render` are the reusable harness. Re-run the
   deck on a machine with real PowerPoint (ideally Keynote + Google Slides too) and append results.

   **DEFERRED, NOT WAIVED — decision 2026-07-26.** No PowerPoint is available, so this item is
   carried forward rather than blocking §2. Justification: none of the three unverified items can
   invalidate the zone model or the exporter design — the first changes only *which entries sit in
   the `FONTS` array*, the second can only behave better than C1 already assumes, and the third is
   present in the OOXML and read back by officeparser. No §14 stop-and-ask trigger fired. Risk is
   contained by the font mitigation below, and geometry — the part that *would* force rework — is
   confirmed by two independent implementations.

   **This blocks the §13 Definition-of-Done checkbox "export opened in real PowerPoint."** That box
   stays unchecked until this runs. Do it before any release a user's PowerPoint will open; it is
   not a prerequisite for building layouts, services, or routes.

   Cheap partial closure without an install: upload the deck to **PowerPoint on the web**
   (Microsoft's own OOXML implementation — strong on layout, only partial on fonts, since web font
   availability differs from desktop) and to **Google Slides** (a third independent resolver, and
   the likeliest to expose font problems). Agreement across all three narrows the residual
   desktop-PowerPoint risk to font substitution alone.
2. **`FONT_CANDIDATES` is a proposal**, not a ratified registry — the `webStack` values (browser
   preview approximations) have had no visual comparison against their `pptxName` counterparts.
   Do that when the browser preview exists (§8).
3. **Char budgets in C1 are arithmetic estimates**, not measured text metrics. The render
   confirmed overflow happens but wasn't used to calibrate per-font budgets. Re-derive from the
   rendered pages or a font-metrics library if tighter budgets matter.
4. **Substitution results are machine-specific.** `verify:fonts` measures *this* machine's
   installed fonts; it is a regression harness, not a portable guarantee. Re-run it per target
   environment.

### Files

```
scripts/zone-math.ts                    percent→inch→EMU (shared by preview + export, §8)
scripts/letterbox.ts                    placeBackground() + imageSize() — replaces `sizing` (C2)
scripts/fonts-candidates.ts             proposed FONTS registry under test
scripts/make-fixtures.ts                dependency-free PNG fixtures (grid + edge markers)
scripts/verify-pptx.ts                  capability deck
scripts/verify-pptx-assert.ts           OOXML assertions (48 checks)
scripts/verify-pptx-probe2.ts           CJK typefaces · native sizing · char budgets
scripts/verify-pptx-probe3.ts           deck scale · base64 input · failure modes · negative srcRect
scripts/verify-pptx-probe4.ts           media duplication + master mitigation
scripts/verify-pptx-probe5.ts           multi-master · base64 master · stretch caveat · mixed deck
scripts/verify-pptx-letterbox-test.ts   letterbox table test + end-to-end OOXML proof
scripts/verify-pptx-thirdparty.ts       independent-reader check (officeparser)
scripts/verify-pptx-opentest.ts         builds out/OPEN-TEST.pptx (21 slides, self-describing)
scripts/render-pptx.ts                  pptx → LibreOffice → PDF → per-page PNG (the render gate)
scripts/render-pdf-pages.ts             PDF → PNG rasterizer (pdfjs + @napi-rs/canvas)
scripts/verify-font-substitution.ts     objective substitution detector via PDF /BaseFont
scripts/verify-bullets.ts               bullet-form comparison (4 candidate shapes)
scripts/verify-bullets2.ts              bisect that isolated `align` as the cause of C5
scripts/verify-bullets3.ts              proves `breakLine` fixes C5 under every align value
scripts/inspect-bullets.ts              dumps a slide's paragraph/bullet structure
```

`npm run verify:pptx:all` re-runs the OOXML gate. `npm run verify:pptx:opentest` rebuilds the
deck; `npm run verify:pptx:render` renders it to PNGs; `npm run verify:fonts` re-measures
substitution; `npm run verify:bullets` guards C5.

### Carry into implementation

- `zone-math.ts` and `letterbox.ts` are the §8 "one shared util, two consumers" — move them to
  `lib/layouts/` (or `lib/export/`) rather than reimplementing.
- Exporter: one `defineSlideMaster` per distinct background (C3); slide-level `addImage` +
  `placeBackground` only for non-16:9 assets.
- Never use `sizing` (C2); never rely on `fit:'shrink'` to save over-long text (C1).
- **Build bullet runs through one shared helper that always sets `breakLine: true` (C5)**, and
  assert paragraph count at export time — a per-layout `toPptx` writing its own bullet runs will
  silently reintroduce the collapse.
- Drop `aptos` from the FONTS registry; keep `segoe_ui` flagged as Windows-only.
- Keep the render gate in CI-ish reach: it caught C5 when 48 OOXML assertions did not. Structural
  assertions verify what we thought to check; the raster verifies what the user sees.
- Pin `pptxgenjs@4.0.1` exactly.

---

## §1.2 Bedrock spike — NOT RUN
## §1.3 Environment sanity — NOT RUN

Neither was in scope for this pass.
