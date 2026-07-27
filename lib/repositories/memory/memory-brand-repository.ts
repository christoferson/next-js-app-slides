/**
 * CLAUDE.md §2 step 4 — in-memory `BrandRepository`, built BEFORE the file impl.
 *
 * It is not a toy: it is both the test harness for every layer above and the swap proof itself
 * (§6.3 — "a mock second backend can be registered via one factory case and the full test suite
 * passes"). If the ports were shaped around the filesystem, this class would be awkward to
 * write; that it is trivial is evidence the abstraction is clean.
 *
 * Stored values are deep-cloned on the way in and out. Without that, a caller mutating a
 * returned object would silently edit "persisted" state — a bug class that cannot exist in the
 * file impl, so allowing it here would make the two backends behave differently and let tests
 * pass against one but not the other.
 */

import type { BrandRepository } from "@/lib/ports/repositories";
import type { BrandDefinition, BrandSummary } from "@/lib/brand/types";
import { BrandNotFound } from "@/lib/errors/errors";

const clone = <T>(value: T): T => structuredClone(value);

/** Projection matching what a DynamoDB impl would fetch — never the full config. */
function toSummary(brand: BrandDefinition): BrandSummary {
  return {
    id: brand.id,
    name: brand.name,
    colors: clone(brand.colors),
    fonts: clone(brand.fonts),
    ...(brand.logo ? { logo: clone(brand.logo) } : {}),
    templatedLayoutIds: Object.keys(brand.templates).sort(),
    createdAt: brand.createdAt,
    updatedAt: brand.updatedAt,
  };
}

export class MemoryBrandRepository implements BrandRepository {
  /** userId → brandId → brand. Nested by user so no operation can read across users. */
  private readonly byUser = new Map<string, Map<string, BrandDefinition>>();

  private bucket(userId: string): Map<string, BrandDefinition> {
    let b = this.byUser.get(userId);
    if (!b) {
      b = new Map();
      this.byUser.set(userId, b);
    }
    return b;
  }

  async create(userId: string, brand: BrandDefinition): Promise<BrandDefinition> {
    // `userId` from the caller wins over anything in the payload — a client-supplied userId must
    // never be able to write into another user's partition.
    const stored: BrandDefinition = { ...clone(brand), userId };
    this.bucket(userId).set(stored.id, stored);
    return clone(stored);
  }

  async get(userId: string, brandId: string): Promise<BrandDefinition | null> {
    const found = this.byUser.get(userId)?.get(brandId);
    return found ? clone(found) : null;
  }

  async list(userId: string): Promise<BrandSummary[]> {
    const bucket = this.byUser.get(userId);
    if (!bucket) return [];
    // ULID ids sort by creation time; newest first is what the gallery wants.
    return [...bucket.values()]
      .map(toSummary)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async update(userId: string, brandId: string, brand: BrandDefinition): Promise<BrandDefinition> {
    const bucket = this.byUser.get(userId);
    // `update` must never silently create — that would let a stale client resurrect a deleted
    // brand. `get` returns null for absence (policy stays in the service), but a WRITE to a
    // missing key is unambiguously an error, and both backends must raise the same one so the
    // shared contract suite (§6) can assert it.
    if (!bucket?.has(brandId)) throw BrandNotFound(brandId);
    const existing = bucket.get(brandId)!;
    const stored: BrandDefinition = {
      ...clone(brand),
      id: brandId,
      userId,
      createdAt: existing.createdAt, // immutable once set
    };
    bucket.set(brandId, stored);
    return clone(stored);
  }

  async delete(userId: string, brandId: string): Promise<void> {
    // Idempotent: deleting an absent brand is a no-op, matching an S3/DynamoDB delete.
    this.byUser.get(userId)?.delete(brandId);
  }
}
