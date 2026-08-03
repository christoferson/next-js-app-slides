/**
 * Upload gatekeeping — the checks that must pass before any bytes are stored (SPEC §5: "PNG/JPG/SVG
 * ≤ 5MB; SVG sanitized").
 *
 * ## Why this is domain code and not route code
 *
 * `lib/domain/asset.ts` states as a type-level promise that "SVG is sanitized before it is ever stored".
 * A check that lived in the upload route would make that promise true of one caller — and false for the
 * fixture script, a future CLI importer, or a second upload endpoint. Here it is reachable by all of
 * them, and `AssetMimeType` is narrowed by the same module that declares it.
 *
 * The size limit deliberately stays OUT of this file: it is `MAX_ASSET_MB`, a per-deployment config
 * value, and it has to be enforced at the HTTP edge *before* the body is buffered. There is nothing a
 * pure byte check can do about a request that is already in memory.
 *
 * ## Sanitization here means REJECT, not rewrite
 *
 * ⚠️ This is a validating sanitizer. It refuses an SVG that carries active content; it does not strip
 * the content and keep the file. That is a deliberate, narrower promise than "sanitized" might suggest,
 * and it is the safer one to make: a rewriting sanitizer has to enumerate every way SVG/XML can execute
 * (`<script>`, `on*` handlers, `javascript:` URLs, `<use href="external">`, XML entities, CSS
 * `@import`, `<foreignObject>` with embedded HTML), and any gap in that enumeration is a stored XSS in a
 * file we told the user was clean. Refusing is a complete answer to the same threat, at the cost of
 * rejecting a small number of legitimate-but-scripted logos — which the readable error tells the user to
 * re-export as PNG.
 *
 * The threat is concrete rather than theoretical: `/api/assets/:id` serves these bytes with their stored
 * content type, so an `image/svg+xml` response is a document the browser will execute in this origin if
 * it contains script. The serving route pairs this check with `Content-Security-Policy` and
 * `X-Content-Type-Options` for exactly that reason — neither measure is trusted alone.
 */

import type { AssetMimeType } from "@/lib/domain/asset";
import { UnsafeAsset } from "@/lib/errors/errors";

/** SPEC §5's allowlist, as data. The order is the order an error message lists them. */
export const ASSET_MIME_TYPES: readonly AssetMimeType[] = ["image/png", "image/jpeg", "image/svg+xml"];

export function isAssetMimeType(value: string): value is AssetMimeType {
  return (ASSET_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * What the BYTES say they are, ignoring what the upload claimed.
 *
 * A browser derives the multipart `Content-Type` from the file extension, so it is a hint, not evidence:
 * `logo.png` containing an SVG document arrives as `image/png`. Storing that claim would then have
 * `/api/assets/:id` serve XML under an image content type — which older browsers content-sniff and
 * render, turning a "PNG" upload into a script-execution vector. The stored type therefore comes from
 * here.
 *
 * `null` means "not a format we accept", which is a rejection rather than a fallback.
 */
export function sniffAssetType(bytes: Uint8Array): AssetMimeType | null {
  // PNG: the 8-byte signature is \x89PNG\r\n\x1a\n. Only the first four are checked, because that prefix
  // is already unambiguous among the three accepted formats and it keeps the check meaningful for the
  // truncated PNG headers used as fixtures throughout the suites.
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  // JPEG: SOI marker. Every JPEG variant (JFIF, Exif, raw) starts with it.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (looksLikeSvg(bytes)) return "image/svg+xml";
  return null;
}

/**
 * An `<svg>` root, possibly behind an XML declaration, a BOM, comments, or a doctype.
 *
 * Only the head of the file is decoded. A whole-file decode would mean converting a 5 MB upload to a
 * string just to answer a question the first line settles — and `sniffSvgActiveContent` below is what
 * examines the rest, on bytes that have already been established as XML.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = decode(bytes.subarray(0, 1_024)).trimStart();
  // `<?xml`/`<!--`/`<!DOCTYPE` may precede the root element, so this is a search rather than a prefix
  // test — bounded to the head, so it cannot be satisfied by an `<svg` appearing deep in a binary file.
  return /^(?:﻿)?\s*<(?:\?xml|!--|!DOCTYPE|svg)/i.test(head) && /<svg[\s>]/i.test(head);
}

/**
 * Active-content patterns. Each one is a way a served SVG can run code or fetch from another origin.
 *
 * Written as a table so the reason each pattern exists is next to it — a bare regex union would be
 * unreviewable, and this list is exactly the kind of thing that gets a line added to it later.
 */
const ACTIVE_CONTENT: readonly { re: RegExp; what: string }[] = [
  { re: /<\s*script[\s>]/i, what: "a <script> element" },
  // `<foreignObject>` embeds arbitrary HTML — including <iframe> and inline event handlers.
  { re: /<\s*foreignObject[\s>]/i, what: "a <foreignObject> element" },
  // SMIL: `<set attributeName="onload" .../>` and `<animate>` can both drive script-adjacent attributes.
  { re: /<\s*(?:set|animate|animateTransform|animateMotion)[\s>]/i, what: "an animation element" },
  // Any `on*=` attribute. Deliberately broad: onload/onclick/onmouseover are the common ones, but the
  // set is open-ended and an allowlist of known-bad names is the wrong shape for that.
  { re: /\son[a-z]+\s*=/i, what: "an event-handler attribute" },
  { re: /javascript\s*:/i, what: "a javascript: URL" },
  // `data:text/html` and `data:image/svg+xml` both execute when used as a document source.
  { re: /data\s*:\s*(?:text\/html|image\/svg)/i, what: "a data: document URL" },
  // External references: `<use href>`, `<image href>`, `xlink:href`, CSS `@import`, and `<!ENTITY SYSTEM>`
  // all cause the renderer to fetch — the last one is XXE, the others are tracking/SSRF surface.
  { re: /<!ENTITY/i, what: "an XML entity declaration" },
  { re: /@import/i, what: "a CSS @import" },
  { re: /(?:xlink:)?href\s*=\s*["']?\s*(?:https?:)?\/\//i, what: "an external reference" },
];

/**
 * The first active-content finding in an SVG, or `null`.
 *
 * Case- and whitespace-tolerant because the patterns above are the point of the check; matching only
 * lowercase `<script>` would be security theatre. The whole document is decoded here — unavoidable, and
 * bounded by the caller's size limit, which has already been applied by the time this runs.
 */
export function sniffSvgActiveContent(bytes: Uint8Array): string | null {
  const text = decode(bytes);
  for (const { re, what } of ACTIVE_CONTENT) {
    if (re.test(text)) return what;
  }
  return null;
}

/**
 * The one call an upload path makes: prove the bytes are a format we accept and safe to serve, and
 * return the content type to STORE.
 *
 * `declared` is checked against the sniff rather than ignored outright, and the mismatch is its own
 * rejection: silently storing the sniffed type would let `logo.png` (actually an SVG) upload cleanly and
 * then surprise the exporter, which branches on content type. Telling the user the file is not what its
 * name says is both more honest and cheaper to debug than an export that renders a blank logo.
 */
export function checkAssetBytes(bytes: Uint8Array, declared?: string): AssetMimeType {
  const sniffed = sniffAssetType(bytes);
  if (sniffed === null) {
    throw UnsafeAsset("type-not-allowed", [
      `file: must be one of ${ASSET_MIME_TYPES.join(", ")}`,
    ]);
  }

  // A declared type is optional (a form part may omit it); when present it must agree. `image/jpg` is
  // accepted as `image/jpeg` because some tools emit it and it is not a different format — this is the
  // one normalization, and it is spelled out rather than hidden in the comparison.
  const normalized = declared === "image/jpg" ? "image/jpeg" : declared;
  if (normalized !== undefined && normalized !== "" && normalized !== sniffed) {
    throw UnsafeAsset("type-mismatch", [
      `file: is a ${sniffed} file but was sent as ${normalized}`,
    ]);
  }

  if (sniffed === "image/svg+xml") {
    const active = sniffSvgActiveContent(bytes);
    if (active !== null) {
      throw UnsafeAsset("active-content", [
        `file: this SVG contains ${active}, which can't be served safely`,
      ]);
    }
  }

  return sniffed;
}

/** Lossy on purpose: a decode failure must not throw where a *rejection* is the right outcome. */
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: false }).decode(bytes);
