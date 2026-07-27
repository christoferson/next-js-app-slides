/**
 * §3 + §13 — construction discipline, checked automatically rather than by remembering to grep.
 *
 * ESLint (§5) enforces which layers may IMPORT what. This suite enforces the complementary rule
 * lint cannot express: concrete implementations may only be CONSTRUCTED in the factory (and in
 * tests). A `new FileBrandRepository()` inside a service would pass lint's import rules if someone
 * added an allowance; it will not pass this.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Every first-party source file, excluding tests and the spike scripts. */
async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of glob("{app,lib,components}/**/*.{ts,tsx}", { cwd: ROOT })) {
    out.push((entry as string).split(path.sep).join("/"));
  }
  return out;
}

const read = (rel: string) => readFile(path.join(ROOT, rel), "utf8");

describe("architecture", () => {
  // A scanner that silently matches nothing would make every check below vacuously green — the
  // most dangerous failure mode for this kind of test. Anchor it on files that must exist.
  it("actually scans the source tree", async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("lib/repositories/factory.ts");
    expect(files).toContain("lib/ports/repositories.ts");
    expect(files).toContain("app/page.tsx");
  });

  it("has a construction detector that fires", () => {
    // Proves the regex used below actually matches the thing it is meant to catch, so a green
    // result means "no violations", not "the pattern never matches anything".
    const CONSTRUCTOR = /new\s+(File|Memory|LocalDisk|Stub|Bedrock|Pptx)[A-Za-z]*\s*\(/g;
    expect("const r = new FileBrandRepository(dir);").toMatch(CONSTRUCTOR);
    expect("const r = new MemoryDeckRepository();").toMatch(CONSTRUCTOR);
    expect("const m = new Map();").not.toMatch(CONSTRUCTOR);
  });

  it("constructs concrete impls only in the repository factory", async () => {
    const CONSTRUCTOR = /new\s+(File|Memory|LocalDisk|Stub|Bedrock|Pptx)[A-Za-z]*\s*\(/g;
    const ALLOWED = new Set(["lib/repositories/factory.ts"]);
    const offenders: string[] = [];

    for (const rel of await sourceFiles()) {
      if (ALLOWED.has(rel)) continue;
      const matches = (await read(rel)).match(CONSTRUCTOR);
      if (matches) offenders.push(`${rel}: ${matches.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps server-only SDKs out of app/ and components/ (§0.5, §12)", async () => {
    const FORBIDDEN = /from\s+["'](pptxgenjs|@aws-sdk\/[^"']+|node:fs[^"']*|fs(\/promises)?)["']/g;
    const offenders: string[] = [];

    for (const rel of await sourceFiles()) {
      if (!rel.startsWith("app/") && !rel.startsWith("components/")) continue;
      const matches = (await read(rel)).match(FORBIDDEN);
      if (matches) offenders.push(`${rel}: ${matches.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps ports free of implementation and IO types (§6.4)", async () => {
    const ports = (await sourceFiles()).filter((f) => f.startsWith("lib/ports/"));
    expect(ports.length).toBeGreaterThan(3); // the ports exist and are being scanned
    for (const rel of ports) {
      const source = await read(rel);
      expect(source, rel).not.toMatch(/from\s+["'][^"']*(repositories|adapters)\//);
      expect(source, rel).not.toMatch(/from\s+["'](node:)?fs/);
      expect(source, rel).not.toMatch(/@aws-sdk/);
      // No sync IO: every port method must return a Promise or an AsyncIterable.
      expect(source, rel).not.toMatch(/Sync\s*\(/);
    }
  });

  it("keeps services free of concrete impls once they exist", async () => {
    for (const rel of (await sourceFiles()).filter((f) => f.startsWith("lib/services/"))) {
      const source = await read(rel);
      expect(source, rel).not.toMatch(/from\s+["'][^"']*(repositories|adapters|container)/);
    }
  });
});
