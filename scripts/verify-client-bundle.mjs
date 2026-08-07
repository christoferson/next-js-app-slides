/**
 * CLAUDE.md §12 / §0.5 — prove no server-only code reached the CLIENT bundle.
 *
 * ## Why a grep and not just the ESLint boundaries
 *
 * §5's `no-restricted-imports` blocks the *direct* import. It cannot see a transitive one: a client component
 * imports `lib/layouts/registry` (legitimately — the preview needs `FallbackRenderer`), the registry imports
 * eight layout defs, and if any of those ever `import pptxgen from "pptxgenjs"` at the top level, the bundler
 * pulls the whole library into the browser. That is a bundle fact, so only the built bundle can disprove it.
 *
 * This checks the emitted **client** chunks only — `.next/static/**`, which is what a browser downloads.
 * Server chunks under `.next/server/**` are *supposed* to contain the AWS SDK and pptxgenjs.
 *
 * ## The needles
 *
 * Package names for the two server SDKs, plus `AWS_PROFILE`. Each is checked in two forms because a bundler
 * rewrites import specifiers: the raw package name (which survives in comments, sourcemap paths, and
 * `require` fallbacks) and a distinctive runtime string from inside the library that no minifier removes.
 *
 * Exits non-zero on the first real finding, listing the chunk — enough to `rg` for the importer.
 *
 * ## `--self-test`
 *
 * A grep that passes because its patterns match nothing is worse than no check: it reports "verified" forever.
 * `node scripts/verify-client-bundle.mjs --self-test` runs the SAME needles against `.next/server/**`, where
 * the AWS SDK, pptxgenjs, and sharp genuinely do live, and fails if a needle finds nothing there. That is the
 * positive control for the negative result above, and it is why this script can be trusted when it says PASS.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const CLIENT_DIR = ".next/static";

/**
 * `label` is what gets reported; `pattern` is what is searched.
 *
 * `AWS_PROFILE` is matched as a whole word: a substring match would also hit any minified identifier that
 * happened to contain it, and a false positive here trains people to ignore this script.
 *
 * VERIFIED 2026-08-07: `AWS_PROFILE` currently appears nowhere in EITHER bundle — the only references in the
 * repo are `scripts/**` (never bundled) and one comment in `factory.ts`. The credential chain reads it from
 * the environment inside the SDK, so it is never a literal in our code. §12 names it explicitly, so the
 * needle stays as a regression guard against code that starts embedding it; it just cannot be
 * positively controlled by `--self-test`, and is exempt there for that reason rather than because it is
 * allowed to be missing.
 */
const NEEDLES = [
  { label: "@aws-sdk (package specifier)", pattern: /@aws-sdk\// },
  { label: "@aws-sdk (runtime marker)", pattern: /BedrockRuntimeClient|bedrock-runtime/ },
  { label: "pptxgenjs (package specifier)", pattern: /pptxgenjs/ },
  { label: "pptxgenjs (runtime marker)", pattern: /application\/vnd\.openxmlformats-officedocument\.presentationml/ },
  { label: "AWS_PROFILE", pattern: /\bAWS_PROFILE\b/ },
  // sharp is a native addon — it cannot even load in a browser, so its presence would mean the whole
  // container graph was pulled client-side. Cheap to check alongside the other three.
  { label: "sharp (native addon)", pattern: /require\(['"]sharp['"]\)|from['"\s]+sharp['"]/ },
];

/** Every file under `dir`, recursively. */
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
}

const selfTest = process.argv.includes("--self-test");
const dir = selfTest ? ".next/server" : CLIENT_DIR;

try {
  await stat(dir);
} catch {
  console.error(`${dir} not found — run \`npm run build\` first.`);
  process.exit(2);
}

/**
 * The positive control. Every needle MUST fire against the server bundle; one that does not is a needle that
 * can no longer detect the thing it names (a renamed export, a bundler that rewrites the specifier), and it
 * would silently pass the real check forever.
 *
 * `sharp` is exempt from the must-fire requirement: Next externalizes native addons rather than bundling
 * them, so its `require` may not appear as a literal in any chunk. Its client-side check is still meaningful
 * (a bundled copy would be a catastrophic regression) — it just cannot be positively controlled this way.
 */
if (selfTest) {
  const chunks = (await walk(dir)).filter((f) => f.endsWith(".js"));
  console.log(`Self-test: ${chunks.length} server chunk(s) under ${dir}.`);

  const dead = [];
  for (const { label, pattern } of NEEDLES) {
    let count = 0;
    for (const file of chunks) {
      if (pattern.test(await readFile(file, "utf8"))) count += 1;
    }
    console.log(`  ${count > 0 ? "✅" : "⚠️ "} ${label} → ${count} chunk(s)`);
    if (count === 0 && !label.startsWith("sharp") && !label.startsWith("AWS_PROFILE")) dead.push(label);
  }

  if (dead.length > 0) {
    console.error(`\n❌ These needles matched NOTHING in the server bundle, so they cannot detect anything:\n  ${dead.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\n✅ Needles are live — the client-side PASS is meaningful.");
  process.exit(0);
}

const files = (await walk(CLIENT_DIR))
  // Only executable client code. Sourcemaps are excluded deliberately: they embed original module PATHS, so
  // a `.map` legitimately names every file the bundle was built from and would report a hit for code that
  // was tree-shaken out. `.js` is what the browser actually runs.
  .filter((f) => f.endsWith(".js"));

if (files.length === 0) {
  console.error(`No .js chunks under ${CLIENT_DIR} — the build output looks wrong.`);
  process.exit(2);
}

const findings = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const { label, pattern } of NEEDLES) {
    if (pattern.test(text)) findings.push({ file, label });
  }
}

console.log(`Scanned ${files.length} client chunk(s) under ${CLIENT_DIR}.`);

if (findings.length > 0) {
  console.error("\n❌ SERVER-ONLY CODE IN THE CLIENT BUNDLE (§0.5/§12):");
  for (const { file, label } of findings) {
    console.error(`  ${label}  →  ${file.replace(/\\/g, "/")}`);
  }
  process.exit(1);
}

console.log("✅ §12 client-bundle grep PASSED — no @aws-sdk, pptxgenjs, sharp, or AWS_PROFILE.");
