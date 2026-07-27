/**
 * Test fixtures. Values are deliberately LOUD and greppable (`#FF00AA`, `Zapfino`, `x: 42`) so
 * the §7 prompt-purity test can assert none of them ever reach a prompt string.
 */

import type { BrandDefinition } from "@/lib/brand/types";
import type { DeckMeta, Slide } from "@/lib/domain/deck";
import type { AssetMeta } from "@/lib/domain/asset";
import { ulid } from "@/lib/util/ids";

export const AT = "2026-01-01T00:00:00.000Z";

export function makeBrand(overrides: Partial<BrandDefinition> = {}): BrandDefinition {
  return {
    id: ulid(),
    userId: "user-a",
    name: "Loud Brand",
    colors: {
      primary: "#FF00AA",
      secondary: "#00FFAA",
      accent: "#AA00FF",
      background: "#0B0B14",
      surface: "#1A1A2E",
      textOnLight: "#111111",
      textOnDark: "#FAFAFA",
    },
    fonts: { heading: "zapfino", body: "georgia" },
    tone: { voice: "wry", traits: ["direct", "concrete"], bannedWords: ["synergy", "leverage"] },
    templates: {
      title: {
        backgroundAssetId: "asset-bg-title",
        // Asymmetric on purpose — §8's zone-fidelity check needs positions that are obviously
        // wrong if either consumer applies its own centering.
        zones: [
          { slotKey: "title", x: 8, y: 12, w: 60, h: 20, align: "left", valign: "top" },
          { slotKey: "subtitle", x: 8, y: 42, w: 42, h: 12, align: "left", valign: "top" },
        ],
      },
    },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function makeDeck(overrides: Partial<DeckMeta> = {}): DeckMeta {
  return {
    id: ulid(),
    userId: "user-a",
    title: "Q3 Review",
    brandId: "brand-1",
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function makeSlide(overrides: Partial<Slide> = {}): Slide {
  return {
    id: ulid(),
    order: 0,
    layoutId: "title",
    slots: { title: "Hello", subtitle: "World" },
    flags: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function makeAssetMeta(overrides: Partial<AssetMeta> = {}): AssetMeta {
  return {
    filename: "bg-16x9.png",
    contentType: "image/png",
    byteSize: 4,
    width: 1920,
    height: 1080,
    kind: "background",
    layoutId: "title",
    createdAt: AT,
    ...overrides,
  };
}
