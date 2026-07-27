/**
 * CLAUDE.md §2 step 3 — the asset PORT (SPEC §4.3).
 *
 * The defining constraint (§6.4): **no method returns a filesystem path.** Reads yield a stream;
 * serving yields a URL. That is the whole reason a local-disk store and S3 are interchangeable —
 * a `Promise<string> // path` here would silently weld every caller to a POSIX filesystem.
 */

import type { AssetKind, AssetMeta, AssetRecord, ReadableAsset, ResolvedAsset } from "@/lib/domain/asset";

export interface AssetStore {
  /**
   * Store bytes and return the app-generated id. `data` is `Uint8Array`, not `Buffer`, so the
   * port carries no Node-only type (SPEC §4.3 says Buffer; Uint8Array is its supertype, keeping
   * Buffer callers valid while leaving the interface runtime-agnostic).
   */
  put(userId: string, kind: AssetKind, data: Uint8Array, meta: AssetMeta): Promise<{ assetId: string }>;
  /** Stream, not path — for the local serving route or a proxy download. */
  getStream(userId: string, assetId: string): Promise<ReadableAsset>;
  /** Metadata without transferring bytes; `null` when absent (mirrors the repository ports). */
  getMeta(userId: string, assetId: string): Promise<AssetRecord | null>;
  /** Serving URL: a local route in v1, a presigned S3 URL later. */
  resolveUrl(userId: string, assetId: string): Promise<string>;
  /**
   * Everything a renderer or exporter needs in one call: url + intrinsic size, plus bytes when
   * `withBytes` is set (pptxgenjs embeds images, it cannot fetch a URL server-side).
   */
  resolve(userId: string, assetId: string, options?: { withBytes?: boolean }): Promise<ResolvedAsset>;
  delete(userId: string, assetId: string): Promise<void>;
}
