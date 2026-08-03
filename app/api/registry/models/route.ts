/**
 * `GET /api/registry/models` — the model picker's options (SPEC §8).
 *
 * `modelSummaries()` deliberately omits `requestBuilder`/`family` internals beyond the family *name*:
 * nothing about how a request body is constructed belongs in a client payload. `verified` IS included,
 * because §1.2 measured which ids are actually invocable in this account and a picker that hides that
 * would offer a choice that fails at generation time.
 *
 * `defaultModelId` is returned alongside so the picker can preselect without a second source of truth —
 * and note it is the REGISTRY's default (`DEFAULT_MODEL_ID`), not `config.defaultLlmModelId`. The config
 * value is an env var that may name a model this deployment cannot reach; exposing it here would leak a
 * deployment detail and could preselect an unusable option. Which model a *request* uses is the server's
 * decision either way (`OutlineService`/`GenerationService` read the config), so nothing is lost.
 */

import { handle, json } from "@/lib/http/route-helpers";
import { DEFAULT_MODEL_ID, modelSummaries } from "@/lib/models/registry";

export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return handle(async () => json(
    { models: modelSummaries(), defaultModelId: DEFAULT_MODEL_ID },
    { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" } },
  ));
}
