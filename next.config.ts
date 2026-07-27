import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SPEC.md §deployment: single image, multi-stage Docker build.
  output: "standalone",
  // CLAUDE.md §0.5 / §12: server-only SDKs must never reach the client bundle. These are
  // additionally lint-forbidden in components/** (§5), but this is the build-level backstop.
  serverExternalPackages: ["pptxgenjs", "@aws-sdk/client-bedrock-runtime", "@aws-sdk/client-bedrock"],
  typescript: { ignoreBuildErrors: false },
  // NOTE: Next 16 removed the `eslint` config key — `next build` no longer runs ESLint at all.
  // The §5 boundary rules are therefore only enforced if lint runs explicitly, so `npm run
  // verify` chains lint + typecheck + tests. Wire that into CI; a bare `next build` will NOT
  // catch a boundary violation.
};

export default nextConfig;
