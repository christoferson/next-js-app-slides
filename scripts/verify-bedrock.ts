/**
 * CLAUDE.md §1.2 — Bedrock gating spike. Gates all generation code (§2 step 10-11).
 *
 * Answers, with evidence rather than assumption:
 *   1. Is DEFAULT_LLM_MODEL_ID invocable in THIS account/region?
 *   2. What is the family's exact request schema?
 *   3. Where does the text delta live in the streaming envelope?
 *   4. Structured output: 10 runs against a schema — how often is it clean vs needs repair?
 *      (This calibrates the §7/§9 single-repair-pass assumption. If compliance is poor, §14
 *      says surface it rather than silently degrade.)
 *   5. What do the error shapes look like, for the adapter's error mapping?
 *
 * Run: npm run verify:bedrock
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const REGION = process.env.AWS_REGION ?? "us-east-1";
// Verified present + ACTIVE by scripts/verify-bedrock-models.ts. Every Anthropic model in this
// account is INFERENCE_PROFILE-only, so the `us.` prefixed profile id is required — a bare
// `anthropic.claude-opus-5` fails with ValidationException (proved in step 5 below).
const MODEL_ID = process.env.DEFAULT_LLM_MODEL_ID ?? "us.anthropic.claude-opus-5";
const ANTHROPIC_VERSION = "bedrock-2023-05-31";

const client = new BedrockRuntimeClient({ region: REGION });

/** The Anthropic-on-Bedrock request envelope. Verified by invocation, not from memory. */
function anthropicBody(prompt: string, opts: { maxTokens?: number; system?: string; temperature?: number } = {}) {
  return {
    anthropic_version: ANTHROPIC_VERSION,
    max_tokens: opts.maxTokens ?? 512,
    ...(opts.system ? { system: opts.system } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  };
}

const dec = new TextDecoder();

async function invoke(prompt: string, opts?: Parameters<typeof anthropicBody>[1]) {
  const res = await client.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(anthropicBody(prompt, opts)),
  }));
  return JSON.parse(dec.decode(res.body));
}

// ── 1 + 2: invocable? exact schema? ──
async function step1and2() {
  console.log("── 1/2. Invocability + request schema ──");
  const t0 = process.hrtime.bigint();
  const out = await invoke("Reply with exactly: OK", { maxTokens: 16 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  modelId: ${MODEL_ID}`);
  console.log(`  latency: ${ms.toFixed(0)} ms`);
  console.log(`  response keys: ${Object.keys(out).join(", ")}`);
  console.log(`  text path: content[0].text = ${JSON.stringify(out.content?.[0]?.text)}`);
  console.log(`  stop_reason: ${out.stop_reason} · usage: ${JSON.stringify(out.usage)}`);
  return out;
}

// ── 3: streaming envelope — where is the text delta? ──
async function step3() {
  console.log("\n── 3. Streaming chunk envelope ──");
  const res = await client.send(new InvokeModelWithResponseStreamCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(anthropicBody("Count from 1 to 5, comma separated.", { maxTokens: 64 })),
  }));

  const seen = new Map<string, number>();
  let text = "";
  let firstShape = "";
  for await (const evt of res.body!) {
    if (!evt.chunk?.bytes) continue;
    const chunk = JSON.parse(dec.decode(evt.chunk.bytes));
    seen.set(chunk.type, (seen.get(chunk.type) ?? 0) + 1);
    if (chunk.type === "content_block_delta") {
      if (!firstShape) firstShape = JSON.stringify(chunk);
      text += chunk.delta?.text ?? "";
    }
  }
  console.log(`  event types: ${[...seen].map(([k, v]) => `${k}×${v}`).join(", ")}`);
  console.log(`  first delta chunk: ${firstShape}`);
  console.log(`  → decode path: chunk.delta.text where chunk.type === "content_block_delta"`);
  console.log(`  reassembled: ${JSON.stringify(text)}`);
}

// ── 4: structured-output compliance over N runs ──
const SLOT_PROMPT = `Return a JSON object for a presentation slide with exactly these keys:
"title" (string, max 60 chars), "bullets" (array of exactly 3 strings, each max 80 chars).
Topic: quarterly revenue growth in emerging markets.
Return ONLY the JSON object. No markdown fences, no preamble, no trailing commentary.`;

/** Tolerant extractor — §9 requires recovering JSON from fences/preamble. */
function extractJson(raw: string): { ok: boolean; value?: any; how: string } {
  const direct = raw.trim();
  try { return { ok: true, value: JSON.parse(direct), how: "clean" }; } catch { /* fall through */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced) { try { return { ok: true, value: JSON.parse(fenced[1]), how: "unfenced" }; } catch { /* */ } }
  const braced = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  if (braced.length > 1) { try { return { ok: true, value: JSON.parse(braced), how: "brace-scan" }; } catch { /* */ } }
  return { ok: false, how: "unrecoverable" };
}

function validShape(v: any): string[] {
  const errs: string[] = [];
  if (typeof v?.title !== "string") errs.push("title not a string");
  else if (v.title.length > 60) errs.push(`title ${v.title.length}>60 chars`);
  if (!Array.isArray(v?.bullets)) errs.push("bullets not an array");
  else {
    if (v.bullets.length !== 3) errs.push(`bullets length ${v.bullets.length}!==3`);
    v.bullets.forEach((b: any, i: number) => {
      if (typeof b !== "string") errs.push(`bullets[${i}] not a string`);
      else if (b.length > 80) errs.push(`bullets[${i}] ${b.length}>80 chars`);
    });
  }
  const extra = Object.keys(v ?? {}).filter((k) => !["title", "bullets"].includes(k));
  if (extra.length) errs.push(`extra keys: ${extra.join(",")}`);
  return errs;
}

async function step4(runs = 10) {
  console.log(`\n── 4. Structured-output compliance (${runs} runs, temperature 1) ──`);
  const tally = { clean: 0, recovered: 0, invalid: 0, unrecoverable: 0 };
  const notes: string[] = [];
  for (let i = 1; i <= runs; i++) {
    const out = await invoke(SLOT_PROMPT, { maxTokens: 400, temperature: 1 });
    const raw = out.content?.[0]?.text ?? "";
    const ext = extractJson(raw);
    if (!ext.ok) {
      tally.unrecoverable++;
      notes.push(`run ${i}: UNRECOVERABLE — ${JSON.stringify(raw.slice(0, 90))}`);
      continue;
    }
    const errs = validShape(ext.value);
    if (errs.length) { tally.invalid++; notes.push(`run ${i}: schema errors (${ext.how}) — ${errs.join("; ")}`); }
    else if (ext.how === "clean") tally.clean++;
    else { tally.recovered++; notes.push(`run ${i}: valid but needed ${ext.how}`); }
    process.stdout.write(errs.length ? "x" : ext.how === "clean" ? "." : "~");
  }
  console.log(`\n  clean parse + valid : ${tally.clean}/${runs}`);
  console.log(`  needed extraction   : ${tally.recovered}/${runs}  (fences/preamble — tolerant extractor handles)`);
  console.log(`  parsed but invalid  : ${tally.invalid}/${runs}  (→ repair pass)`);
  console.log(`  unrecoverable       : ${tally.unrecoverable}/${runs}  (→ fallback)`);
  if (notes.length) { console.log("  detail:"); notes.forEach((n) => console.log(`    ${n}`)); }
  return tally;
}

// ── 5: error shapes for the adapter's mapping ──
async function step5() {
  console.log("\n── 5. Error shapes (for lib/adapters error mapping) ──");
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["bogus model id", () => client.send(new InvokeModelCommand({
      modelId: "anthropic.definitely-not-a-real-model-v9",
      contentType: "application/json", body: JSON.stringify(anthropicBody("hi")),
    }))],
    ["bare model id (no us. inference-profile prefix)", () => client.send(new InvokeModelCommand({
      modelId: "anthropic.claude-opus-5",
      contentType: "application/json", body: JSON.stringify(anthropicBody("hi")),
    }))],
    ["malformed body (missing max_tokens)", () => client.send(new InvokeModelCommand({
      modelId: MODEL_ID, contentType: "application/json",
      body: JSON.stringify({ anthropic_version: ANTHROPIC_VERSION, messages: [{ role: "user", content: "hi" }] }),
    }))],
    ["wrong anthropic_version", () => client.send(new InvokeModelCommand({
      modelId: MODEL_ID, contentType: "application/json",
      body: JSON.stringify({ ...anthropicBody("hi"), anthropic_version: "not-a-version" }),
    }))],
  ];
  for (const [label, fn] of cases) {
    try {
      await fn();
      console.log(`  ${label}: NO ERROR (unexpected)`);
    } catch (e: any) {
      console.log(`  ${label}:`);
      console.log(`      name=${e.name} httpStatus=${e.$metadata?.httpStatusCode} retryable=${!!e.$retryable}`);
      console.log(`      message=${JSON.stringify(String(e.message).slice(0, 160))}`);
    }
  }
}

async function main() {
  console.log(`region: ${REGION} · profile: ${process.env.AWS_PROFILE ?? "(default)"}\n`);
  await step1and2();
  await step3();
  const tally = await step4(10);
  await step5();
  console.log("\n── Verdict ──");
  const okRate = (tally.clean + tally.recovered) / 10;
  console.log(`  usable-without-repair rate: ${(okRate * 100).toFixed(0)}%`);
  console.log(okRate >= 0.8
    ? "  → single repair pass (§7) is sufficient."
    : "  → ⚠️ compliance too low; §14 says surface this before building the pipeline.");
}

main().catch((e) => { console.error(`\nFATAL ${e.name}: ${e.message}`); process.exit(1); });
