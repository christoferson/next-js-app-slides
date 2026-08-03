/**
 * `GET /api/registry/fonts` — the font pickers' options (SPEC §5).
 *
 * ## Two lists, and the split is the whole point
 *
 * `fonts` is `selectableFonts()` — the seven `ratified` core faces, the ones an open-test has actually
 * confirmed render rather than silently substituting to Calibri. That is what the editor offers.
 *
 * `all` is the full registry including `gated` entries. It is here because a brand may *already* name a
 * gated font (imported JSON, a config written before an entry was gated), and an editor that could not
 * display that font's name would show the brand as having no heading face at all. It carries each entry's
 * `status`, `tier`, and `note`, so the UI can render it as a disabled option with the reason visible —
 * §12's "quality badges visible, never suppressed" applied to font risk.
 *
 * A single list with a flag would collapse those two needs into one and make "what may a user pick" a
 * client-side filter — i.e. a place the gating could be lost. Sending both keeps the decision here, where
 * `status` is defined.
 */

import { handle, json } from "@/lib/http/route-helpers";
import {
  DEFAULT_BODY_FONT_ID, DEFAULT_HEADING_FONT_ID, FONTS, selectableFonts,
} from "@/lib/brand/fonts";

export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return handle(async () => json(
    {
      fonts: selectableFonts(),
      all: FONTS,
      defaults: { heading: DEFAULT_HEADING_FONT_ID, body: DEFAULT_BODY_FONT_ID },
    },
    { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" } },
  ));
}
