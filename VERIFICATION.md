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
- ✅ **`npm run dev` serves the app with NO AWS credentials** — `AWS_PROFILE= AWS_REGION= next dev`
  → ready in 1.8s, `GET /` → 200 (2026-07-28). Confirms the lazy-container property above holds at
  runtime, not just at build time.
- ⚠️ **Docker `output: 'standalone'` build + run smoke — SKIPPED BY DECISION (2026-07-28), FLAGGED.**
  Docker is not installed on this machine (`docker --version` → command not found) and the user
  elected to skip rather than install it. What IS verified: `next build` emits
  `.next/standalone/server.js`, and the `Dockerfile` + `.dockerignore` are written against that
  output. What is **NOT** verified: that the image builds, that the non-root `nextjs` user can write
  `/data`, or that the volume mount round-trips. **This blocks the SPEC §13 acceptance line
  "`docker build`/`run -v …:/data` yields the identical app"** — that box stays unchecked. Before any
  deployment claim, run:
  `docker build -t deck-studio . && docker run -p 3000:3000 -v $(pwd)/data:/data deck-studio`
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

---

## §2 step 7 — `lib/brand/*` COMPLETE (2026-07-28)

CLAUDE.md §2 step 7 in full: *"`brand-schema.ts` (zod incl. zone bounds + slotKey cross-check),
`theme.ts` (pure `compileTheme`), `contrast.ts` (AA check + deterministic repair — table-test known
failing pairs), `fonts.ts`/`tones.ts` registries."* All five files exist; **178 tests green** across
7 files (`npm run verify`: lint → 2× typecheck → vitest).

| File | Tests | What is actually proven |
|---|---|---|
| `contrast.ts` | 28 (`tests/contrast.test.ts`) | WCAG luminance/ratio against **independent reference values** (white=1, `#808080`≈0.2159, `#767676` on white ≈4.54) — a bug cannot make these pass by agreeing with itself. Then the demanded 12-row failing-pairs table. |
| `theme.ts` | 18 (`tests/theme.test.ts`) | Purity (deterministic, non-mutating, id-independent), pptxgenjs hex form on every emitted colour, AA on all four painted surfaces, one notice per repair, monotonic tint/shade ramps. |
| `brand-schema.ts` | 37 (`tests/brand-schema.test.ts`) | SPEC §5's four named import checks, one describe block each: hex colours, zones 0–100 non-degenerate, slotKeys exist on the layout, assets resolve. |
| `fonts.ts` | (registry; measured in §1.1) | Ratified 2026-07-28: 7 `core` selectable, 7 `office` + `segoe_ui` gated, `aptos` dropped. |
| `tones.ts` | (registry; asserted by §7 later) | 5 tones with prompt-safe `promptFragment`s. |

### Contrast repair — the design decisions, and why they are testable

- **A fixed 20-step ladder, not a binary search.** Determinism is load-bearing: the browser preview
  and the PPTX exporter each call `compileTheme` independently (§8), so a search that wandered by a
  fraction would make the export stop matching the preview the user approved. `is deterministic` and
  `is idempotent` assert this directly.
- **Stop at the FIRST passing step.** Repair should reach AA and stop, not drive to black. The test
  asserts magenta stays magenta-ish (`r > b > g`, and not `000000`) after repair.
- **`mixToward` is linear in sRGB** — not perceptually uniform, but monotonic in luminance, which is
  all the ladder needs, and unlike an HSL round-trip it *cannot* drift the hue.
- **A documented unreachable case:** `#808080` text on a `#808080` background cannot reach 4.5:1
  against either pole. The implementation takes the better pole (~3.9:1) rather than throwing; the
  test asserts `> 3` for that one row and full AA for every other. Recorded as behaviour, not a bug.
- **Malformed hex passes through untouched, unrepaired.** A bad colour must surface as a *schema*
  error; silently rewriting it here would hide the real fault.

### `compileTheme` — two guarantees that hold by construction

1. **Renderers never see a `BrandDefinition`.** `DesignTokens` is the only appearance input, so a
   renderer *cannot* reach past the theme for a raw brand colour and thereby bypass contrast repair.
   It is not a rule anyone has to remember.
2. **Large vs normal threshold is applied per surface, not globally.** `onPrimary`/`onAccent` back
   title and callout text (32–40pt = WCAG large ⇒ 3:1); `onBackground`/`onSurface` back body text
   (⇒ 4.5:1). Holding titles to 4.5:1 would repair colours that are *already compliant* and move
   them off-brand for no accessibility gain. Both thresholds are asserted.

### `brand-schema.ts` — the one shape decision worth flagging

**The `slotKey` cross-check is an INJECTED lookup, not an import of the layout registry.** Three
reasons, in order of weight:

1. **It would be a cycle.** Layout definitions consume `DesignTokens` from `lib/brand`, so
   `brand → layouts → brand` would be circular.
2. **Layouts carry a `FallbackRenderer` (a React component)** — importing the registry would drag
   React into `lib/brand`, which services and the schema must stay free of.
3. **It is testable now**, before the registry exists (§2 step 8), via a stub `LayoutLookup`.

The shape: `validateBrand(input, { layouts?, knownAssetIds? })`. Structural validation is pure zod
and needs neither — so the brand editor can validate on every keystroke — while the cross-checks run
on save, where the registry and an asset listing are available. Omitting an option **skips** that
check rather than failing it (asserted both ways). No SPEC shape changed; §2 step 8 wires the real
registry in as a one-object adapter.

Also decided while writing it:

- **Colours are NORMALIZED on parse** to canonical `RRGGBB` (uppercase, no `#`). That is the only
  form pptxgenjs accepts (§1.1) and the form `DesignTokens` emits, so `#fff`, `#FFF`, and `FFFFFF`
  cannot become three "different" brands. Export → re-import is identical (§11 step 3, asserted).
- **`tone.voice` is a closed TONES id, not free text.** It is the one brand field that reaches a
  prompt (§7), so keeping it closed means the text we send is authored by *us* and provably free of
  visual vocabulary. Bespoke voice goes through `traits`, which are bounded (12 × 40 chars) so a
  prompt cannot be stuffed through them.
- **Gated fonts still VALIDATE.** Gating is a picker policy (`selectableFonts()`), not a validity
  rule — otherwise a brand created before an entry was gated could not even be opened to change the
  font. Asserted for `cambria` and `segoe_ui`; `aptos` (dropped) correctly fails.
- **`z.strictObject` everywhere.** A typo'd key in a hand-edited JSON import is reported, not
  silently dropped — exactly the failure mode SPEC §5's "raw JSON import" invites.
- **A template omitting a required slot's zone is an ERROR.** Zone resolution is
  `templates[layoutId].zones` **else** `defaultZones` — a template *replaces* defaults wholesale, so
  an omitted required slot means that content has nowhere to go and is silently invisible.
- **Crafted ids are rejected at the schema edge too** (`^[A-Za-z0-9_-]{1,128}$` for `id`, `userId`,
  asset ids). The real defence is still `fs-util.safeSegment` where the filesystem is touched; this
  is depth, so the user gets a readable field error instead of a deep adapter throw.
- **Nothing is partially applied.** On any issue the caller gets `{ok: false, issues}` with **no**
  `value` property at all (asserted), and every issue carries a dotted `path` the editor can
  highlight (§12).

### Carry-forward for §2 step 8 (layouts)

- Provide a `LayoutLookup` adapter over the registry: `{ layout: (id) => ({ slotKeys,
  requiredSlotKeys }) }`. One object, wired where the brand service is constructed.
- `DEFAULT_BRAND_COLORS` (AA-clean, neutral) is exported from `brand-schema.ts` — the seed for
  `POST /api/brands { name }`.
- The type scale is **points**, descending: `display 40 / title 32 / heading 24 / body 18 /
  caption 12`. PPTX is the authority and CSS derives from it, never the reverse, so the two cannot
  drift. `title`/`display` being ≥18pt is what makes the large-text threshold correct above.

---

## §2 step 8 — `lib/layouts/*` COMPLETE (2026-07-29)

**Gate: `npm run verify` green** — `eslint .` clean, both typecheck projects clean,
**397 tests / 12 files passing**. Step 8 contributed **219** of those:

| Suite | Tests | What it guarantees |
|---|---|---|
| `tests/layout-registry.test.ts` | 39 | §4 registry invariants, and that each one actually fires |
| `tests/layout-budgets.test.ts` | 62 | every `maxChars` fits the zone it renders into (§1.1/C1) |
| `tests/layout-validate.test.ts` | 50 | §9's content rows — validate → truncate → flag |
| `tests/render-mode.test.ts` | 41 | the §6 Strategy resolver + the two §8 shared utils |
| `tests/pptx-text.test.ts` | 27 | C1 and C5 enforced across the **whole** registry |

Shipped: `types.ts`, `zone-math.ts`, `capacity.ts`, `validate.ts`, `render-mode.ts`, `background.ts`,
`pptx-text.ts`, `paint.tsx`, `preview.tsx`, `registry.ts`, and 8 seed layouts in `defs/`.

### The budget test found 19 real defects — and one wrong comment of mine

`tests/layout-budgets.test.ts` compares every slot's declared `maxChars` against the capacity its own
`defaultZones` + type scale actually provide, and requires the budget to fit inside **85%** of it.
On first run **21 of 31 slots failed**. They were not near-misses: `quote.quote` budgeted 220
characters for a box holding ~102, and `bullets.items` 100 per item for ~58.

This matters because of C1. `fit:'shrink'` never shrinks, so an over-budget slide does not degrade
gracefully — it spills across neighbouring zones or is **silently clipped in the artifact the
audience sees**. Nothing else in the codebase would have caught it: the schema accepts the text and
the normalizer passes it through *unflagged*, because from `validate.ts`'s point of view the content
was within its stated budget. The budget was the thing that was wrong.

Fixed by recomputing geometry and budgets across all 8 layouts (`title.title` 70→50,
`bullets.items` 100→55, `quote.quote` 220→85, `agenda.items` 80→55, and so on). Each layout's header
now states where its numbers come from. It also disproved a comment I had written in `title.tsx`
("~42 chars/line × 2 lines ≈ 84 chars") — arithmetic from memory, and wrong. Corrected in place.

**Two of the 21 were the test's fault, and the test was fixed rather than the code bent to it:**

- `stats` renders its lists as three **side-by-side** columns, not a stacked list. The stacked model
  understated capacity threefold while crediting the full band width. Now a small explicit
  `COLUMNAR_LISTS` table — how a layout arranges a list is a fact about its render code and there is
  no honest way to infer it, so a new layout doing the same must say so.
- "A display/title slot never out-budgets a body slot" flagged `two_column`, where an 84%-wide title
  legitimately holds more characters than a 38%-wide column item despite the larger point size. Now
  restricted to slots of comparable width.

Measured table: **`tests/__artifacts__/layout-budgets.tsv`** (committed, regenerated by the suite).
Tightest fits are `agenda.items` / `bullets.items` / `closing.nextSteps` at 85%; loosest is
`section_divider.eyebrow` at 28%. An artifact rather than a `console.log`, which vitest swallows —
the day the per-face advance IS measured (⚠️ VERIFY below), this table is what says which budgets
move.

### C1 and C5 are enforced across the registry, not just in the helper

`pptx-text.ts` is the single choke point for every text box any layout emits, but a helper being
correct is not the guarantee that matters — **no layout bypassing it** is. So two of the 27
assertions in `tests/pptx-text.test.ts` drive `toPptx` for *every* seed layout and assert:

- every emitted box has `fit: 'none'` (C1);
- **no multi-run box contains a run without `breakLine`** (C5). This is the assertion that would have
  caught the original collapse, which 48 OOXML assertions in the §1.1 spike did not.

A third states the hazard is *handled, not avoided*: the shape-level `align` that triggers C5 is
still set, because dropping it to dodge the collapse would break zone alignment and §8 instead.
Geometry is re-anchored to the spike's EMU proof (8% of 10in = **731520 EMU**, exact).

### §8 divergence is structural, not disciplinary

One slot declaration produces both renderers. `paint.tsx` derives *style* through
`previewStyleFor`/`pptxStyleFor` — a matched pair over one `PaintStyle` — and both consume the same
`resolveZones` and the same percent→inches math from `zone-math.ts`.

`stats` was the case that tested this. It is the one seed layout whose structure repeats (three
value/label/note cards), so a flat `SlotPaint[]` cannot express it and it must call the leaf
renderers itself. Extracting the style helpers means the only thing it owns is *which box each string
lands in*; face, size, colour and italic stay shared. A structurally irregular layout still cannot
drift between preview and export.

Stated limit: the brand editor can move and resize each *band*, not an individual card. Nine zones in
the zone table would make one of the commonest layouts the most confusing to edit, and
three-equal-columns is this layout's identity rather than a parameter of it.

### Registry invariants throw at module load — deliberately, and only here

`assertRegistryInvariants()` runs at import of `registry.ts` and throws listing every problem. A
load-time throw is right *here specifically* because these failures are **authoring** mistakes in
static data, unreachable from user input or model output, and the consequence of not catching them is
silent: `zoneFor` returns `undefined`, the painter skips the slot, and the deck exports with content
simply **absent** from a slide the model filled correctly — §13's blank-slide failure by the back
door.

Checked: snake_case id, slot-key regex, duplicate keys, positive integer budgets, list-vs-text budget
coherence, **every required slot has a `defaultZones` entry**, no zone for a nonexistent slot, no
duplicate zones, and zone bounds (`x+w ≤ 100`, `y+h ≤ 100` — per C4 pptxgenjs clamps *nothing*).
`fallbackProblems` additionally asserts the fallback layout requires exactly `title` + `items`,
because `FallbackHandler` can only supply message + evidence.

The suite tests both halves: the real registry is clean, **and** each hand-built broken layout
produces its specific problem. A checker that reports nothing is indistinguishable from a valid
registry until the day it isn't. `layoutProblems(layout)` is split from `registryProblems(layouts)`
so a candidate layout can be validated in isolation — which §10's one-file proof will need.

### Design decisions worth recording

- **Over-budget is not a validation error.** §9 requires truncate + `trimmed`, so the single repair
  call is never spent on something deterministically fixable. `validateSlots` ignores budgets by
  default; `enforceBudgets` exists for the *user-edit* path, where silently rewriting what someone
  typed would be wrong — the editor reports instead.
- **Only lost content earns `trimmed`.** An absent optional slot and a hallucinated extra key are
  recorded as `adjustments` but do **not** flag. If they did, nearly every slide would wear an amber
  badge and the badge would stop meaning anything.
- **The ellipsis lives inside the budget**, and a word boundary is used only when it keeps ≥60% of it
  — otherwise a URL or CJK text with no spaces collapses the field to almost nothing. Asserted for
  every budget 1…60.
- **`normalizeSlots` coercion is total.** It runs on stored slides, JSON imports, and applied repair
  responses, none of which necessarily passed the schema — so a `.trim()` on a number would be a 500
  on the render path. Found while testing it; the "never throws" promise in its doc comment now has a
  test behind it. Values with no sensible text form are dropped rather than rendered as
  `[object Object]`.
- **A brand template REPLACES `defaultZones` wholesale.** Merging looks friendlier but would
  resurrect a deliberately removed zone, and "this layout shows no subtitle" would be inexpressible.
  An empty zone array counts as *no* customization, so a template saved with zero zones renders
  defaults rather than a blank slide.
- **`resolveZones` returns fresh copies** of both the registry's and the brand's zones. A mutation
  through the returned array would corrupt the registry **for the whole process** — every later deck
  in the same server rendering with one deck's edits. Asserted in both directions.
- **A background asset, not customized zones, is what makes a layout templated.** A brand may
  reposition slots while still wanting the token-styled look. `templatedLayoutIds` is asserted to
  agree with `resolveRenderPlan` for every seed layout, so a gallery card cannot claim a template
  that would not actually render as one.
- **`canUseAsMaster` agrees with `placeBackground`** about which assets are full-bleed. A master path
  taken for an asset that `placeBackground` would letterbox is exactly the silent distortion C3
  warns about; the two are asserted equal across 5 aspect cases.
- **`imageSize` skips 0xFFC4/C8/CC** on the way to a JPEG SOF — they sit in the SOF numeric range but
  are not frame headers, and reading one yields garbage dimensions that would letterbox a perfectly
  good 16:9 background. It also terminates on a zero segment length (a hang in an upload handler is a
  denial of service, not a bad image) and reads through a correctly offset `DataView`, since
  `Buffer.subarray` shares its parent's `ArrayBuffer`.

### ⚠️ VERIFY — carried forward, unchanged

1. **Desktop PowerPoint open-test** (from §1.1) — still deferred, not waived. No desktop Office is
   available here. Blocks ungating the `office`/`segoe_ui` fonts and measuring per-face advance.
2. **`capacity.ts`'s `AVG_ADVANCE_EM = 0.5`** is a mean, not measured per face. Mitigated two ways:
   the 15% headroom above, and the fact that `capacity.ts` is **test-time only** — it cannot affect
   rendered output, only whether a budget is judged safe. If the measured advance for Verdana turns
   out materially wider, `layout-budgets.tsv` names the slots that move.

### Carry-forward for §2 step 9 (mapping)

- `layoutsForIntent(intent)` and `FALLBACK_LAYOUT_ID = "bullets"` are exported from the registry —
  the CoR's IntentMatch and Fallback rules read from these, never a parallel table.
- Every one of the 9 `VisualHint` values has ≥1 layout, asserted against a hardcoded list, so adding
  a hint without a layout fails the build rather than silently falling through to `bullets`.
- `layoutSummaries()` is the API-safe projection: no `FallbackRenderer`, no `toPptx`, JSON
  round-trips (asserted). `/api/registry/layouts` returns exactly this.

---

## §2 steps 9–10 — mapping + models/adapter COMPLETE (2026-07-30)

`npm run verify` green: ESLint clean, both typecheck projects clean, **544 tests / 15 files**
(was 397/12 at end of step 8; +147 across 3 new suites).

| Suite | Tests | Covers |
|---|---|---|
| `tests/mapping-rules.test.ts` | 51 | the CoR: each rule, and precedence between them |
| `tests/model-registry.test.ts` | 45 | registry invariants, `clampTemperature`, both family strategies |
| `tests/bedrock-adapter.test.ts` | 47 | `mapModelError` table + `complete`/`stream` against a fake `send` |
| `tests/container.test.ts` | +3 | the LLM port's laziness and its mock seam |

### Step 9 — `lib/mapping/rules.ts` (SPEC §7.2)

The chain is `UserOverride → Positional → IntentMatch → Fallback`, and **its order is the
specification** — a rearrangement is a behaviour change, asserted directly.

Deliberately deterministic rather than an LLM call: SPEC requires a per-slide mapping badge that
explains *why* a layout was chosen. If the reason were a model's, the user's override would be a guess
against an unexplained decision. Every rule returns a `reason` string; `mapOutline` asserts none is
blank, because the badge always renders one.

Decisions worth recording, each with a test:

1. **A stale `layoutOverride` is IGNORED, not fatal.** A layout can be removed between an outline
   being saved and the deck being generated. Honouring the id would render an unknown layout;
   throwing would fail a whole deck over a registry edit. It falls through to the rest of the chain.
2. **Opening beats closing in a one-slide deck.** A deck that only opens is coherent; one that only
   closes is not.
3. **The first section gets no divider** — it would immediately repeat the title slide. Nor does a
   section with a blank heading, since the divider's only content *is* the heading (an empty slide).
4. **Position beats intent.** A first slide hinting `list` is still the title slide: the model is
   describing the opening's content, not its role in the deck. This is the rule most likely to look
   like a bug and is not, hence the named test.
5. **Empty sections are skipped before positions are assigned**, so a model returning one cannot cost
   the deck its closing slide or manufacture a divider.
6. **Registry order is a precedence declaration.** `bullets` claims both `list` and `detail`;
   `layoutsForIntent(hint)[0]` wins, asserted against the array rather than a hardcoded id.

The intent table in the test is **built FROM the registry** (`layoutsForIntent(hint)[0]?.id`), not
written alongside it. A hardcoded `hint → layoutId` table in a test is exactly the parallel-table leak
§10 exists to catch, and it would have hidden it. `layoutForHint` (the picker's ordering) is asserted
to agree with `intentMatchRule` for every intent every layout claims — the one case where the
highlighted option and the badge answer the same question.

### Step 10 — `lib/models/*` + `lib/adapters/bedrock-llm-adapter.ts`

**Everything on the wire is §1.2-measured, and the tests say which facts came from where.** The
mandatory `anthropic_version` / `max_tokens` pair, the block-array content shape, the delta path, and
the 8-row error table are all transcribed from the spike, not remembered.

Three findings/decisions:

1. **The inference-profile prefix is a load-time invariant, not a review item.** §1.2 proved
   `anthropic.claude-opus-5` fails ("on-demand throughput isn't supported") while
   `us.anthropic.claude-opus-5` works. The bare id is what one writes from memory and looks *more*
   correct — Prime Directive #1's exact failure mode — so `assertRegistryInvariants()` runs at module
   load and `requireModel` rejects an unregistered id **before** any Bedrock call. Asserted both ways.
2. **`parseCompletion` joins ALL text blocks rather than reading `content[0].text`.** The spike
   observed one block, so the indexed read matches the measurement — but a response with a leading
   non-text block would silently yield `undefined`, i.e. an empty slide instead of an error. Joining
   is correct for the observed shape and safe for the other one. This is a deliberate divergence from
   the literal §1.2 note, recorded here so it doesn't read as drift.
3. **`verified: true` marks only the model actually invoked** (`us.anthropic.claude-opus-5`). The other
   two were enumerated as ACTIVE but never round-tripped, and a test pins that ratio — so a first-use
   failure reads as a known ⚠️ VERIFY item rather than a regression.

**Abort is distinguishable from failure.** Found while writing the stream tests: `throwIfAborted` sat
inside `stream`'s `try`, so a client cancellation was mapped to `ModelTimeout` — indistinguishable
from a real timeout, which is precisely the distinction §9's abort row needs ("remaining slides stop,
completed slides persisted" vs "this slide errors, the deck continues"). Both entry points now rethrow
aborts unmapped. The `AbortError` branch inside `mapModelError` survives only because the function's
return type is `AppError`; it is a defensive path, and the comment says so.

**A §3 violation was caught by the automated grep, not by review.** The adapter had
`client ?? new BedrockRuntimeClient({ region })` as a test seam — which made it a *second* place a
concrete implementation is constructed, contradicting its own header comment.
`tests/architecture.test.ts` failed on it. Fixes:

- `client` is now a **required** `BedrockSender` (`Pick<BedrockRuntimeClient, "send">`), and the
  `BedrockRuntimeClient` import is type-only;
- `createLLMPort(config)` in `lib/repositories/factory.ts` builds the real client — one more factory
  function, matching the repository pattern exactly;
- `container.llm` is a **thunk**, unlike the other ports. Constructing a client resolves credentials,
  and §1.3 requires `/api/registry/*` to serve with none configured, so it must not exist until a
  request generates something. `createContainer(config, { llm })` substitutes a mock, which is how
  §9's canned-response matrix will run with no AWS at all.

Worth noting the scanner is text-based: it later matched the phrase `new BedrockRuntimeClient(` inside
a *comment* explaining the fix. Rewording the comment was the right response — weakening the regex
would have cost the check that just earned its keep.

**What the adapter tests assert is the contract with the layers around it**, not the SDK:
the body sent is the family's (so schema knowledge lives in one place), an unregistered id never
reaches Bedrock, a raw SDK error never escapes, valid-JSON-of-unexpected-shape returns empty text
rather than throwing (the Validate→Repair→Fallback chain decides what empty means — §0.4), a single
malformed stream frame is skipped rather than discarding the slide, a mid-stream throttle still maps
to an `AppError`, and an abort stops between frames rather than draining the response.

### ⚠️ VERIFY — step 10's additions

3. **`AccessDeniedException` and `ThrottlingException` mappings are unverified shapes.** Not
   reproducible in this account: the credentials are admin (nothing is access-denied) and throttling
   cannot be triggered without abusing the account. Mapped from documented shapes. `ERROR_TABLE` in
   `tests/bedrock-adapter.test.ts` carries a `spikeVerified` flag and a test asserting these are the
   only two false rows — so adding another unmeasured mapping fails until this list is updated.
4. **`contextWindow: 200_000` on all three entries is not measured.** Bedrock does not report it via
   `ListFoundationModels`. Used solely to bound `maxTokens`, where being conservative costs nothing.

### Carry-forward for §2 step 11 (generation)

- `container.llm()` is the only way to reach a model; `createContainer(config, { llm: fake })` is the
  seam §9's matrix uses. No test should ever construct a `BedrockRuntimeClient`.
- `isTruncatedStopReason(stopReason)` is how a `max_tokens` cut-off is detected — in a stream it is
  otherwise invisible (the text simply ends). `streamStopReason` reads it from `message_delta`, which
  is where it lives; `message_stop` does not carry it.
- `mapOutline(outline)` returns `{ position, decision }` per slide, already flattened across sections
  and with empty sections dropped — the generation pipeline iterates this, not the raw outline.
- The adapter returns text only. Extracting JSON from a fenced/prefixed response is `lib/generation`'s
  job (§9 row 3), deliberately not the adapter's.

---

## §2 step 11 — `lib/generation/*` COMPLETE (2026-08-01)

`npm run verify` green: ESLint clean, both typecheck projects clean, **818 tests / 20 files**
(was 544/15 at end of step 10; +274 across 5 new suites).

| Suite | Tests | Covers |
|---|---|---|
| `tests/prompt-purity.test.ts` | 71 | **§7 core acceptance** — no visual vocabulary, and the guarantee's other half |
| `tests/generation-matrix.test.ts` | 48 | **§9's table, verbatim** — Validate → Repair → Fallback through the real chain |
| `tests/outline-generation.test.ts` | 73 | outline schema tiers + the no-fallback pipeline |
| `tests/extract-json.test.ts` | 53 | §9 row 3's tolerant extractor, and its refusal to repair |
| `tests/hints.test.ts` | 29 | the hint vocabulary, its §4 boundary, and the load-time coverage check |

Eight implementation files, 1,756 lines: `hints.ts`, `extract-json.ts`, `prompts.ts`,
`outline-schema.ts`, `handlers.ts`, `pipeline.ts`, `outline-pipeline.ts`, `prompt-log.ts`.

### §7 — "no visual vocabulary in prompts" is now enforced in TWO places, deliberately

The acceptance test builds prompts from a brand with greppable values (`#FF00AA`, font `zapfino`, a
zone at `x:42`, `asset-bg-title`) and asserts none survive. That catches every leak **the fixture
provokes** — and nothing else. A tone added later whose `promptFragment` mentions a colour, a slot
description someone writes as "the large centred headline": both would pass a fixture-shaped test.

So the same rule runs at runtime. `promptImpurities(prompt)` in `prompt-log.ts` is the shared
predicate, and `DEBUG_PROMPTS=1` (§7's second requirement, now real) logs every prompt **with the
verdict on its first line** — one log line answers "did the guarantee hold". The test imports the same
function, so there is one rule, not two that can drift.

Three decisions in the scanner worth recording:

1. **Bare numbers are NOT matched, on purpose.** Slot budgets are numbers and belong in prompts. A
   coordinate pattern loose enough to catch `"55 characters maximum"` would fire on every prompt, and
   the fix under deadline pressure is to delete the test. There is a negative control asserting exactly
   that string is clean.
2. **The scanner's own negative controls come FIRST in the file.** A purity scanner that silently
   matches nothing reports success forever, which is worse than no test at all.
3. **Font terms are matched longest-first**, so `Times New Roman` is reported as itself rather than as
   `Times`. Cosmetic for the assertion, load-bearing for the person reading the failure.

**The guarantee's other half is asserted too**: purity must not be satisfiable by sending nothing. A
block proves the tone fragment, the banned words, the briefing, and every slot's key + description +
budget ARE present — including `it.each(TONES)` proving every registry fragment reaches a prompt, since
a fragment that never arrives is dead data and the failure would be silent.

**Layout `displayName`/`description` are withheld from slide prompts**, asserted directly. The scanner's
patterns would not catch "full-bleed" or "Two column", so the builder's *omission* is what the test
pins — those strings describe a layout to a human choosing one in the UI, and §7 keeps them out of the
model's view.

**One boundary is documented rather than fixed.** The repair prompt echoes the model's own bad output
verbatim; if the model invented a hex code, it is in there. A test pins that and explains why scrubbing
would be wrong: it would corrupt the text the model must repair, and nothing renders from a prompt.

### §9 — the matrix is the table, transcribed as data

`MATRIX` in `tests/generation-matrix.test.ts` is CLAUDE.md §9's eight rows as a `const`, each driven
through the **real** chain — never a reimplementation. Three assertions run on every row regardless of
what it is testing:

- `Object.keys(slots).length > 0` — **§0.4: never a blank slide**, on every path including garbage in.
- The user-facing message never matches `/zod|ValidationException|required/i` — internals do not leak.
- Exactly one terminal event (`slide-done` XOR `slide-error`), so no row can double-emit or go silent.

`Script` models a mid-stream failure as `{ text, throwsAfter }` — deltas, then a throw. That is the only
honest reproduction of §9's "ThrottlingException mid-deck": a throw *before* any output is a different
failure with a different recovery.

Row-specific findings:

- **The fallback is built from the OUTLINE, not from model output.** Asserted as
  `expect(JSON.stringify(slots)).not.toContain("happy to help")` — a fallback that salvaged the
  model's prose would put "I'd be happy to help!" on a slide.
- **The repair pass runs at most once, and the ORIGINAL failure reason survives** when the repair call
  itself throws. Otherwise a `trimmed`-worthy first attempt would be reported as a model error.
- **A tolerant-extractor recovery spends NO repair call.** Repair exists for unusable content, not for
  packaging.
- **Abort yields `ok: 0, failed: 0`** for the cancelled remainder, and `result.outcomes` keeps the
  completed slides. The remaining slides are *absent*, not failed — counting them as failures would
  report a user's own cancellation as a defect.

### `outline-pipeline.ts` has NO fallback, and both the file and a test say so

The slide chain ends in a fallback because a deck with one weak slide beats no deck. The outline is the
plan the whole deck is generated from, and a fabricated plan ("Introduction / Body / Conclusion" from
the topic string) would be worse than an error — the user would generate 12 slides against it before
noticing. So the outline path validates, repairs **once**, then throws readably.

That asymmetry is why it is a separate file rather than a variant of `handlers.ts`: sharing the chain
would mean sharing the fallback, and the fallback is exactly what must not exist here. "Add a fallback
here too, for symmetry" is the change that would break it, so the header and a named test both
pre-empt it.

Three more decisions there:

- **A model error propagates as itself.** `ModelThrottled` does not become `GenerationFailed` —
  collapsing them would tell the user to rewrite a briefing that was never the problem.
- **`OUTLINE_MAX_TOKENS = 8000`.** A `max_tokens` cut-off mid-JSON is unrecoverable by design (the
  extractor refuses to close braces — see below), so the ceiling must be generous rather than tight.
- **An out-of-range `sectionIndex` is rejected BEFORE the model is called**, with a distinct message, so
  a stale client is not logged as a struggling model.

A schema decision worth flagging: a slide count that misses the target is **advisory, not a validation
failure** (§9's outline row says "surfaced", not "rejected"). Silent inside ±2; outside it, an advisory
naming both numbers. `layoutOverride` is **stripped** from model output, though — a model that could pin
a layout would outrank the entire mapping chain, including the user's own override.

### The extractor recovers packaging and refuses to repair

Most of `tests/extract-json.test.ts` asserts the **absence** of cleverness — no trailing-comma
stripping, no quote fixing, no closing of unbalanced braces — because that is the property that erodes
under a "just make this one case work" change. Silently reinterpreting broken output invents content the
model never produced, and §9 already has the right answer for it.

The specific case: a response truncated at `max_tokens` must return `undefined`, not a brace-closed
object. Fabricating structure there produces a slide carrying content the model never finished writing.
Its complement is also pinned: a *complete* object followed by truncated prose still parses.

The brace scan is string- and escape-aware, and the cases are not exotic — a `{customerName}` token in
marketing copy, a quoted statement with escaped quotes, a Windows path, a brace-heavy code sample.

### Registry-derived fixtures — §4's rule applies to tests too

`validResponseFor(layout)` generates a canned response from a layout's own `SlotSpec`s. This came out of
a real failure: the deck-level test hand-wrote a `bullets`-shaped response for a 3-slide deck, but the
real `mapOutline` produces `title` → `bullets` → `closing` (PositionalRule forces the boundaries), so
slides 0 and 2 fell back and `ok` was 1 instead of 2. A stale hand-written fixture meeting the real
mapping chain. Deriving from the registry means a new layout needs no edit here, and a layout whose
budgets change cannot leave a stale fixture behind.

The same failure taught a second lesson: the deck test now asserts the produced `layoutId`s **equal the
mapped ones**, because otherwise the whole describe block would be asserting against accidental
fallbacks.

### Two real defects found by writing the tests

1. **`isVisualHint` validated `"toString"`.** The guard was `value in HINT_DESCRIPTIONS`, and `in` walks
   the prototype chain. A model answering `visualHint: "constructor"` would have passed the guard and
   then read `HINT_DESCRIPTIONS[hint]` — a *function*, carried into a prompt. Now `Object.hasOwn`, used
   by `hintCoverageProblems` too. This is §0.4 (LLM output is hostile input) landing in a place that
   looked like static data.
2. **A purity assertion was passing for the wrong reason.** The fixture's `voice: "wry"` is deliberately
   unregistered, so `resolveTone` returns undefined and no fragment reaches the prompt — my `??`
   fallback then asserted the *executive* fragment was present. Fixed by adding a second tone case (loud
   traits, registry voice) and running every purity assertion over **both**, plus a test that an
   unregistered voice omits the fragment without erroring while traits and banned words still land.

Also self-caught: two rows of `tests/extract-json.test.ts` contradicted each other about array-wrapper
recovery. The behaviour was right; the row was wrong. Resolved by pinning the actual rule — the first
object in a multi-element array wins, because with two candidates there is no principled choice and
merging would fabricate a response.

### `HINT_DESCRIPTIONS` and the §4 parallel-table question

It is a hint→string table, and §4 forbids parallel hardcoded tables. It earns its place by carrying
what the registry does not: the *content shape* a hint implies, written for the model. hint→layout lives
in `layoutsForIntent`. `tests/hints.test.ts` defends that boundary directly — no description may name a
layout id or `displayName`, and none may use appearance words (`bulleted`, `centred`, `full-bleed`, …),
which would be both §7 violations and lies whenever a brand's template renders that layout differently.

The load-time `assertHintCoverage()` catches the silent failure: a layout declaring an intent no hint
describes is never requested by the outline model. No error, no missing slide — just a layout that
quietly never appears. The suite proves the check fires (not just that it passes) and asserts the
reverse direction too: every described hint has ≥1 layout, so a hint the model can choose but nothing
renders specially is caught as a wasted vocabulary entry.

### Carry-forward for §2 step 12 (services)

- `GenerationDeps.onPrompt?(label, prompt)` is the seam `DEBUG_PROMPTS` hangs off. The **repair** prompt
  is built inside the handler, so the `repair` thunk's callback is the only place it can be logged —
  services must pass `onPrompt` through, or repair prompts go unlogged and §7's debug mode is half real.
- `generateOutline` **throws** on total failure and does not fabricate a plan. `OutlineService` must
  surface that as a readable error, not paper over it with a synthetic outline.
- A `ModelThrottled`/`ModelTimeout` from the outline path is that error, not `GenerationFailed`. Keep
  them distinct at the service and route layers.
- Per-slide isolation lives in `pipeline.ts` (`generateDeck`), which already returns
  `{ outcomes, ok, failed }`. `GenerationService` wires `emit` to SSE; it must not add a second
  try/catch layer that would swallow the per-slide reasons.
- `createContainer(config, { llm: fake })` remains the no-AWS seam. Service tests use it.

---

## §2 step 12 — `lib/services/*` COMPLETE (2026-08-02)

`npm run verify` green: ESLint clean, both typecheck projects clean, **939 tests / 26 files**
(was 818/20 at end of step 11; +121 across 6 new suites).

| Suite | Tests | Covers |
|---|---|---|
| `tests/brand-service.test.ts` | 27 | validate→compile→persist, asset lifecycle, `BrandInUse`, letterbox flagging |
| `tests/deck-service.test.ts` | 23 | slide CRUD + reorder, budget enforcement on hand edits, brand swap, cascade |
| `tests/layout-mapping-service.test.ts` | 15 | preview rows == `map()`, override validation, picker ordering |
| `tests/outline-service.test.ts` | 17 | outline save/edit/reorder/override, the no-fallback error path |
| `tests/generation-service.test.ts` | 22 | jobs + `persist` + identity — what storage adds over `pipeline.ts` |
| `tests/export-service.test.ts` | 17 | format registry, the resolved `ExportRequest`, `exportFilename` |

Six service files, 1,605 lines, plus `tests/service-harness.ts` (247).

### The harness is the §6.3 proof, not a convenience

Every suite but one builds its container through `createContainer(config, { llm: fake })` — the same
composition root the routes will use, with the memory backend selected through the factory. That is §6.3
("integration tests against the memory backend selected via factory wiring") satisfied by construction
rather than by a separate exercise: a service test that hand-built its repositories would prove the
services work and say nothing about whether the swap seam does.

It also keeps the no-AWS seam honest. `llm` is a lazy `() => LLMPort` throughout, so all 939 tests run
with no credentials and no Bedrock client ever constructed — `tests/container.test.ts`'s §1.3 check still
holds with the whole service layer stacked on top of it.

### `ExportService` is hand-wired, deliberately, and the shortcut is documented

`Container` has no `exporters` field until step 13, so `tests/export-service.test.ts` constructs
`new ExportService({ decks, brands, exporters })` with the harness's real deck/brand services and a
recording fake exporter. Two rules keep that from becoming a lie:

- every `ExportRequest` assertion reads the **real resolved value** from the harness's repositories
  (compiled tokens from `themeFor`, zones from `LAYOUTS`, asset identity from `resolveRenderAssets`), so
  the fake proves nothing on its own;
- when step 13 adds `Container.exporters`, the file switches to `h.services.export` and every assertion
  stands unchanged.

This is not a §3 violation: the construction ban covers concrete *impls* (`tests/architecture.test.ts`
matches `new (File|Memory|LocalDisk|Stub|Bedrock|Pptx)…`), and a service over injected ports is what the
container itself builds. **Revisit at step 13** — the switch is the first task there.

### Two real defects found by writing the tests

1. **`regenerateSlide` told the model every slide was the deck's opener.** It passed `index: 0` with a
   real `total`, so regenerating slide 2 of 3 built a prompt reading "Slide 1 of 3". The existing comment
   claimed to be avoiding exactly this failure — it warned against `total: 1` making a slide "read as both
   the opening and the close" — while committing it in the other coordinate. Both halves of "slide N of M"
   are the deck's, not the call's; fixed to `index: slide.order`. Caught by asserting the literal
   `"Slide 2 of 3"` appears in the prompt, which is the only assertion shape that could have caught it:
   `index: 0` is a perfectly valid number and every type check passed.
2. **`exportFilename` mangled composed characters.** It normalized to **NFKD**, which decomposes `デ` into
   `テ` + a combining dakuten and `é` into `e` + a combining acute. A combining mark matches neither
   `\p{L}` nor `\p{N}`, so the Unicode-aware *whitelist* replaced each one — the dakuten became a hyphen
   **inside** the word (`日本語のデッキ` → `日本語のテ-ッキ`, changing how it reads), and the acute was
   dropped outright (`Café Q3` → `Cafe-Q3`). Normalization and a codepoint whitelist were fighting each
   other. Fixed to `.normalize("NFC")` with `\p{M}` in the class — composing keeps those as single
   letters, and allowing marks keeps the scripts NFC cannot precompose (Devanagari, Thai) intact. Every
   non-Latin-titled deck would otherwise have downloaded with a corrupted name.

### `persist` inside the sequence is asserted by ORDER, not by presence

SPEC §7.3 puts persistence *inside* the per-slide sequence — a `slide-done` the client renders before the
write lands is a slide that vanishes on reload. The test wraps `decks.putSlide` and pushes to a shared log
alongside the emitted events, then asserts the log **equals**
`[persist:a, slide-done:a, persist:b, slide-done:b, …]`. Asserting merely that both happened would pass on
the broken ordering.

An adjacent row comes from the same wrapper: a `putSlide` that throws `ENOSPC` on the second slide yields
exactly one `slide-error {reason:"internal", index:1}` whose message does not contain `ENOSPC` and does
say "try regenerating", the other two slides persist, and `deck-done` reports `{ok:2, failed:0}` — the
failed slide is absent from the counts, not tallied, matching §9's semantics for a slide that produced
nothing.

Self-caught before landing: the first draft of that test cast into `MemoryDeckRepository`'s private
`slides` map and wrapped its assertion in `if (seen.some(...))`, so it could pass while asserting nothing.
A conditional assertion is a test that reports success the moment the condition stops holding.

### Registry-derived fixtures again, and one place they were load-bearing

Following step 11's lesson, no suite hand-writes a layout-shaped response or a zone set.
`plannedLayouts(h)` reads the layout ids from `mapping.map(OUTLINE)` rather than restating them, and
`zonesOf(layoutId)` copies the layout's own `defaultZones`. The generation suite's 3-slide outline maps to
`title` → `section_divider` → `closing`, which is not what a hand-written fixture would have guessed — and
a template missing a required slot's zone fails `validateBrand`, so the export fixtures would have been
asserting against *that* error instead of against backgrounds.

### Decisions recorded because a future change will look reasonable

- **`GenerationServiceDeps.slides` is the repository, not `DeckService`.** `persist` writes records whose
  `flags`/`issue`/`order` the pipeline already decided; routing them through `DeckService.addSlide` would
  re-run budget enforcement on content that was deliberately truncated *and flagged*, and reassign the
  order it was given. Tested via the fallback row: a `bullets` slide with `flags` containing `fallback` and
  `issue.reason === "repair-failed"` survives the write intact.
- **`slidePlan` is keyed by slide id, not by `outcome.index`.** The regenerate path runs one slide, so an
  index-keyed lookup would work only by coincidence of the two numbers agreeing.
- **Generation clears the deck's slides up front.** An abort then leaves exactly the slides produced this
  run (§9), instead of a mix of old and new that nothing distinguishes. The "outline has no slides" check
  runs **before** `clearSlides`, asserted with a deck that keeps its existing 3 slides on refusal.
- **A hand-added slide cannot be regenerated** — 409 `DeckNotReady` naming "edit it directly", zero model
  calls, slide byte-identical. Without `source` there is no content to prompt from and no fallback
  material; inventing either is the one thing §0.4 forbids.
- **`ExportRequest` carries no repository, asset store, or `userId`** — asserted on
  `Object.keys(request).sort()`, because an accidental passthrough type-checks against excess-property
  rules only at the object literal, not at the assertion.
- **Backgrounds share one object across layouts using the same asset**, asserted with `toBe` rather than
  `toEqual`. §1.1/C3: pptxgenjs does not dedupe identical media (611 KB / 15 parts → 146 KB / 1 part in
  the probe), so the exporter must build one master per *distinct* background, and object identity is how
  it recognises the distinct set without comparing bytes. Step 13 depends on this.
- **`buildRequest` is public and deep-equals what `export` passes.** §8's zone-fidelity check uses it as
  its fixture builder; a second assembly path would mean the fidelity comparison was validating its own
  reconstruction.
- **Prototype keys are rejected at both registries.** `exporters["toString"]` under a bare index resolves
  to a function that would then be *called* as an exporter, and both format and layout ids arrive from URL
  segments. `Object.hasOwn` in both services; `["toString","constructor","__proto__","valueOf"]` tested
  explicitly.
- **A wiring mismatch fails loudly**: an exporter filed under `"ppt"` reporting `format: "pptx"` throws
  `… — fix lib/container.ts` rather than handing the user a `.ppt` containing pptx bytes.
- **`formats()` is sorted.** Object key order is insertion order and the container's insertion order is
  not a UI decision; an unsorted menu reshuffles under the user's cursor between deployments.

### Error-code semantics settled at this layer

The wizard has three stages, so "which one" is the entire useful content of a precondition error. Each
absence gets its own message: no briefing → "Fill in the briefing…", no outline → "Generate an outline…",
no slides → "…Generate them before exporting." All are **409 `DeckNotReady`** (well-formed request, the
fix is an action on the deck), distinct from **502 `GenerationFailed`** (upstream AI) and **400**
`UnknownLayout` / `UnknownExportFormat` / `InvalidSlideContent` (bad input). `RETRYABLE` stays
`{ModelThrottled(503), ModelUnavailable, ModelTimeout(504)}`, and a throttle from the outline path
surfaces as itself, per step 11's carry-forward.

### Testing notes worth keeping

- **vitest does not typecheck.** All six suites were green under `vitest run` while `tsc` still had 4
  errors (a widened `contentType: string` vs `AssetMimeType`, and a `TS2352` needing a cast through
  `unknown`). `npm run verify` is the gate; a green test run is not.
- `toMatchObject({ key: undefined })` is a **no-op** — it asserts nothing. Key *absence* needs
  `Object.hasOwn(...)` / `toBeUndefined()`.
- JS default parameters swallow an explicit `undefined`, so harness helpers take `null` for "omit this"
  (`readyDeck(h, outline: Outline | null = OUTLINE, …)`).

### Carry-forward for §2 step 13 (`lib/export/pptx-exporter.ts`)

- **First task: add `exporters` to `Container`, wire `ExportService` through the factory, and switch
  `tests/export-service.test.ts` to `h.services.export`.** The assertions do not change; if they do, the
  hand-wiring was hiding something.
- `ExportRequest.backgroundsByLayoutId` shares **one object** per distinct asset. Build one slide master
  per distinct background, keyed on identity — not per layout (C3), and not by comparing bytes.
- Truncation is ours (**C1**: `fit:'shrink'` never shrinks, verified on click), and every bullet run must
  go through the one shared helper that always sets `breakLine` (**C5**). Both are already enforced
  registry-wide by step 8; the exporter must not reintroduce a second path.
- `exportFilename` is exported for exporters to share — two sanitizers is how one of them emits a `/`.
- Zones must come from the same `resolveZones` the React renderer uses (§8), and the percent→inches math
  from the one shared util. Step 8 recorded that the divergence risk here is structural.
- The desktop-PowerPoint open-test (⚠️ VERIFY #1) is still **deferred, not waived**. Step 13's DoD box
  stays unchecked until a desktop Office install is available; `npm run verify:render:all` plus
  LibreOffice / PowerPoint-on-the-web is what can be automated here.

---

## §2 step 13 — `lib/export/pptx-exporter.ts` COMPLETE (2026-08-02)

`npm run verify` green: **27 test files, 960 tests**, lint and both typecheck projects clean.
`npm run verify:pptx:probes` green, now including `verify-pptx-paragraphs.ts` and
`verify-pptx-numbering.ts`.

The exporter is the ONE file in the app importing pptxgenjs. Everything above it talks to `PptxTarget`,
which is what keeps `lib/layouts` importable from the brand editor and §5's lint free of per-file
exemptions.

### The fixture deck is the deliverable, and it found three things the suite could not

CLAUDE.md §2 step 13 asks for "a fixture deck covering every seed layout, templated AND token-styled."
`scripts/export-fixture-deck.ts` (`npm run verify:pptx:fixture`) writes two decks —
`out/FIXTURE-TOKEN.pptx` and `out/FIXTURE-TEMPLATED.pptx`, 8 slides each, one per registry entry in
registry order — through the **real** path: `createContainer()` → `ExportService` → `PptxExporter` →
each layout's own `toPptx`.

That last point is why it exists separately from `verify-pptx-opentest.ts`. The opentest script is a
§1.1 *spike*: it hand-builds pptxgenjs calls with its own copies of the zone and letterbox math, so it
proves the library works and says nothing about whether we drive it correctly. Rendering the real path
through LibreOffice (`npm run verify:pptx:fixture:render`) immediately surfaced **three defects that
960 passing tests were green through**:

| # | Defect | Why every existing test missed it |
|---|---|---|
| 1 | A numbered list rendered `1. 1. 1. 1. 1. 1.` | pptxgenjs writes `<a:buAutoNum startAt="N"/>` on EVERY numbered paragraph and defaults N to 1; in OOXML a `startAt` **restarts** the sequence. The C5 assertions count paragraphs and bullets — all correct here. The one test whose NAME covered it (`"carries numbering on every item when asked"`) asserted `toEqual({type:'number'})` per run, i.e. it asserted the bug. |
| 2 | The accent rule **struck through** the title on `agenda`, `bullets`, `closing` | Each layout held a literal `RULE = {x, y}` whose `y` was picked for a ONE-line title. Three of four were *inside* their own title zone. No test asserted ornament geometry at all. |
| 3 | List items at exactly `itemMaxChars` wrap to two lines in Verdana + CJK | Not a new defect — this is `capacity.ts`'s already-documented `AVG_ADVANCE_EM = 0.5` limitation (CJK is ~1em/glyph, Verdana is wide). Recorded because the fixture is the first place it is *visible*. See below. |

Both real defects are now asserted against the serialized XML in `tests/pptx-exporter.test.ts` →
*"regressions from the step-13 fixture render"*, so the eye was needed once rather than every time.

### Defect 1 — numbering, and why the type now forbids the mistake

Probed in both directions before fixing (`scripts/verify-pptx-numbering.ts`, run in
`verify:pptx:probes`):

```
Q1 bullet:{type:'number'}          startAt = [1, 1, 1]   ❌ defect reproduced
Q2 + numberStartAt: i+1            startAt = [1, 2, 3]   ✅ fix confirmed
Q3 bullet:true                     startAt = []          ✅ glyph bullets never affected
```

`bulletRuns` now stamps `numberStartAt: index + 1`, alongside the `breakLine` it already stamped for
C5 — same helper, same reason. Two details worth keeping:

- **`PptxTextRun`'s type makes `numberStartAt` REQUIRED** on a numbered bullet
  (`{ type: "number"; numberStartAt: number }`). A future layout cannot construct a numbered run
  without it, so the compiler now enforces what the probe discovered.
- **The empty-item filter runs BEFORE numbering.** Otherwise dropping a blank item 2 would emit
  1, 3, 4 — a list that looks like it lost an entry, which is worse than the blank it avoided. Asserted.

### Defect 2 — the ornament held a stale copy of a number that lives in the zone

The fix is not a better `y`. Zones are **user-editable**, so any literal would drift again the moment
someone moved a title in the brand editor's zone table. `ruleAboveZone(args, slotKey, w)` in
`paint.tsx` derives the rule from the live resolved zone, and the paired `AccentRuleAbove` /
`accentRuleAbovePptx` are what the four layouts call — one derivation, two renderers, exactly the
`paintPptx`/`paintPreview` argument applied to ornaments instead of slot content.

Above rather than below, because a rule *under* a variable-height text block either floats (short
title) or is overrun (wrapped title); the top edge is the only edge that does not move with the
content. Each layout now declares only `RULE_W`.

The regression test identifies the rule by **shape** (short, narrow, non-zero) and asserts its
`y + cy ≤ titleZone.y` — deliberately not by coordinates, since hardcoding them here would restore the
duplicated constant that caused the defect. One trap found while writing it: every slide part opens
with the `<p:spTree>`'s own `<a:xfrm>` at `0,0,0,0`, which satisfies any "smaller than" filter and made
a templated slide appear to still carry a rule. Hence `isRuleShaped`'s positive-size check.

### Defect 3 — recorded, not fixed, and why

The fixture fills every list to `maxItems` and pads each item to `itemMaxChars`, deliberately: a budget
is only a real constraint at the count and length the layout claims to support, and C1 means nothing
shrinks to rescue an overrun. At that worst case, `bullets`/`agenda` items wrap to two lines in Verdana
with CJK — so 6 items overflow their zone.

This is the `AVG_ADVANCE_EM` caveat `capacity.ts` already carries in its header, now observed rather
than predicted: 0.5em/char is a Latin mean, CJK is ~1em, and Verdana is wider than the faces the probe
measured. It is **not** an exporter defect and the fix is not in step 13 — the honest options are a
per-face advance (needs the deferred desktop open-test for real metrics) or lower `itemMaxChars` for
list slots. Left as a flagged ⚠️ VERIFY rather than silently tightening budgets on one renderer's
evidence.

### What the LibreOffice render DID confirm

- **Fonts are not substituted**: Georgia renders as a serif and Verdana as a distinct sans on every
  slide, and CJK glyphs are intact. This is LibreOffice, not desktop Office — see ⚠️ VERIFY #1.
- **§1.1/C3 holds visibly**: the templated deck is 390 KB against the token deck's 126 KB for 8
  identical-byte backgrounds, i.e. media is genuinely not deduped, exactly as the probe measured.
- **Templated mode suppresses ornaments AND the logo** while painting slot content identically — the
  brand background carries its own logo, and stamping a second is the off-brand-by-accident outcome
  templates exist to prevent.
- `quote`'s vertical rule and `stats`' card panels sit clear of their text; `stats`' cards are placed by
  its own `cardColumns`, the same function the test asserts against.

### Five OOXML package facts, probed rather than assumed

Each was measured with a throwaway probe while writing the suite. **Two of them would have produced
silently-vacuous tests**, which is the §0.1 failure mode in its purest form:

1. `defineSlideMaster` lands in **`ppt/slideLayouts/slideLayoutN.xml`** (named by the passed title).
   There is exactly ONE `slideMaster1.xml` no matter how many masters are defined — so the obvious
   `slideMasters/` count reads `1` forever and the C3 assertion would have passed while asserting
   nothing. Hence `Package.layoutNames` + `brandMasters()`.
2. JSZip lists **directory entries**, so `ppt/media/` itself counted as an image — off by one in the
   direction that *hides* a duplicate. Hence `.filter((n) => !zip.files[n]!.dir)`.
3. pptxgenjs writes a notes part for **every** slide, empty ones included, so a count is meaningless;
   the TEXT is the assertion (and the trailing slide-number run must be stripped).
4. `<p:pic>` geometry is **pretty-printed across lines** while text shapes are adjacent — a regex
   requiring adjacency silently returned zero matches for every image.
5. `company` → `docProps/app.xml`; `author` → `core.xml` as `dc:creator`. Probing this also revealed the
   exporter never set `author`, so **pptxgenjs credited itself**; now asserted
   (`expect(pkg.core).not.toContain("PptxGenJS")`).

### Decisions worth recording

- **C5's export-time backstop is a boundary check, not a re-count.** `assertBulletParagraphs` asserts
  *of the runs in this text box carrying a bullet, all carry `breakLine`* — the exact condition C5 turns
  on. The original plan (compare against `paintPptx`'s `listParagraphs`) cannot work: `toPptx` returns
  `void`, so every layout discards that value, and deriving the count from `slots` would be wrong for
  `stats`, whose list slots render as card text rather than bullets. The serialized-paragraph proof
  lives in the suite instead.
- **A non-16:9 background forfeits dedup rather than distorting.** A master background always stretches
  (`<a:stretch><a:fillRect/>`, no `srcRect`), so `masterFor` returns `undefined` for such an asset and it
  is placed at slide level via `placeBackground(..., "contain")` — pillarboxed against the token
  background, which is the documented §8 choice.
- **A background with no bytes is skipped (C4).** pptxgenjs validates nothing and throws at `write()`,
  i.e. the whole export fails at the very end. Degrading that one slide to token-styled yields a
  complete slide and matches `resolveRenderAssets`' own decision.
- **`toBytes` narrows by `instanceof` rather than casting**, so a future pptxgenjs returning something
  other than a Buffer fails loudly here instead of producing a corrupt download.
- **`LOGO_BOX` is exported** precisely so step 16's preview consumes it rather than hand-copying the
  numbers — §8 applied to the logo. Its width derives from the image's intrinsic aspect, never fixed.
- **`tsconfig.scripts.json` gained `paths` and `jsx`.** A script driving the real exporter transitively
  imports `lib/**` (whose modules use `@/…`) and the layout registry (whose entries are `.tsx`, because
  §4 co-locates each layout's `FallbackRenderer` with its `toPptx`). No `baseUrl` — deprecated in TS 6.0
  and removed in 7.0; `paths` resolves relative to the config file without it.

### ⚠️ VERIFY — step 13's additions

5. **Desktop PowerPoint open-test still DEFERRED, not waived (⚠️ VERIFY #1).** The fixture decks exist
   and render correctly under LibreOffice 26.2.5.2, but no desktop Office install is available here.
   Bytes cannot prove the absence of font substitution, so CLAUDE.md §13's "opened in real PowerPoint"
   box stays **unchecked**. To close it: `npm run verify:pptx:fixture`, open both files, confirm heading
   text is Georgia and body text is Verdana on every slide (each slide's title names its layout, so a
   substitution is traceable to a specific one).
6. **`AVG_ADVANCE_EM = 0.5` overestimates capacity for Verdana and badly for CJK** — now *observed* in
   the fixture render (defect 3 above), not merely predicted. Budgets have headroom against the estimate
   and nothing branches on it at render time, so this cannot produce nondeterministic output. Closing it
   needs per-face metrics from the deferred desktop open-test.

### Carry-forward for §2 step 14 (`lib/facade/studio-facade.ts`)

- Every port is now wired in `lib/container.ts`; the facade is assembled from exactly
  `Container.services`. Nothing below it needs to change.
- `exporters` is keyed by `Exporter.format` and `ExportService.formats()` returns it **sorted** — that
  ordering is the download menu's, so it must not depend on the container's insertion order.
- The route layer must set `Content-Disposition` from `ExportResult.filename` (already sanitized by the
  one shared `exportFilename`) and `Content-Type` from `PPTX_CONTENT_TYPE`.
- When the preview lands (step 16), it must consume `resolveZones`, `zoneToInches`, `LOGO_BOX`, and
  `ruleAboveZone` — the four things the export path derives its geometry from. §8 divergence is
  structural, and every one of these exists so there is nothing to hand-copy.

---

## §2 step 14 — `lib/facade/studio-facade.ts` (2026-08-02)

`npm run verify` green: **28 test files, 980 tests**, lint + both typecheck projects clean.

### What the facade adds over the services

Most of its 34 methods are one-line delegations, and that is the point — they exist so `app/**` has a
path that is not `lib/services/**` (lint-enforced, §5). Three things are genuinely this layer's:

1. **Authentication.** Every method takes `Headers` and derives its own `userId`; `Unauthorized` (401) is
   raised here because the port returns `null` and the *meaning* of absence is the caller's call. The
   security property is structural rather than reviewed: there is **no `userId` parameter to get wrong**,
   so a new route cannot introduce either an unauthenticated read or — the far worse case — a
   client-supplied `userId` writing into another user's partition.
2. **Multi-service orchestration.** Four methods: `createDeck` (brand existence check), `switchBrand`
   (validate + re-resolve templates), `workspace` (deck + slides + brand + tokens + templates in ONE
   call, so all five describe one revision), and the private `templatesFor`.
3. **The streaming seam.** `generateDeck` takes an `emit` callback, not a stream. The facade owns *which*
   events occur; the route owns SSE framing. That split is why the §9 matrix needs no HTTP server.

### Two gaps step 14 exposed in lower layers

- **`/api/assets/:id` had nothing to call.** Both asset stores return that URL from `resolveUrl`, but no
  service exposed `getStream`, and the facade may not touch a port directly (§5). Added
  `BrandService.getAssetStream` — on `BrandService` because it already owns the `AssetStore` port and
  assets *are* brand assets. It deliberately does NOT route through `resolveOrSkip`: a **serving** request
  for missing bytes is a 404, where a *render* path is right to degrade silently to token-styled.
  The serving URL carries **no userId** (deliberately — so it cannot be used to probe another partition),
  which makes the facade's principal the only scoping there is. Another user's id yields
  `AssetNotFound` **404, not 403**: a distinguishable "exists but forbidden" turns the URL space into an
  id oracle.
- **`tests/service-harness.ts` had a latent userId mismatch.** It declared `userId: "user-a"` while the
  stub provider returned `defaultUserId` (`"local-user"`). Nothing read it before, because the suites
  passed `harness().userId` straight to a service. The facade derives its userId from the *provider*, so
  the mismatch would have made every facade write land in one partition and every direct-service read
  look in another. Fixed by pinning `defaultUserId: "user-a"` in the harness config and reading
  `Harness.userId` back from `container.config`, so the two cannot drift again.

### Mutation-tested, not just green

Step 13's lesson was that passing tests prove nothing until you watch them fail. Each of these was
reintroduced into the facade and the suite re-run:

| Mutation | Caught by |
|---|---|
| `createDeck`'s brand pre-check removed | 2 tests — including the cross-user "another user's brand" case |
| `userId()` trusts an `x-user-id` header | "ignores a header claiming a different user" |
| `templatesFor` stops narrowing to used layouts | "resolves templates for exactly the layouts the deck uses" |

All three restored; suite green. The header-trust mutation is the one worth naming — it is the
authorization hole the whole no-`userId`-parameter design exists to foreclose, and it is now covered by a
test rather than by a comment.

### Decisions

- **`getFacade()` in `lib/container.ts`** is what routes import. Offering it instead of making routes
  reach through `getContainer().services` means §5's "routes call the facade, not services" holds because
  there is no path to a service, not because someone remembers the rule.
- **The facade is built from the named `services` object**, not inline, so routes and tests share one set
  of service instances — otherwise `container.services` would hand tests a second, independently
  constructed graph while routes wrote through the first. Asserted directly.
- **Eager, like the services**: it holds references and constructs nothing, so building it cannot resolve
  credentials (§1.3 unaffected). Asserted stateless (`Object.keys(facade) === ["deps"]`) — a caching
  facade would defeat `workspace`'s single-revision guarantee.
- **A structural test reads the source** and asserts no public method takes a `userId:` parameter. A
  signature is not introspectable at runtime, and this is the property that must not regress.
- **A coverage test lists all 34 methods** against SPEC §3's endpoint table, so a missing use-case
  surfaces now rather than at step 15, when the tempting fix is to reach past the facade.

### Two test-fixture corrections worth recording

- **Layout ids are not `VisualHint`s.** `outlineOf(["bullets"])` typechecked as `string` in vitest but
  failed `npm run verify` — the hint vocabulary is `opening | agenda | section | list | comparison |
  quote | …`. Another instance of the standing note: **vitest does not typecheck; `npm run verify` is the
  gate.**
- **Scripting canned responses per *hint* is wrong.** The mapping chain's Positional rule gives a deck's
  first slide `title` whatever its hint, so a `bullets`-shaped response fails validation and lands as a
  *fallback* slide — which reads as a facade bug in the `ok`/`failed` counts. The helper now reads planned
  layouts from `mapping.map(outline)` (same approach as `plannedLayouts` in the generation suite) and
  asserts `failed === 0`, so a downstream read test cannot silently exercise fallback content.

### Carry-forward for §2 step 15 (`app/api/*`)

- **Routes get `getFacade()` and nothing else.** No `userId` is ever passed in or read from a header.
- **Errors**: `AppError.status` and `toReadable()` already carry the request-level mapping; the in-stream
  equivalent is `toFatalEvent`. Both required by §13 ("readable request-level AND in-stream").
- **Export route**: `Content-Disposition` from `ExportResult.filename` (sanitized by the one shared
  `exportFilename`), `Content-Type` from `ExportResult.contentType`.
- **SSE route**: encode `StreamEvent`s from the `emit` callback `generateDeck` already takes; the facade
  emits, the route frames. Client abort maps to the `signal` option — the §9 abort row.
- **Asset route**: `facade.serveAsset(headers, assetId)` returns a `ReadableAsset` whose `body` is a WEB
  `ReadableStream`, returnable directly from a Next route handler.
- Still open and unchanged by this step: ⚠️ VERIFY #5 (desktop PowerPoint open-test — deferred, not
  waived) and #6 (`AVG_ADVANCE_EM` per-face metrics). Docker smoke remains skipped by user decision.
