/**
 * CLAUDE.md §2 step 4 — in-memory `AssetStore`.
 *
 * Lives under `repositories/memory` (not `adapters/`) alongside the other memory impls so the
 * whole in-memory backend — the swap proof of §6.3 — is one directory.
 *
 * `resolveUrl` returns the same local serving route the disk store uses. That is deliberate: if
 * this impl invented a `data:` URL instead, tests would exercise a URL shape production never
 * sees, and the contract suite could not assert URL behaviour across both backends.
 */

import type { AssetStore } from "@/lib/ports/asset-store";
import type { AssetKind, AssetMeta, AssetRecord, ReadableAsset, ResolvedAsset } from "@/lib/domain/asset";
import { AssetNotFound } from "@/lib/errors/errors";
import { ulid } from "@/lib/util/ids";

interface Entry {
  record: AssetRecord;
  bytes: Uint8Array;
}

export class MemoryAssetStore implements AssetStore {
  private readonly byUser = new Map<string, Map<string, Entry>>();

  private bucket(userId: string): Map<string, Entry> {
    let b = this.byUser.get(userId);
    if (!b) {
      b = new Map();
      this.byUser.set(userId, b);
    }
    return b;
  }

  private require(userId: string, assetId: string): Entry {
    const entry = this.byUser.get(userId)?.get(assetId);
    if (!entry) throw AssetNotFound(assetId);
    return entry;
  }

  async put(userId: string, kind: AssetKind, data: Uint8Array, meta: AssetMeta): Promise<{ assetId: string }> {
    const assetId = ulid();
    // `kind` is the argument, not `meta.kind` — the caller's explicit intent wins, so a
    // mismatched payload can't file a logo under backgrounds.
    // Copy the bytes: the caller may reuse or detach its buffer after this resolves.
    this.bucket(userId).set(assetId, {
      record: { ...meta, kind, id: assetId, byteSize: data.byteLength },
      bytes: Uint8Array.from(data),
    });
    return { assetId };
  }

  async getStream(userId: string, assetId: string): Promise<ReadableAsset> {
    const { record, bytes } = this.require(userId, assetId);
    return {
      id: record.id,
      contentType: record.contentType,
      byteSize: record.byteSize,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from(bytes));
          controller.close();
        },
      }),
    };
  }

  async getMeta(userId: string, assetId: string): Promise<AssetRecord | null> {
    const entry = this.byUser.get(userId)?.get(assetId);
    return entry ? { ...entry.record } : null;
  }

  async resolveUrl(_userId: string, assetId: string): Promise<string> {
    // Same shape the disk store returns; the route reads the asset via the authenticated
    // principal, so the userId is never part of the URL.
    return `/api/assets/${assetId}`;
  }

  async resolve(userId: string, assetId: string, options?: { withBytes?: boolean }): Promise<ResolvedAsset> {
    const { record, bytes } = this.require(userId, assetId);
    return {
      id: record.id,
      contentType: record.contentType,
      url: await this.resolveUrl(userId, assetId),
      ...(options?.withBytes ? { bytes: Uint8Array.from(bytes) } : {}),
      ...(record.width !== undefined ? { width: record.width } : {}),
      ...(record.height !== undefined ? { height: record.height } : {}),
      ...(record.luminance !== undefined ? { luminance: record.luminance } : {}),
    };
  }

  async delete(userId: string, assetId: string): Promise<void> {
    this.byUser.get(userId)?.delete(assetId);
  }
}
