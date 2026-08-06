/**
 * Asset domain types — brand backgrounds and logos (SPEC §5).
 *
 * Nothing here mentions a path or a directory. Assets are addressed by id and read as bytes or
 * streams; that is what lets the local-disk store be swapped for S3 with no service change
 * (CLAUDE.md §6.4: "no method returns a filesystem path").
 */

export type AssetKind = "background" | "logo";

/** Only the formats SPEC §5 allows. SVG is sanitized before it is ever stored. */
export type AssetMimeType = "image/png" | "image/jpeg" | "image/svg+xml";

export interface AssetMeta {
  /** Original upload name, for display only — never used to build a storage key. */
  filename: string;
  contentType: AssetMimeType;
  byteSize: number;
  /** Intrinsic pixel dimensions; absent for SVG without a viewBox. Drives the letterbox check. */
  width?: number;
  height?: number;
  kind: AssetKind;
  /** Which layout this background belongs to; unset for logos. */
  layoutId?: string;
  /**
   * Mean WCAG relative luminance of the image, 0..1 — sampled ONCE at upload (`ImageLuminancePort`).
   *
   * Absent when the bytes could not be decoded, or for an asset stored before this field existed. Both
   * cases mean "no information": the renderer then derives text colour from `brand.colors.background`
   * alone, which is the pre-existing behaviour.
   *
   * Stored rather than recomputed because it is a property of bytes that never change, and because the
   * decode is native — keeping it out of the render path is what lets `lib/brand` stay pure and
   * client-importable. See `lib/brand/background-luminance.ts` for the defect this closes.
   */
  luminance?: number;
  createdAt: string;
}

export interface AssetRecord extends AssetMeta {
  id: string;
}

/**
 * A readable asset. `body` is a WEB ReadableStream, not a Node `Readable`, deliberately: it is
 * what a Next route handler returns directly and what the S3 SDK already yields, so neither the
 * port nor its callers acquire a Node-stream dependency.
 */
export interface ReadableAsset {
  id: string;
  contentType: AssetMimeType;
  byteSize: number;
  body: ReadableStream<Uint8Array>;
}

/**
 * An asset resolved for rendering. Both the browser preview and `toPptx` need bytes-or-URL plus
 * the intrinsic size (for the letterbox math verified in §1.1/C2), so they share this shape.
 */
export interface ResolvedAsset {
  id: string;
  contentType: AssetMimeType;
  /** Servable URL — a local route in v1, a presigned S3 URL later. */
  url: string;
  /**
   * Raw bytes, present only when an exporter needs them (pptxgenjs embeds by data/base64).
   * The browser render path uses `url` and never populates this.
   */
  bytes?: Uint8Array;
  width?: number;
  height?: number;
  /** `AssetMeta.luminance`, carried through so the render path never needs a decoder. */
  luminance?: number;
}
