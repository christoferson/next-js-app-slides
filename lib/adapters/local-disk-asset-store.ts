/**
 * CLAUDE.md §2 step 5 — the local-disk `AssetStore` (SPEC §14 places it in `adapters/`).
 *
 * Metadata and bytes are separate files (`{id}.json` + `{id}.bin`) so `getMeta`/`resolve` can
 * answer without reading the image — which matters because the export path resolves metadata for
 * every slide but needs bytes only for the distinct backgrounds (§1.1/C3).
 *
 * `getStream` returns a WEB `ReadableStream`, per the port. Node's `Readable.toWeb` conversion is
 * the only place a Node stream type appears, and it stops here.
 */

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { AssetStore } from "@/lib/ports/asset-store";
import type { AssetKind, AssetMeta, AssetRecord, ReadableAsset, ResolvedAsset } from "@/lib/domain/asset";
import { AssetNotFound } from "@/lib/errors/errors";
import { DataPaths } from "@/lib/repositories/file/paths";
import {
  exists, readJsonFile, removeFile, writeFileAtomic, writeJsonFile,
} from "@/lib/repositories/file/fs-util";
import { ulid } from "@/lib/util/ids";
import { readFile } from "node:fs/promises";

export class LocalDiskAssetStore implements AssetStore {
  private readonly paths: DataPaths;

  constructor(dataDir: string) {
    this.paths = new DataPaths(dataDir);
  }

  private async requireRecord(userId: string, assetId: string): Promise<AssetRecord> {
    const record = await readJsonFile<AssetRecord>(this.paths.assetMetaFile(userId, assetId));
    if (!record) throw AssetNotFound(assetId);
    return record;
  }

  async put(userId: string, kind: AssetKind, data: Uint8Array, meta: AssetMeta): Promise<{ assetId: string }> {
    const assetId = ulid();
    const record: AssetRecord = { ...meta, kind, id: assetId, byteSize: data.byteLength };
    // Bytes FIRST, then metadata: metadata is the existence marker, so this ordering means a
    // crash between the two writes leaves an orphaned .bin (harmless) rather than a record
    // pointing at missing bytes (a broken asset).
    await writeFileAtomic(this.paths.assetDataFile(userId, assetId), data);
    await writeJsonFile(this.paths.assetMetaFile(userId, assetId), record);
    return { assetId };
  }

  async getStream(userId: string, assetId: string): Promise<ReadableAsset> {
    const record = await this.requireRecord(userId, assetId);
    const dataFile = this.paths.assetDataFile(userId, assetId);
    if (!(await exists(dataFile))) throw AssetNotFound(assetId);
    return {
      id: record.id,
      contentType: record.contentType,
      byteSize: record.byteSize,
      // Streamed, not buffered — a 5 MB background should not sit in memory to be served.
      body: Readable.toWeb(createReadStream(dataFile)) as ReadableStream<Uint8Array>,
    };
  }

  async getMeta(userId: string, assetId: string): Promise<AssetRecord | null> {
    return readJsonFile<AssetRecord>(this.paths.assetMetaFile(userId, assetId));
  }

  async resolveUrl(_userId: string, assetId: string): Promise<string> {
    // A route, never a path (§6.4). The route authorizes via the principal, so no userId in the URL.
    return `/api/assets/${assetId}`;
  }

  async resolve(userId: string, assetId: string, options?: { withBytes?: boolean }): Promise<ResolvedAsset> {
    const record = await this.requireRecord(userId, assetId);
    return {
      id: record.id,
      contentType: record.contentType,
      url: await this.resolveUrl(userId, assetId),
      ...(options?.withBytes
        ? { bytes: new Uint8Array(await readFile(this.paths.assetDataFile(userId, assetId))) }
        : {}),
      ...(record.width !== undefined ? { width: record.width } : {}),
      ...(record.height !== undefined ? { height: record.height } : {}),
      ...(record.luminance !== undefined ? { luminance: record.luminance } : {}),
    };
  }

  async delete(userId: string, assetId: string): Promise<void> {
    // Metadata first — it is the existence marker, so the asset stops being visible immediately
    // and a crash mid-delete cannot leave a readable record with no bytes.
    await removeFile(this.paths.assetMetaFile(userId, assetId));
    await removeFile(this.paths.assetDataFile(userId, assetId));
  }
}
