/**
 * CLAUDE.md §1.2 step 0 — what is actually invocable in THIS account/region?
 *
 * Prime Directive #1 forbids guessing a model ID. The bundled AWS CLI here is v1 and has no
 * `bedrock` command, so enumerate with the SDK — which is also what the adapter will use.
 *
 * Lists Anthropic foundation models plus inference profiles, so we can tell apart:
 *   - a plain model id            e.g. anthropic.claude-...-v1:0   (ON_DEMAND)
 *   - a cross-region profile id   e.g. us.anthropic.claude-...      (INFERENCE_PROFILE)
 * That distinction matters: many newer Claude models are INFERENCE_PROFILE-only, and invoking
 * them by bare model id fails with ValidationException.
 */
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";

const REGION = process.env.AWS_REGION ?? "us-east-1";

async function main() {
  const client = new BedrockClient({ region: REGION });
  console.log(`region: ${REGION} · profile: ${process.env.AWS_PROFILE ?? "(default)"}\n`);

  const fm = await client.send(new ListFoundationModelsCommand({ byProvider: "anthropic" }));
  const models = (fm.modelSummaries ?? []).filter((m) => m.modelLifecycle?.status === "ACTIVE");

  console.log(`ACTIVE Anthropic foundation models (${models.length}):`);
  for (const m of models) {
    const types = (m.inferenceTypesSupported ?? []).join(",") || "none";
    const streaming = m.responseStreamingSupported ? "stream" : "no-stream";
    console.log(`  ${(m.modelId ?? "").padEnd(52)} ${types.padEnd(28)} ${streaming}`);
  }

  // Inference profiles are how the newest models are addressed (us./eu./apac. prefixes).
  try {
    const ip = await client.send(new ListInferenceProfilesCommand({ maxResults: 100 }));
    const profiles = (ip.inferenceProfileSummaries ?? [])
      .filter((p) => /anthropic/i.test(p.inferenceProfileId ?? "") || /claude/i.test(p.inferenceProfileName ?? ""));
    console.log(`\nAnthropic inference profiles (${profiles.length}):`);
    for (const p of profiles) {
      console.log(`  ${(p.inferenceProfileId ?? "").padEnd(52)} ${p.status ?? ""}`);
    }
  } catch (e: any) {
    console.log(`\n(ListInferenceProfiles failed: ${e.name} — ${e.message})`);
  }

  // Highlight anything Opus, since that's the requested default.
  const opus = models.filter((m) => /opus/i.test(m.modelId ?? ""));
  console.log(`\nOpus candidates: ${opus.length ? opus.map((m) => m.modelId).join(", ") : "NONE in this region"}`);
}

main().catch((e) => { console.error(`${e.name}: ${e.message}`); process.exit(1); });
