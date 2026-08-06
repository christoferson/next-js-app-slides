// eslint-config-next v16 ships a NATIVE flat-config array (entries: "next", "next/typescript",
// plus an ignores block). Do NOT wrap it in FlatCompat — routing it through the eslintrc
// compatibility layer throws `Converting circular structure to JSON` in config-validator.js,
// because the eslintrc schema validator JSON.stringify()s a plugin object that self-references.
import next from "eslint-config-next";

/**
 * CLAUDE.md §5 — Lint-Enforced Boundaries.
 *
 * "A boundary violation = failing build. This is how 'layering holds' gets *guaranteed*,
 * not reviewed." Routes → Facade → Services → Ports → Impls, and `lib/container.ts` is the
 * ONLY file allowed to construct concrete implementations.
 *
 * These rules exist BEFORE feature code by design: added afterwards, they only document
 * violations instead of preventing them.
 */

/**
 * Server-only packages that must never reach the client bundle (§0.5, §12).
 *
 * `sharp` is here for the same reason as the rest: it is a native N-API addon, so it cannot run in a
 * browser at all, and an import from `lib/brand` (whose luminance helpers are deliberately pure so the
 * brand editor can use them) would break the client build rather than merely bloat it.
 */
const SERVER_ONLY = [
  "pptxgenjs", "sharp", "@aws-sdk/*", "fs", "node:fs", "fs/promises", "node:fs/promises",
];

const deny = (patterns) => ({ "no-restricted-imports": ["error", { patterns }] });

const config = [
  ...next,

  { ignores: [".next/**", "node_modules/**", "out/**", "fixtures/**", "next-env.d.ts"] },

  // Spike scripts are deliberately outside the architecture: they exist to probe the very
  // SDKs the app layers are forbidden from touching directly.
  { files: ["scripts/**"], rules: { "no-restricted-imports": "off", "@typescript-eslint/no-explicit-any": "off" } },

  // ── app/** — routes and pages: validate, delegate, stream. No business logic. ──
  {
    files: ["app/**"],
    rules: deny([
      { group: ["**/lib/repositories/**", "**/lib/adapters/**", "**/lib/export/**"],
        message: "§5: routes must go through lib/facade — never touch concrete repos/adapters/exporters." },
      { group: SERVER_ONLY,
        message: "§5: app/** may not import server SDKs or fs directly; that belongs in repositories/adapters/export." },
      { group: ["**/lib/services/**"],
        message: "§5: routes call lib/facade, not services directly (no layer skipping)." },
    ]),
  },

  // ── lib/facade/** — use-case orchestration over services only. ──
  {
    files: ["lib/facade/**"],
    rules: deny([
      { group: ["**/lib/repositories/**", "**/lib/adapters/**", "**/app/**"],
        message: "§5: facade may import lib/services/** and lib/errors only." },
      { group: SERVER_ONLY, message: "§5: no server SDKs or fs in the facade." },
    ]),
  },

  // ── lib/services/** — business logic against PORTS, never implementations. ──
  {
    files: ["lib/services/**"],
    rules: deny([
      { group: ["**/lib/repositories/**", "**/lib/adapters/**", "**/lib/container*", "**/app/**"],
        message: "§5: services depend on lib/ports/** interfaces only — impls are injected by the container." },
      { group: SERVER_ONLY,
        message: "§5: services must stay IO-free; put fs/SDK access behind a port implementation." },
    ]),
  },

  // ── lib/ports/** — pure interfaces. No implementation detail may leak in. ──
  {
    files: ["lib/ports/**"],
    rules: deny([
      { group: ["**/lib/repositories/**", "**/lib/adapters/**", "**/lib/services/**", "**/app/**"],
        message: "§5: ports are the swap contract — they must not reference any implementation." },
      { group: SERVER_ONLY,
        message: "§6.4: no fs/SDK types in port signatures (assets return streams/URLs, never paths)." },
    ]),
  },

  // ── components/** — client only. Nothing server-side, ever (§12 grep-verified too). ──
  {
    files: ["components/**"],
    rules: deny([
      { group: ["**/lib/repositories/**", "**/lib/adapters/**", "**/lib/services/**",
                "**/lib/facade/**", "**/lib/container*", "**/lib/export/**"],
        message: "§5: components use the typed API client + lib/stream/events types only." },
      { group: SERVER_ONLY, message: "§5/§12: server SDKs must never enter the client bundle." },
    ]),
  },

  // repositories/**, adapters/**, export/** are the ONLY places fs/@aws-sdk/pptxgenjs are
  // allowed — so no restriction here, by design (§5). They may not reach upward, though.
  {
    files: ["lib/repositories/**", "lib/adapters/**", "lib/export/**"],
    rules: deny([
      { group: ["**/app/**", "**/lib/facade/**", "**/lib/services/**", "**/lib/container*"],
        message: "§5: implementations must not depend on the layers above them." },
    ]),
  },
];

export default config;
