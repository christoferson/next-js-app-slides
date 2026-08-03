/**
 * Route request schemas — the ONLY validation `app/**` performs (SPEC §4.2: routes are "zod validate +
 * delegate + stream").
 *
 * ## What belongs here, and what deliberately does not
 *
 * These schemas describe **request shape**: is this JSON an object, does it have a `title` string, is
 * `temperature` a number in range. They do not describe domain rules. A brand's colours are validated by
 * `brandInputSchema`, an outline by `parseOutline`, a slide's slot budgets by `checkSlotBudgets` — all
 * reached through the facade, all owned by the layer that knows the rules. Routes hand those payloads
 * through as `unknown`, exactly as the facade's signatures ask for (`createBrand(headers, input: unknown)`).
 *
 * That split is why `brandBodySchema` is not here: re-declaring it at the route would create a second
 * place where "what a brand may contain" is written down, and the two would drift — the failure §4 calls
 * a parallel hardcoded table. What IS here is what only the HTTP edge knows: which endpoints take an
 * instruction, that `sectionIndex` is a non-negative integer, that a body must be an object at all.
 *
 * ## Why every schema is `strictObject`
 *
 * An unknown key is a client bug — a renamed field, a typo, a stale build — and silently ignoring it
 * means the request appears to succeed while doing something other than what was asked. `strictObject`
 * turns that into a 400 naming the key. The one place this is relaxed is where a schema forwards an
 * opaque payload to a domain validator (`z.unknown()`), because there the *domain* schema is strict.
 */

import { z } from "zod";
import { OUTLINE_LIMITS } from "@/lib/generation/outline-schema";

/* ─────────────────────────────── shared scalars ─────────────────────────────── */

/**
 * A user-typed instruction ("punchier", "more technical"). Capped because it is forwarded verbatim into
 * a prompt: an unbounded string is a way to push the briefing out of the model's attention, and a
 * megabyte of it is a way to burn tokens. 2 000 chars is far more than the UI's input offers.
 */
const instruction = z.string().trim().min(1, { error: "must not be empty" }).max(2_000, {
  error: "must be 2000 characters or fewer",
});

/**
 * Temperature. Clamped again server-side by `clampTemperature` against the model's own range — this
 * bound only rejects values that are not plausibly a slider at all, so a client sending 1.001 is
 * clamped (the registry's documented behaviour) rather than 400'd.
 */
const temperature = z.number().min(0, { error: "must be at least 0" }).max(2, {
  error: "must be 2 or less",
});

const index = z.number().int({ error: "must be a whole number" }).min(0, {
  error: "must be 0 or greater",
});

/**
 * A deck or slide title. Trimmed, non-empty, capped — the cap is what keeps `exportFilename` (which
 * slices to 80) from being the only thing standing between a pasted essay and a stored deck name.
 */
const title = z.string().trim().min(1, { error: "must not be empty" }).max(200, {
  error: "must be 200 characters or fewer",
});

/* ─────────────────────────────── decks ─────────────────────────────── */

/**
 * The briefing (SPEC §9's wizard step 2). `sourceText` is capped by `MAX_SOURCE_TEXT_CHARS`, which is a
 * *config* value — so the cap is applied by the route through `briefingSchema(maxSourceTextChars)`
 * rather than baked in here. That knob existed unconsumed until now (`AppConfig.maxSourceTextChars`);
 * this is where it takes effect.
 *
 * `targetSlideCount` is 5–30 per SPEC §9 ("slide count 5–30"). Rejected rather than clamped, unlike
 * temperature: a count outside that range is a client that has no slider, and silently generating 30
 * slides for a request that said 200 would be a surprising bill.
 */
export const briefingSchema = (maxSourceTextChars: number) =>
  z.strictObject({
    topic: z.string().trim().min(1, { error: "must not be empty" }).max(500, {
      error: "must be 500 characters or fewer",
    }),
    audience: z.string().trim().min(1, { error: "must not be empty" }).max(500, {
      error: "must be 500 characters or fewer",
    }),
    objective: z.string().trim().min(1, { error: "must not be empty" }).max(500, {
      error: "must be 500 characters or fewer",
    }),
    targetSlideCount: z.number().int({ error: "must be a whole number" })
      .min(5, { error: "must be at least 5" })
      .max(30, { error: "must be 30 or fewer" }),
    sourceText: z.string().max(maxSourceTextChars, {
      error: `must be ${maxSourceTextChars} characters or fewer`,
    }).optional(),
  });

/**
 * `POST /api/decks`. `brandId` is required — a deck with no brand cannot be rendered, previewed, or
 * exported, so there is no useful state in which it exists. The facade checks it is a brand this user
 * owns; this only checks it is a string.
 */
export const createDeckSchema = (maxSourceTextChars: number) =>
  z.strictObject({
    title: title,
    brandId: z.string().min(1, { error: "must not be empty" }),
    briefing: briefingSchema(maxSourceTextChars).optional(),
  });

/**
 * `PATCH /api/decks/:id`. Every field optional (the UI patches one thing at a time), but at least one
 * must be present: an empty patch that returned 200 would let a broken client believe it saved.
 *
 * `brandId` here IS the brand swap (SPEC §9's header control). It routes to `switchBrand`, not to a bare
 * meta write, because a swap must return re-resolved templates — see the facade's note.
 */
export const patchDeckSchema = (maxSourceTextChars: number) =>
  z.strictObject({
    title: title.optional(),
    brandId: z.string().min(1, { error: "must not be empty" }).optional(),
    briefing: briefingSchema(maxSourceTextChars).optional(),
  }).refine((v) => Object.values(v).some((x) => x !== undefined), {
    error: "must change at least one of: title, brandId, briefing",
  });

/* ─────────────────────────────── outline ─────────────────────────────── */

/**
 * `POST /api/decks/:id/outline` — generate. `sectionIndex` present ⇒ regenerate that section only
 * (SPEC §7.1's documented body: `{ instruction?, sectionIndex? }`).
 */
export const generateOutlineSchema = z.strictObject({
  instruction: instruction.optional(),
  sectionIndex: index.optional(),
  temperature: temperature.optional(),
});

/**
 * `PATCH /api/decks/:id/outline` — save edits.
 *
 * The outline itself is `unknown`: `OutlineService.save` runs it through the domain's own zod (which
 * also validates every `layoutOverride` against the registry, and is the same schema the generation
 * repair pass uses). Declaring the shape twice is how the route's copy ends up accepting a
 * `layoutOverride` the mapping chain will silently ignore.
 */
export const saveOutlineSchema = z.strictObject({
  outline: z.unknown(),
});

/**
 * `PUT /api/decks/:id/outline/slides/:si/:li/layout` — pin or clear one slide's layout.
 *
 * `null` clears it, and that is why the field is `nullable` rather than optional: "absent" and
 * "explicitly cleared" must be distinguishable, since the facade's `layoutId: string | null` treats the
 * second as a delete. An optional field would collapse them.
 */
export const layoutOverrideSchema = z.strictObject({
  layoutId: z.string().min(1, { error: "must not be empty" }).nullable(),
});

/* ─────────────────────────────── generation ─────────────────────────────── */

/**
 * `POST /api/decks/:id/generate` (SSE) and `POST …/slides/:sid/regenerate`.
 *
 * `density` and `includeSpeakerNotes` are SPEC §9's wizard step-4 options. They pass straight into
 * `GenerateDeckOptions` — the union is restated here because it is a request field, and a `z.enum` is
 * what turns a typo into a 400 naming the valid values instead of a silent default.
 */
export const generateSchema = z.strictObject({
  instruction: instruction.optional(),
  includeSpeakerNotes: z.boolean().optional(),
  density: z.enum(["concise", "standard", "detailed"]).optional(),
  temperature: temperature.optional(),
});

/* ─────────────────────────────── slides ─────────────────────────────── */

/**
 * `PATCH /api/decks/:id/slides/:sid`.
 *
 * `slots` is `Record<string, string | string[]>` and no more: which keys a layout accepts, and what
 * fits in each, is `DeckService.updateSlide`'s question (it compiles a schema from the layout's
 * `SlotSpec`s and raises `InvalidSlideContent` with field-level issues). What this schema owns is that
 * a slot value is not a number, an object, or a nested array — the shapes `SlotValue` does not admit and
 * that would otherwise reach the budget checker as a type it cannot measure.
 *
 * `speakerNotes` accepts the empty string, unlike a title: clearing notes is a normal edit, and there
 * is no other way to express it.
 */
export const patchSlideSchema = z.strictObject({
  slots: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  layoutId: z.string().min(1, { error: "must not be empty" }).optional(),
  speakerNotes: z.string().max(600, { error: "must be 600 characters or fewer" }).optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), {
  error: "must change at least one of: slots, layoutId, speakerNotes",
});

/**
 * `PUT /api/decks/:id/slides/order`.
 *
 * The list must name every slide in the deck — enforced by the repository, which rejects a partial
 * permutation rather than applying it (`InvalidSlideOrder`). Here it is only "a non-empty array of
 * non-empty strings", plus a cap that keeps a malicious body from allocating unboundedly before the
 * repository gets to count it.
 */
export const reorderSlidesSchema = z.strictObject({
  orderedIds: z.array(z.string().min(1, { error: "must not be empty" }))
    .min(1, { error: "must list at least one slide" })
    .max(OUTLINE_LIMITS.maxSlidesTotal * 2, { error: "lists more slides than a deck can hold" }),
});

/* ─────────────────────────────── brands ─────────────────────────────── */

/**
 * `POST /api/brands/:id/import` and `POST /api/brands` bodies.
 *
 * Opaque by design — see the header. The brand's own schema is the authority, and its issues reach the
 * client through `InvalidBrandConfig`'s allowlisted `issues` (`toErrorBody`), which is what SPEC §12's
 * "field-level readable zod errors" asks for.
 *
 * Why a schema at all, then: it rejects a body that is not an object — `null`, an array, a bare string.
 * `brandInputSchema` would reject those too, but with a message about the *whole config* rather than
 * about the request, and `validateBrandInput` on a non-object still costs a registry read and an asset
 * listing first.
 */
export const objectBodySchema = z.looseObject({});

/**
 * The TEXT fields of `POST /api/brands/:id/assets` — everything in the multipart form that is not the
 * file itself.
 *
 * `strictObject`, like the rest, and that matters more here than elsewhere: a form field is easy to
 * misname (`layout` for `layoutId`) and a background silently stored with no layout would attach to
 * nothing, appearing as a successful upload that changed nothing on screen.
 *
 * Absent from this schema, deliberately: `contentType`, `byteSize`, `width`, and `height`. All four are
 * derived from the bytes — the first by `checkAssetBytes`, the size by the facade, the dimensions by
 * `imageSize` — because a client's claim about any of them is either unverifiable or a security
 * decision (see `BrandService.addAsset`). Accepting them as fields would be offering a lie a path in.
 */
export const uploadFieldsSchema = z.strictObject({
  kind: z.enum(["background", "logo"]),
  layoutId: z.string().min(1, { error: "must not be empty" }).optional(),
}).refine((v) => v.kind !== "background" || v.layoutId !== undefined, {
  error: "layoutId is required for a background image",
  path: ["layoutId"],
});
