/**
 * Compact ESLint reporter — one line per problem.
 *
 * `npm run lint` prints ESLint's stylish output, which for a React rule violation is fifteen lines of
 * explanation per problem. That is useful once and unreadable when triaging a sweep of files, so this
 * reads the JSON formatter and prints `path:line:col  rule — message`.
 *
 * Usage: `node scripts/lint-report.mjs [paths...]` (defaults to the whole repo, like `npm run lint`).
 */

import { spawnSync } from "node:child_process";

const targets = process.argv.slice(2);
const args = ["eslint", "-f", "json", ...(targets.length > 0 ? targets : ["."])];

// `shell: true` on Windows: `npx` is a .cmd shim, which cannot be spawned directly.
const { stdout } = spawnSync("npx", args, { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });

// ESLint exits non-zero when it reports problems, so stdout is parsed regardless of the exit code. A
// crash (bad config, unparsable file) produces no JSON at all — reported rather than swallowed.
const start = stdout.indexOf("[");
if (start === -1) {
  console.error("eslint produced no JSON output:\n" + stdout.slice(0, 2000));
  process.exit(2);
}

const results = JSON.parse(stdout.slice(start));
const cwd = process.cwd();
let count = 0;

for (const file of results) {
  for (const m of file.messages) {
    count += 1;
    const where = `${file.filePath.replace(cwd, "").replace(/\\/g, "/")}:${m.line}:${m.column}`;
    console.log(`${where}  ${m.ruleId ?? "(fatal)"} — ${m.message.split("\n")[0]}`);
  }
}

console.log(count === 0 ? "CLEAN" : `${count} problem(s)`);
process.exit(count === 0 ? 0 : 1);
