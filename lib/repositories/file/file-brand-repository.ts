/**
 * CLAUDE.md §2 step 5 — file-backed `BrandRepository`. Same contract suite as memory (§6.2).
 *
 * One JSON file per brand: a brand is always read and written whole (the editor and JSON import
 * both submit complete configs), so there is nothing to gain from splitting it — and one file per
 * entity keeps writes atomic without a lock on the read path.
 */

import type { BrandRepository } from "@/lib/ports/repositories";
import type { BrandDefinition, BrandSummary } from "@/lib/brand/types";
import { BrandNotFound } from "@/lib/errors/errors";
import { DataPaths } from "@/lib/repositories/file/paths";
import { KeyedMutex, listDir, readJsonFile, removeFile, writeJsonFile } from "@/lib/repositories/file/fs-util";

function toSummary(brand: BrandDefinition): BrandSummary {
  return {
    id: brand.id,
    name: brand.name,
    colors: brand.colors,
    fonts: brand.fonts,
    ...(brand.logo ? { logo: brand.logo } : {}),
    templatedLayoutIds: Object.keys(brand.templates).sort(),
    createdAt: brand.createdAt,
    updatedAt: brand.updatedAt,
  };
}

export class FileBrandRepository implements BrandRepository {
  private readonly paths: DataPaths;
  /** Serializes writes per brand so a read-modify-write in `update` cannot interleave. */
  private readonly locks = new KeyedMutex();

  constructor(dataDir: string) {
    this.paths = new DataPaths(dataDir);
  }

  async create(userId: string, brand: BrandDefinition): Promise<BrandDefinition> {
    // Caller's userId wins over the payload's — see the memory impl's note.
    const stored: BrandDefinition = { ...brand, userId };
    // `safeSegment` inside the path builder rejects a crafted id before any IO happens (§6.5).
    const file = this.paths.brandFile(userId, stored.id);
    await this.locks.withLock(file, () => writeJsonFile(file, stored));
    return stored;
  }

  async get(userId: string, brandId: string): Promise<BrandDefinition | null> {
    return readJsonFile<BrandDefinition>(this.paths.brandFile(userId, brandId));
  }

  async list(userId: string): Promise<BrandSummary[]> {
    const dir = this.paths.brandsDir(userId);
    const names = (await listDir(dir)).filter((n) => n.endsWith(".json"));
    const brands = await Promise.all(
      names.map((n) => readJsonFile<BrandDefinition>(this.paths.brandFile(userId, n.slice(0, -5)))),
    );
    return brands
      .filter((b): b is BrandDefinition => b !== null)
      .map(toSummary)
      // Newest first. ULID ids sort by creation time, so this needs no stored index.
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async update(userId: string, brandId: string, brand: BrandDefinition): Promise<BrandDefinition> {
    const file = this.paths.brandFile(userId, brandId);
    return this.locks.withLock(file, async () => {
      const existing = await readJsonFile<BrandDefinition>(file);
      // Never silently create — a stale client must not resurrect a deleted brand.
      if (!existing) throw BrandNotFound(brandId);
      const stored: BrandDefinition = {
        ...brand,
        id: brandId,
        userId,
        createdAt: existing.createdAt, // immutable once set
      };
      await writeJsonFile(file, stored);
      return stored;
    });
  }

  async delete(userId: string, brandId: string): Promise<void> {
    const file = this.paths.brandFile(userId, brandId);
    // Idempotent, like an object-store delete.
    await this.locks.withLock(file, () => removeFile(file));
  }
}
