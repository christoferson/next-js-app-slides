import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The `@/*` alias must mirror `tsconfig.json` paths, or tests resolve differently from the app.
 * Declared explicitly rather than via a tsconfig-paths plugin to keep the mapping in one
 * greppable place.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    // Node environment: everything under test here is server-side. Component tests will add a
    // jsdom-environment project when the frontend lands (§2 step 16).
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
