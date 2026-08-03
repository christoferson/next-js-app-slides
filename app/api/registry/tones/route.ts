/**
 * `GET /api/registry/tones` — the tone presets (SPEC §5).
 *
 * `promptFragment` is included, and that is deliberate: tone is the ONE brand-derived thing allowed into
 * a prompt (§7), so showing the user the exact sentence that will steer the model is honest rather than
 * leaky. There is no visual vocabulary in it — `tests/prompt-purity.test.ts` asserts that across the whole
 * registry, so this payload cannot become a channel for a hex value or a font name.
 *
 * `DEFAULT_BANNED_WORDS` ships with it because the editor's chips are seeded from it and the user's list
 * replaces it entirely; a client hardcoding those ten words would be a second copy of brand policy.
 */

import { handle, json } from "@/lib/http/route-helpers";
import { DEFAULT_BANNED_WORDS, DEFAULT_TONE_ID, TONES } from "@/lib/brand/tones";

export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return handle(async () => json(
    { tones: TONES, defaultToneId: DEFAULT_TONE_ID, defaultBannedWords: DEFAULT_BANNED_WORDS },
    { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" } },
  ));
}
