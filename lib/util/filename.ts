/**
 * Download-name derivation — one implementation, two layers.
 *
 * Lives here rather than in `lib/services/export-service.ts` because BOTH sides need it and they may
 * not import each other: `ExportResult.filename` is produced by the exporter (`lib/export/**`, which
 * §5 forbids from importing `lib/services/**`), while `ExportService` needs the same function to build
 * the `Content-Disposition` name and to be testable without an exporter. Two copies of a sanitizer is
 * how one of them ends up emitting a name with a `/` in it.
 */

/**
 * A filesystem-safe download name derived from the deck title.
 *
 * The character class is a whitelist rather than a blacklist — a blacklist has to enumerate every
 * reserved character on every platform, and misses the next one.
 *
 * NFC, and `\p{M}` in the whitelist, because the whitelist is Unicode-aware and decomposition fights
 * it: NFKD splits `デ` into `テ` + a combining dakuten and `é` into `e` + a combining acute, and a
 * combining mark is neither `\p{L}` nor `\p{N}` — so each one became a hyphen *inside* the word
 * (`デッキ` → `テ-ッキ`, `Café` → `Cafe-`). Composing instead keeps those as single letters, and
 * allowing marks keeps the scripts NFC cannot precompose (Devanagari, Thai) intact.
 */
export function exportFilename(deck: { title: string }, extension: string): string {
  const base = deck.title
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base === "" ? "deck" : base}.${extension}`;
}
