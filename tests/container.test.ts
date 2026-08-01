/**
 * §3 + §6.3 — the composition root's own guarantees:
 *  - a backend swap is one config value, with nothing else changing;
 *  - an unknown backend fails fast with a readable message rather than defaulting silently;
 *  - importing the container has no side effects (so `/api/registry/*` works with no AWS/DATA_DIR).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContainer, getContainer, resetContainer } from "@/lib/container";
import { loadConfig } from "@/lib/config";
import { MemoryBrandRepository } from "@/lib/repositories/memory/memory-brand-repository";
import { FileBrandRepository } from "@/lib/repositories/file/file-brand-repository";
import { MemoryAssetStore } from "@/lib/repositories/memory/memory-asset-store";
import { LocalDiskAssetStore } from "@/lib/adapters/local-disk-asset-store";
import { makeBrand } from "@/tests/fixtures";

afterEach(() => resetContainer());

describe("container / factory", () => {
  it("selects the memory backend from config alone (the swap proof)", () => {
    const c = createContainer({ storageBackend: "memory", assetBackend: "memory" });
    expect(c.brands).toBeInstanceOf(MemoryBrandRepository);
    expect(c.assets).toBeInstanceOf(MemoryAssetStore);
  });

  it("selects the file backend from config alone", () => {
    const c = createContainer({ storageBackend: "file", assetBackend: "local", dataDir: "./data" });
    expect(c.brands).toBeInstanceOf(FileBrandRepository);
    expect(c.assets).toBeInstanceOf(LocalDiskAssetStore);
  });

  it("wires a usable backend end to end", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "deck-studio-container-"));
    try {
      const c = createContainer({ storageBackend: "file", assetBackend: "local", dataDir: dir });
      const brand = await c.brands.create("user-a", makeBrand({ userId: "user-a" }));
      await expect(c.brands.get("user-a", brand.id)).resolves.toEqual(brand);
      // The stub auth provider supplies the scoping key every repository call needs.
      await expect(c.auth.authenticate(new Headers())).resolves.toMatchObject({ userId: "local-user" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails fast on an unknown backend with a readable message", () => {
    expect(() => loadConfig({ STORAGE_BACKEND: "dynamodb" }))
      .toThrow(/STORAGE_BACKEND="dynamodb" is not supported\. Valid values: file, memory\./);
    expect(() => loadConfig({ ASSET_BACKEND: "s3" }))
      .toThrow(/ASSET_BACKEND="s3" is not supported/);
    expect(() => loadConfig({ AUTH_BACKEND: "cognito" }))
      .toThrow(/AUTH_BACKEND="cognito" is not supported/);
  });

  it("rejects out-of-range numeric config rather than clamping", () => {
    expect(() => loadConfig({ GENERATION_CONCURRENCY: "0" })).toThrow(/between 1 and 8/);
    expect(() => loadConfig({ MAX_ASSET_MB: "1.5" })).toThrow(/must be an integer/);
  });

  it("does not require any AWS configuration to build a container (§1.3)", () => {
    // No AWS_REGION, no DEFAULT_LLM_MODEL_ID: registries are static data, so the app must boot.
    const config = loadConfig({});
    expect(config.defaultLlmModelId).toBe("");
    expect(() => createContainer({ storageBackend: "memory", assetBackend: "memory" })).not.toThrow();
  });

  it("defaults OUTLINE_MODEL_ID to the default model", () => {
    const config = loadConfig({ DEFAULT_LLM_MODEL_ID: "us.anthropic.claude-opus-5" });
    expect(config.outlineModelId).toBe("us.anthropic.claude-opus-5");
    const overridden = loadConfig({
      DEFAULT_LLM_MODEL_ID: "us.anthropic.claude-opus-5", OUTLINE_MODEL_ID: "other",
    });
    expect(overridden.outlineModelId).toBe("other");
  });

  it("does not construct the Bedrock client until the LLM port is asked for (§1.3)", () => {
    // The reason `llm` is a thunk: building a `BedrockRuntimeClient` resolves credentials, and
    // `/api/registry/*` must serve with none configured. Nothing here calls `c.llm()`.
    const c = createContainer({ storageBackend: "memory", assetBackend: "memory" });
    expect(typeof c.llm).toBe("function");
  });

  it("returns the same LLM port on repeated calls rather than a client per request", () => {
    const c = createContainer({ storageBackend: "memory", assetBackend: "memory" });
    expect(c.llm()).toBe(c.llm());
  });

  it("accepts a mocked LLM port, so §9's matrix needs no AWS at all", () => {
    const fake = { complete: async () => ({ text: "" }), stream: () => (async function* () {})() };
    const c = createContainer({ storageBackend: "memory", assetBackend: "memory" }, { llm: fake });
    expect(c.llm()).toBe(fake);
  });

  it("returns a stable singleton that reset clears", () => {
    const a = getContainer();
    expect(getContainer()).toBe(a);
    resetContainer();
    expect(getContainer()).not.toBe(a);
  });
});
