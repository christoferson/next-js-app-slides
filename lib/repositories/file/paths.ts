/**
 * The one place the on-disk layout is defined. Every file impl builds paths from here, so the
 * layout can be reasoned about (and changed) in a single file, and every path is traversal-checked
 * by construction (`safeJoin` validates every segment).
 *
 * Layout under DATA_DIR:
 *   users/{userId}/brands/{brandId}.json
 *   users/{userId}/decks/{deckId}/meta.json
 *   users/{userId}/decks/{deckId}/slides/{slideId}.json   ← one file per slide (SPEC §4.3)
 *   users/{userId}/assets/{assetId}.json                  ← metadata
 *   users/{userId}/assets/{assetId}.bin                    ← bytes
 *
 * The per-slide files are not an implementation convenience: they mirror the item-per-slide
 * DynamoDB model so both backends share semantics, and they mean an inline slot edit rewrites one
 * small file instead of the whole deck.
 */

import { safeJoin } from "@/lib/repositories/file/fs-util";

export class DataPaths {
  constructor(private readonly root: string) {}

  userDir(userId: string): string {
    return safeJoin(this.root, "users", userId);
  }

  brandsDir(userId: string): string {
    return safeJoin(this.root, "users", userId, "brands");
  }

  brandFile(userId: string, brandId: string): string {
    return safeJoin(this.root, "users", userId, "brands", `${brandId}.json`);
  }

  decksDir(userId: string): string {
    return safeJoin(this.root, "users", userId, "decks");
  }

  deckDir(userId: string, deckId: string): string {
    return safeJoin(this.root, "users", userId, "decks", deckId);
  }

  deckMetaFile(userId: string, deckId: string): string {
    return safeJoin(this.root, "users", userId, "decks", deckId, "meta.json");
  }

  slidesDir(userId: string, deckId: string): string {
    return safeJoin(this.root, "users", userId, "decks", deckId, "slides");
  }

  slideFile(userId: string, deckId: string, slideId: string): string {
    return safeJoin(this.root, "users", userId, "decks", deckId, "slides", `${slideId}.json`);
  }

  assetsDir(userId: string): string {
    return safeJoin(this.root, "users", userId, "assets");
  }

  assetMetaFile(userId: string, assetId: string): string {
    return safeJoin(this.root, "users", userId, "assets", `${assetId}.json`);
  }

  assetDataFile(userId: string, assetId: string): string {
    return safeJoin(this.root, "users", userId, "assets", `${assetId}.bin`);
  }
}
