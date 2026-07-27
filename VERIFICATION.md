# VERIFICATION.md

Record of gating-spike results per `CLAUDE.md` §1. Each entry states what was proven,
how, and what remains `⚠️ VERIFY`.

---

## §1.1 pptxgenjs spike — **PASSED (with 5 constraints on the design)**

**Date:** 2026-07-25 (OOXML gate) · **2026-07-26** (render gate, after LibreOffice install)
**Pinned version:** `pptxgenjs@4.0.1` (exact; API names have shifted across majors — do not float this)
**Node:** v22.14.0 · **Platform:** win32 10.0.19045
**Renderers:** LibreOffice 26.2.5.2 (headless → PDF → pdfjs raster, automated) ·
PowerPoint on the web / onedrive.live.com (manual, 2026-07-26 — "looks good")
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
implementation** of the same spec, so its agreement with our EMU assertions is real corroboration.
This gate caught a real bug the OOXML assertions had passed (C5), which is precisely why it was
worth doing.

The deck was then opened manually in **PowerPoint on the web** (onedrive.live.com) — Microsoft's
own OOXML implementation — and reported good. That makes **three independent renderers agreeing**
on geometry: our EMU assertions → LibreOffice → PowerPoint Online. What the web app cannot settle
is desktop-Office font substitution (see ⚠️ VERIFY #1).

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
**Corroborated 2026-07-26 by PowerPoint on the web** (onedrive.live.com), which opened the same
deck cleanly — no repair prompt, layout reported good — so every geometry row below now has two
independent renderers behind it, one of them Microsoft's.

| §1.1 checklist item | Result | What the render showed |
|---|---|---|
| Background truly full-bleed at 16:9, no white margins | ✅ | The fixture's magenta 1%-inset border touches all four page edges; corner markers all present |
| Text lands where the percent math says | ✅ | Slide 2 draws each zone's outline at the same coordinates as its label — every label sits inside its box, at the stated corner |
| `align` / `valign` behave as expected | ✅ | left/center/right and top/middle/bottom all correct, incl. the right+bottom sidebar and centered footer |
| Bullets render | ⚠️ → ✅ | **Initially FAILED** — three items collapsed onto one line with a single bullet. Root-caused to C5; after the `breakLine` fix: three bullets, one nested/indented, one numbered `1.` |
| Long text doesn't silently overflow | ✅ (confirms C1) | Neither `fit` value saves over-long text. `fit:'none'` spills far past the box; `fit:'shrink'` **clips** at the boundary in LibreOffice (both unacceptable). User confirmed in PowerPoint Online that clicking into a `fit:'shrink'` box does **not** shrink it — C1 revised accordingly |
| CJK renders | ✅ | `日本語も確認` renders correctly, no tofu |
| Each font's `pptxName` renders (not silently substituted) | ✅ 15/16 | See the Fonts section — only `Aptos` substituted |
| Letterbox places the image without distortion | ✅ | 4:3 asset pillarboxed with symmetric black bars; grid cells square, not stretched |
| Token-styled path (solid bg + accent bar, no image) | ✅ | Correct |
| Logo image in a corner | ✅ | Present at its declared offset |

### The 5 constraints the design must absorb

These are library facts, verified in source and output — not blockers, but the exporter must
be written around them. C1 and C5 are the two that will bite silently if forgotten.

#### C1 — `fit:'shrink'` NEVER shrinks; truncation is the only lever we have

**Strengthened 2026-07-26 after user testing in PowerPoint on the web and a dedicated probe
(`scripts/verify-autofit.ts` / `npm run verify:autofit`).** The original wording said PowerPoint
would shrink the text "on click/edit". **That is wrong — it does not.** The user clicked into the
`fit:'shrink'` box and the text stayed overflowing, identical to `fit:'none'`.

What is actually going on, in three parts:

1. **pptxgenjs deliberately emits a scale-less flag.** `fit:'shrink'` produces a bare
   `<a:normAutofit/>` — the `fontScale`/`lnSpcReduction` attributes that do the actual shrinking
   are **commented out in the library source** (`dist/pptxgen.cjs.js` L6067), with the note
   *"Shrink does not work automatically - PowerPoint calculates the fontScale value dynamically
   upon resize."* So the element says "shrink-on-overflow is enabled" but carries no amount.
2. **Renderers do not compute the missing scale on open, and PowerPoint Online does not compute it
   on click either** (user-verified). Treat "PowerPoint will work it out" as **false**.
3. **The attributes ARE honoured when actually present.** Injecting `fontScale="62500"` into the
   ZIP by hand made LibreOffice render the text visibly smaller and **fit inside the box**. So the
   OOXML mechanism works; pptxgenjs simply never populates it.

| Slide (probe) | Element emitted | LibreOffice result |
|---|---|---|
| 1 | `<a:normAutofit/>` (what `fit:'shrink'` gives) | overflows — **no shrink** |
| 2 | `<a:normAutofit fontScale="62500"/>` (injected) | **fits** — text scaled down |
| 3 | `+ lnSpcReduction="20000"` (injected) | **fits** — scaled, tighter leading |
| 4 | none (`fit:'none'`) | overflows, spills far past the box |

**Renderer divergence worth knowing:** with a bare `<a:normAutofit/>`, LibreOffice **clips** the
overflow at the box boundary (OPEN-TEST slide 3, right box: text is cut off at the green outline),
whereas `fit:'none'` **spills** visibly past it. PowerPoint Online overlapped in both cases per the
user's report. So the *presence* of `normAutofit` changes overflow handling from spill to clip in at
least one renderer — but **neither behaviour is acceptable output**: one loses content silently, the
other collides with neighbouring zones.

→ **Truncation must be enforced in our code. There is no fallback.** This makes the §9 `trimmed`
flag load-bearing rather than cosmetic — it is the *only* thing standing between an over-long LLM
response and a broken slide. First-cut budgets from measured box widths (avg advance ≈ 0.5em) are
in `scripts/verify-pptx-probe2.ts` probe C — e.g. a 60%-wide title at 28pt holds ~30 chars/line;
a 52%×34% bullets zone at 16pt holds ~46 chars × 7 lines. Calibrate `SlotSpec.maxChars` against
these, then re-check on the real fonts.

→ **Optional hardening, available because of finding 3:** the exporter *could* post-process its own
output to inject a computed `fontScale` as a second line of defence for the case where our
character budget still underestimates (e.g. an unexpectedly wide font). Not needed if truncation is
correct, and it means hand-editing the ZIP, so treat it as a contingency — but it is proven to work
and worth remembering rather than rediscovering.

→ **Set `fit:'none'` explicitly, not `'shrink'`.** `'shrink'` promises behaviour it does not deliver
and invites exactly the false assumption recorded here. If clipping is ever preferred over spilling,
that is a deliberate choice to document, not a side effect to inherit.

Also note `shrinkText` (used in the CLAUDE.md §1.1 example snippet) is **deprecated** in 4.0.1
in favour of `fit` — and emits the same scale-less `<a:normAutofit/>` (L6076), so it is equally
inert. CLAUDE.md §1.1 has been corrected.

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
   - ~~**`fit:'shrink'` behaviour on click/edit**~~ — **RESOLVED 2026-07-26, no longer open.** The
     user tested it in PowerPoint on the web: clicking into the box does **nothing**, text still
     overlaps. The "shrinks on click" claim was wrong; C1 is revised and strengthened. Desktop
     PowerPoint could in principle differ, but since our code must truncate either way, this no
     longer affects the design.
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

   **PARTIAL CLOSURE — 2026-07-26: PowerPoint on the web (onedrive.live.com) opened the deck and
   the user reports it "looks good."** This is Microsoft's own OOXML implementation, so it is the
   strongest evidence available without a desktop install, and it is the **third** independent
   renderer to agree (our EMU assertions → LibreOffice → PowerPoint Online). What it clears and
   what it does not:

   | §1.1 item | Cleared by PowerPoint Online? |
   |---|---|
   | Full-bleed background, zone positions, `align`/`valign`, bullets/nesting, CJK, letterbox, token-styled path | ✅ **Yes** — same renderer family as desktop for layout; Microsoft's own reader accepted the package without repair prompts |
   | Package validity / no corruption | ✅ **Yes** — a malformed part would trigger PowerPoint's repair dialog |
   | Font availability on the **Office** font set | ⚠️ **Partly** — the web app serves fonts from Microsoft's cloud service, so it has the full Office set (incl. `Aptos`). It therefore shows the *best case*, not what a user with an older/minimal Office install sees. `Aptos` rendering here does **not** overturn the LibreOffice substitution finding. |
   | Font substitution on **macOS desktop** PowerPoint | ❌ **No** — still the main open risk (`Segoe UI`, `Aptos`) |
   | `fit:'shrink'` on click/edit | ✅ **Yes — answered, negatively.** Clicking in does nothing; text still overlaps. See revised C1 |
   | Speaker-notes pane | ❌ **Not reported** — worth a glance in the web app's notes pane |

   → Residual risk is now **font substitution on a desktop Office install (especially macOS)**,
   plus the two cosmetic items above. Geometry is confirmed by three independent implementations
   and can be considered closed. Keep the §13 checkbox unchecked for the desktop open-test, but
   the deferral is now materially lower-risk than when it was recorded.

   Remaining cheap step: **Google Slides** — a genuinely different resolver with a different font
   set, and the likeliest of any to expose substitution.

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
scripts/verify-autofit.ts               proves fit:'shrink' never shrinks, but fontScale IS honoured (C1)
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
- Never use `sizing` (C2). **Never rely on `fit:'shrink'` — it never shrinks (C1, user-verified).**
  Set `fit:'none'` explicitly and truncate in our own code; the `trimmed` flag is the only guard.
- **Build bullet runs through one shared helper that always sets `breakLine: true` (C5)**, and
  assert paragraph count at export time — a per-layout `toPptx` writing its own bullet runs will
  silently reintroduce the collapse.
- Drop `aptos` from the FONTS registry; keep `segoe_ui` flagged as Windows-only.
- Keep the render gate in CI-ish reach: it caught C5 when 48 OOXML assertions did not. Structural
  assertions verify what we thought to check; the raster verifies what the user sees.
- Pin `pptxgenjs@4.0.1` exactly.

---

## §1.2 Bedrock spike — **PASSED**

**Date:** 2026-07-26 · **Account:** 916902469227 (`b2b-sandbox-admin`) · **Region:** `us-east-1`
**Harness:** `npm run verify:bedrock` (+ `verify:bedrock:models`, `verify:bedrock:errors`)
**SDK:** `@aws-sdk/client-bedrock-runtime` ^3.1095.0

### 1. Model ID — VERIFIED INVOCABLE

```
DEFAULT_LLM_MODEL_ID=us.anthropic.claude-opus-5
```

Chosen by the user (Opus 5). Confirmed present and `ACTIVE`, and confirmed **actually invoked**
(not merely listed) — round-trip 1849 ms for a 4-token reply.

**⚠️ Critical finding: every Anthropic model in this account is `INFERENCE_PROFILE`-only.** None
support `ON_DEMAND`. The bare model id therefore **fails**:

```
anthropic.claude-opus-5      → ValidationException 400
  "Invocation of model ID anthropic.claude-opus-5 with on-demand throughput isn't supported.
   Retry your request with the ID or ARN of an inference profile that contains this model."
us.anthropic.claude-opus-5   → works
```

→ The model registry must store the **prefixed inference-profile id** (`us.` or `global.`), and
`⚠️ VERIFY` any new entry the same way. This is exactly the class of thing Prime Directive #1
exists to catch — the bare id looks more "correct" and is what one would write from memory.

Also available if the default needs changing (all `us.`/`global.` prefixed, all streaming):
`claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6-v1`,
`claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001-v1:0`, `claude-fable-5`.
Note the AWS CLI bundled here is **v1 and has no `bedrock` command** — enumerate with the SDK
(`scripts/verify-bedrock-models.ts`), not the CLI.

### 2. Request schema — VERIFIED (not assumed)

```jsonc
{
  "anthropic_version": "bedrock-2023-05-31",   // required; "Invalid API version" if wrong
  "max_tokens": 512,                           // REQUIRED — omitting → "max_tokens: Field required"
  "system": "…",                               // optional
  "temperature": 1,                            // optional
  "messages": [{ "role": "user", "content": [{ "type": "text", "text": "…" }] }]
}
```

Sent with `contentType: "application/json"`, `accept: "application/json"`.

**Non-streaming response:** keys `model, id, type, role, content, stop_reason, stop_sequence,
stop_details, usage`. **Text is at `content[0].text`.** `stop_reason: "end_turn"`.
`usage` carries `input_tokens` / `output_tokens` plus cache and `output_tokens_details.thinking_tokens`
— usable for cost telemetry later.

### 3. Streaming decode path — VERIFIED

`InvokeModelWithResponseStreamCommand`; iterate `res.body`, each item has `chunk.bytes` (Uint8Array)
to `TextDecoder` + `JSON.parse`. Observed event sequence:

```
message_start ×1 → content_block_start ×1 → content_block_delta ×N
  → content_block_stop ×1 → message_delta ×1 → message_stop ×1
```

```jsonc
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1"}}
```

→ **Decode path: `chunk.delta.text` where `chunk.type === "content_block_delta"`.** Reassembly
verified exact. All other event types must be **skipped, not errored on** — matching §12's
"unknown event types logged + skipped" discipline on our own SSE layer.

### 4. Structured-output compliance — 90% clean, single repair pass is SUFFICIENT

10 runs at `temperature: 1`, asking for `{title ≤60 chars, bullets: exactly 3 strings ≤80 chars}`:

| Outcome | Count | Pipeline path |
|---|---|---|
| Clean `JSON.parse` **and** schema-valid | **9/10** | straight through |
| Needed fence/preamble extraction | 0/10 | tolerant extractor |
| Parsed but schema-invalid | **1/10** | → repair pass |
| Unrecoverable garbage | 0/10 | → fallback |

The single failure was `bullets[2] 83>80 chars` — **a budget overrun, not malformed JSON.** That is
a notable calibration result: the realistic failure mode is *length*, not syntax. It lands on the
§9 row "valid JSON, one field over budget → truncate at word boundary + `trimmed` flag" — i.e.
handled by deterministic truncation, **without** spending an LLM round-trip on repair.

→ **§7's single repair pass is sufficient** (90% clean, 100% parseable). No §14 escalation needed.
→ Zero markdown-fence contamination in 10 runs, but keep the tolerant extractor: it costs nothing
and the §9 matrix requires it.
→ Truncation-before-repair is the right ordering, and it reinforces C1: length control is our job.

### 5. Error shapes — VERIFIED (for `lib/adapters` mapping)

| Trigger | `name` | HTTP | `$fault` | Message |
|---|---|---|---|---|
| Bogus model id | `ValidationException` | 400 | client | "The provided model identifier is invalid." |
| Bare id, no `us.` prefix | `ValidationException` | 400 | client | "…on-demand throughput isn't supported. Retry with…an inference profile…" |
| Missing `max_tokens` | `ValidationException` | 400 | client | "max_tokens: Field required" |
| Bad `anthropic_version` | `ValidationException` | 400 | client | "Invalid API version: not-a-version" |
| Invalid credentials | `UnrecognizedClientException` | **403** | client | "The security token included in the request is invalid." |
| Retired model version | `ResourceNotFoundException` | **404** | client | "This model version has reached the end of its life." |
| Profile id in wrong region | `ValidationException` | 400 | client | "The provided model identifier is invalid." |

→ Note `ValidationException` is **overloaded** — it covers bad ids, bad regions, and bad request
bodies alike. The adapter cannot distinguish them by `name` alone; map on `name` + inspect the
message for the "on-demand throughput" and "Field required" signatures, and never surface a raw
AWS message to the user.

⚠️ **Not reproduced:** `AccessDeniedException` (these are admin credentials, so no model is
access-denied) and `ThrottlingException` (cannot be triggered without abusing the account). Map
from documented shapes: `AccessDeniedException`/403 and `ThrottlingException`/429 with
`$retryable={throttling:true}`. The SDK retries throttles internally (default `maxAttempts: 3`);
the adapter must surface the **final** failure as a readable per-slide error so §9's "other slides
continue, `deck-done {ok, failed}` accurate" holds. **Flagged, not silently assumed.**

### Carry into implementation

- `DEFAULT_LLM_MODEL_ID=us.anthropic.claude-opus-5`; registry entries store **prefixed profile ids**.
- Request builder: `anthropic_version` + `max_tokens` are mandatory; content as `[{type:"text"}]` blocks.
- Stream strategy: `chunk.delta.text` on `content_block_delta`; skip all other event types.
- Repair budget: one pass is enough. Truncate over-budget fields deterministically **before**
  spending a repair call.
- All AWS error mapping lives in `lib/adapters/bedrock-llm-adapter.ts` (§5 boundary), keyed on
  `name` + message signature; `ValidationException` needs sub-classification.

---

## §1.3 Environment sanity — PARTIAL (one item blocked by the toolchain, not by the code)

- ✅ **Bedrock reachable** with the ambient `AWS_PROFILE`/`AWS_REGION` (§1.2 above).
- ✅ **App builds with NO AWS credentials** — `AWS_PROFILE= AWS_REGION= npx next build` → exit 0
  (2026-07-27). Enforced going forward by two mechanisms, not by memory:
  - `loadConfig()` deliberately does **not** validate `DEFAULT_LLM_MODEL_ID`, so a missing model id
    fails at generation time, not at startup (`tests/container.test.ts` asserts this).
  - `getContainer()` is lazy, so importing the container has no side effects — nothing is
    constructed and no `DATA_DIR` write happens until a request needs it.
  The `/api/registry/*` routes themselves land in §2 step 15; the property they depend on is proven.
- ✅ **No server SDK in the client bundle (§0.5, §12)** — grepped the built `.next/static` tree
  (9 JS files) for `@aws-sdk`, `pptxgenjs`, `AWS_PROFILE`, `BedrockRuntime` → **0 hits each**.
  Also enforced at source level by `tests/architecture.test.ts` and by ESLint (§5).
- ⚠️ **Docker `output: 'standalone'` build + run smoke — CANNOT RUN, NOT WAIVED.** Docker is not
  installed on this machine (`docker --version` → command not found, 2026-07-27). What IS verified:
  `next build` emits `.next/standalone/server.js`, and the `Dockerfile` + `.dockerignore` are
  written against that output. What is NOT verified: that the image builds and serves. This is the
  same "deferred, not waived" treatment as the PowerPoint desktop open-test — re-run
  `docker build -t deck-studio . && docker run -p 3000:3000 -v $(pwd)/data:/data deck-studio`
  once Docker is available, before any deployment claim.
- N/A **`sharp`** — not needed: `scripts/letterbox.ts` reads PNG/JPEG intrinsic dimensions from
  file headers with no image library, so there is no native-module dependency to sanity-check.

---

## §2 steps 1–6 — foundation layers **COMPLETE** (2026-07-27)

`npm run verify` (lint → typecheck → 95 tests) green. Build order followed bottom-up; each layer
was tested before the next existed.

### §5 boundary lint — ENFORCED AND PROVEN TO FIRE

CLAUDE.md §5 says a boundary violation must be a *failing build*, so the rules were proven with
deliberate violations rather than assumed:

| Probe (since deleted) | Violation | Reported? |
|---|---|---|
| `app/api/_boundary-probe/route.ts` | imports `lib/repositories/**` | ✅ error |
| same file | imports `node:fs` | ✅ error |
| `lib/services/probe-service.ts` | imports `lib/repositories/**` | ✅ error |

**Two toolchain traps found and fixed** (both would have left the rules silently inert):

1. **Next 16 removed the `eslint` config key** — `next build` no longer runs ESLint *at all*. A
   boundary violation would therefore ship with a green build. Mitigation: `npm run verify`
   chains lint + typecheck + test; **CI must run that, not `next build`**.
2. **`FlatCompat` cannot load `eslint-config-next` v16** — it throws
   `TypeError: Converting circular structure to JSON` from `@eslint/eslintrc`'s config-validator
   (it `JSON.stringify`s a self-referencing plugin object). v16 ships a *native* flat-config array,
   so it is now imported directly and `@eslint/eslintrc` was removed as a dependency.

Also: TypeScript was downgraded 7.0.2 → 6.0.3 because `typescript-eslint` does not support TS 7.0
— §5 lint is non-negotiable, so the lint-capable compiler wins.

### §6 swap-readiness — PROVEN

- **One** shared contract suite (`tests/repository-contract.ts`, 37 cases) imported by both
  `tests/memory-repositories.test.ts` and `tests/file-repositories.test.ts`. Never copied.
- **Both backends green on the identical suite.** Covered: CRUD, user scoping (A cannot read/​write
  B's entities), per-slide put/get/delete/reorder, list summaries, delete cascade, patch-vs-replace
  meta semantics, defensive copying, and concurrent `putSlide`/`updateMeta`.
- **Backend selection is one config value** — `tests/container.test.ts` builds a container with
  `storageBackend: "memory"` and asserts the wiring, with zero service/route changes. Adding
  DynamoDB is one `case` per switch in `lib/repositories/factory.ts`; the `default` arms are typed
  `never`, so **extending the config union fails to typecheck until the case is wired**.
- **Interface hygiene** is machine-checked, not reviewed (`tests/architecture.test.ts`): no port
  imports `fs`/`@aws-sdk`/an impl, no port method name contains `Sync(`, concrete impls are
  constructed **only** in `lib/repositories/factory.ts`.

Findings worth carrying:

- **Atomic writes are not enough.** `writeFileAtomic` (temp + fsync + rename) guarantees a reader
  never sees a *corrupt* file; it does nothing about a *lost update*. `updateMeta` is
  read-modify-write, so two concurrent patches drop one without a lock. Hence `KeyedMutex` — and
  the contract suite tests the lost-update case directly (three concurrent patches, all three
  fields must survive).
- **The lock is in-process only.** Correct for v1 (single Next server) and for file-on-EFS with one
  task. Multiple writer tasks would need a different mechanism. Documented in `fs-util.ts` rather
  than left as an assumption.
- **Path safety belongs in the path builder**, not in callers. `safeSegment` is an allowlist
  (`[A-Za-z0-9_-]` + one optional short extension), so `..`, `.`, `a/b`, `a\b`, `C:\…`, NUL and
  empty are all rejected by one rule — and the thrown message does **not** echo the crafted value.
- **`reorderSlides` validates the whole permutation before writing.** A partial apply would leave
  duplicate `order` values that `listSlides` cannot resolve deterministically. Both impls also
  tie-break on id, so even a crash mid-reorder yields a stable order.
- **Ordering needs no stored index** — ULIDs sort lexicographically by mint time, so "newest first"
  is a plain key sort. The generator is monotonic within a millisecond for that reason.

### Deliberate deviations from SPEC §4.3, and why

| SPEC | Built | Reason |
|---|---|---|
| `AssetStore.put(… data: Buffer …)` | `data: Uint8Array` | Keeps a Node-only type out of the port. `Buffer` **is** a `Uint8Array`, so existing callers stay valid. |
| `AssetStore` = 4 methods | + `getMeta`, `resolve` | The export path needs metadata for every slide but bytes only for the *distinct* backgrounds (§1.1/C3). Without these, callers would stream a 5 MB image just to read its dimensions. |
| — | `ReadableAsset.body` is a **web** `ReadableStream` | What a Next route returns directly and what the S3 SDK already yields; `Readable.toWeb` is confined to the disk adapter. |
| — | `InvalidSlideOrder` error code added | A bad reorder request is a 400, not a 404 `SlideNotFound`. Reusing the latter would have made the taxonomy lie. |
| `STORAGE_BACKEND=file\|dynamodb` | `file\|memory` | §6.3 requires the suite pass against a second backend "registered via one factory case". Making `memory` a real, documented config value is the honest way to prove that; `dynamodb` remains an unwritten case. |
