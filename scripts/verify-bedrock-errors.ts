/**
 * §1.2 step 5 continued — the error shapes verify-bedrock.ts could NOT trigger from an
 * admin-credentialed sandbox: AccessDenied and Throttling.
 *
 * Both matter for the adapter's mapping (§2 step 10) and for §9's "ThrottlingException mid-deck
 * → that slide errors readably, other slides continue".
 */
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ANTHROPIC_VERSION = "bedrock-2023-05-31";
const body = () => JSON.stringify({
  anthropic_version: ANTHROPIC_VERSION, max_tokens: 8,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
});

async function shape(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`  ${label}: NO ERROR`);
  } catch (e: any) {
    console.log(`  ${label}:`);
    console.log(`      name=${e.name} httpStatus=${e.$metadata?.httpStatusCode} retryable=${JSON.stringify(e.$retryable ?? null)}`);
    console.log(`      fault=${e.$fault ?? "-"} message=${JSON.stringify(String(e.message).slice(0, 200))}`);
  }
}

async function main() {
  console.log(`region: ${REGION}\n── AccessDenied / auth failures ──`);

  // A model that exists but is very likely not access-granted in a sandbox account.
  await shape("model not access-granted (foreign provider)", () => {
    const c = new BedrockRuntimeClient({ region: REGION });
    return c.send(new InvokeModelCommand({
      modelId: "us.anthropic.claude-3-opus-20240229-v1:0",
      contentType: "application/json", body: body(),
    }));
  });

  // Bad static credentials → UnrecognizedClientException / InvalidSignatureException.
  await shape("invalid credentials", () => {
    const c = new BedrockRuntimeClient({
      region: REGION,
      credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    });
    return c.send(new InvokeModelCommand({ modelId: "us.anthropic.claude-opus-5", contentType: "application/json", body: body() }));
  });

  // A region where Bedrock/this model is absent → surfaces as an endpoint/validation failure.
  await shape("model absent in region (eu-central-1 profile id)", () => {
    const c = new BedrockRuntimeClient({ region: "eu-central-1" });
    return c.send(new InvokeModelCommand({ modelId: "us.anthropic.claude-opus-5", contentType: "application/json", body: body() }));
  });

  console.log(`
NOTE ON THROTTLING: ThrottlingException cannot be triggered on demand without abusing the
account, so it is NOT reproduced here. Map it from the documented shape:
  name="ThrottlingException", httpStatusCode=429, $retryable={throttling:true}
The SDK already retries throttles internally (maxAttempts default 3); the adapter must surface
the final failure as a readable per-slide error so §9's "other slides continue" holds.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
