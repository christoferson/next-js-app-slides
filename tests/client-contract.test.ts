/**
 * The typed API client against the routes it calls (§2 step 16, §13).
 *
 * ## The bug class this exists for
 *
 * `lib/client/api.ts` is the browser's only contact with the server, and every method encodes two facts
 * about a route: its PATH and its VERB. Nothing checked either. Both drift silently:
 *
 *   - a verb mismatch is a 405 at runtime, and no server test notices because route tests import the
 *     handler and call it directly — they never go through the client;
 *   - a path mismatch is a 404, and the route's own tests pass because they never construct the URL.
 *
 * `setSlideLayout` shipped sending `PATCH` to a route that exports only `PUT`. It was found by writing
 * the screen that first used it — which is to say, not by any test. This suite is the check that would
 * have caught it, and it is written generically so the next one is caught before it reaches a screen.
 *
 * ## How it works
 *
 * Each client method is invoked with a stubbed `fetch` that records `(url, method)`. The URL is then
 * resolved against `app/api/**` on disk — Next.js file routing, so the filesystem IS the route table —
 * and the resolved `route.ts` is read for its exported verbs. No HTTP, no server, no container: this is a
 * static consistency check between two files that must agree.
 *
 * Deliberately NOT a hand-written table of expected paths. That would be §4's parallel table in test
 * form: it would agree with whatever the client currently sends, which is precisely the thing in doubt.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { api } from "@/lib/client/api";

const ROOT = path.resolve(__dirname, "..");

/* ─────────────────────────── the route table, from disk ─────────────────────────── */

/**
 * Every `app/api/**\/route.ts`, as a matchable segment list plus its exported verbs.
 *
 * `[param]` segments match anything; `[...rest]` is not used by this app and is therefore not supported
 * — a catch-all added later would fail to match here rather than being silently accepted, which is the
 * safer direction for a test whose whole job is to notice drift.
 */
interface RouteFile {
  rel: string;
  segments: string[];
  verbs: Set<string>;
}

const VERB = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

async function routeTable(): Promise<RouteFile[]> {
  const routes: RouteFile[] = [];
  for await (const entry of glob("app/api/**/route.ts", { cwd: ROOT })) {
    const rel = (entry as string).split(path.sep).join("/");
    const source = await readFile(path.join(ROOT, rel), "utf8");
    const verbs = new Set([...source.matchAll(VERB)].map((m) => m[1]!));
    routes.push({
      rel,
      segments: rel.slice("app/api/".length, -"/route.ts".length).split("/").filter((s) => s !== ""),
      verbs,
    });
  }
  return routes;
}

const isParam = (segment: string): boolean => segment.startsWith("[") && segment.endsWith("]");

/** The route whose segment pattern matches `pathname`, preferring literal segments over params. */
function matchRoute(routes: readonly RouteFile[], pathname: string): RouteFile | undefined {
  const parts = pathname.replace(/^\/api\//, "").split("/");
  const candidates = routes.filter((route) =>
    route.segments.length === parts.length
    && route.segments.every((segment, i) => isParam(segment) || segment === parts[i]));

  // A literal segment is more specific than a param, so `/decks/order` beats `/decks/[deckId]`. Next.js
  // resolves the same way; mirroring it keeps this test's answer the same as the running app's.
  return candidates.sort((a, b) => literalCount(b) - literalCount(a))[0];
}

const literalCount = (route: RouteFile): number => route.segments.filter((s) => !isParam(s)).length;

/* ─────────────────────────── the client, with fetch stubbed ─────────────────────────── */

interface Call { url: string; method: string; }

let calls: Call[];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
    // An empty 200 satisfies `request`'s parse path without any method needing a shaped response.
    return Promise.resolve(new Response("", { status: 200 }));
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * One invocation per client method, with argument values chosen to be greppable.
 *
 * Every method in `api` must appear here — the coverage test below fails if one is missing, so a new
 * client method cannot be added without declaring how it is called.
 */
const INVOCATIONS: Record<string, () => Promise<unknown>> = {
  "registry.layouts": () => api.registry.layouts(),
  "registry.fonts": () => api.registry.fonts(),
  "registry.tones": () => api.registry.tones(),
  "registry.models": () => api.registry.models(),

  "brands.list": () => api.brands.list(),
  "brands.get": () => api.brands.get("b1"),
  "brands.create": () => api.brands.create({}),
  "brands.update": () => api.brands.update("b1", {}),
  "brands.remove": () => api.brands.remove("b1"),
  "brands.import": () => api.brands.import({}),
  "brands.upload": () => api.brands.upload("b1", new File(["x"], "x.png"), { kind: "logo" }),
  "brands.removeAsset": () => api.brands.removeAsset("b1", "a1"),

  "decks.list": () => api.decks.list(),
  "decks.get": () => api.decks.get("d1"),
  "decks.create": () => api.decks.create({}),
  "decks.update": () => api.decks.update("d1", {}),
  "decks.remove": () => api.decks.remove("d1"),
  "decks.workspace": () => api.decks.workspace("d1"),
  "decks.outlineView": () => api.decks.outlineView("d1"),
  "decks.outline": () => api.decks.outline("d1", {}),
  "decks.saveOutline": () => api.decks.saveOutline("d1", {}),
  "decks.setSlideLayout": () => api.decks.setSlideLayout("d1", 0, 1, { layoutId: null }),
  "decks.updateSlide": () => api.decks.updateSlide("d1", "s1", {}),
  "decks.removeSlide": () => api.decks.removeSlide("d1", "s1"),
  "decks.duplicateSlide": () => api.decks.duplicateSlide("d1", "s1"),
  "decks.regenerateSlide": () => api.decks.regenerateSlide("d1", "s1", {}),
  "decks.reorderSlides": () => api.decks.reorderSlides("d1", {}),
};

/** `api`'s methods as dotted names, so coverage is checked against the module rather than a list. */
function clientMethods(): string[] {
  const names: string[] = [];
  for (const [group, value] of Object.entries(api)) {
    // `assetUrl`/`exportUrl` are URL builders, not fetches — covered separately below.
    if (typeof value === "function") continue;
    for (const [method, fn] of Object.entries(value as Record<string, unknown>)) {
      if (typeof fn === "function") names.push(`${group}.${method}`);
    }
  }
  return names;
}

/* ─────────────────────────────── the tests ─────────────────────────────── */

describe("API client ↔ route contract", () => {
  it("declares an invocation for every client method", () => {
    // Without this, adding a method with a wrong verb passes the suite by never being exercised.
    expect(clientMethods().sort()).toEqual(Object.keys(INVOCATIONS).sort());
  });

  it("finds the route files, so the checks below are not vacuous", async () => {
    const routes = await routeTable();
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      expect(route.verbs.size, `${route.rel} exports no HTTP verb`).toBeGreaterThan(0);
    }
  });

  it("sends every request to a route that exists and accepts that verb", async () => {
    const routes = await routeTable();
    const problems: string[] = [];

    for (const [name, invoke] of Object.entries(INVOCATIONS)) {
      calls = [];
      await invoke();
      const call = calls[0];
      if (call === undefined) {
        problems.push(`${name}: issued no request`);
        continue;
      }

      const pathname = new URL(call.url, "http://test.local").pathname;
      const route = matchRoute(routes, pathname);
      if (route === undefined) {
        problems.push(`${name}: ${call.method} ${pathname} matches no app/api route (404)`);
        continue;
      }
      if (!route.verbs.has(call.method)) {
        problems.push(
          `${name}: ${call.method} ${pathname} → ${route.rel} exports only `
          + `${[...route.verbs].sort().join(", ")} (405)`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it("escapes ids into the path rather than concatenating them raw", async () => {
    // A traversal id must not be able to reshape the URL into a different route. The path builder is the
    // guard server-side (§6.5); this is its client-side half, and the reason every id goes through
    // `encodeURIComponent`.
    calls = [];
    await api.decks.get("../../brands/b1");
    const pathname = new URL(calls[0]!.url, "http://test.local").pathname;

    expect(pathname).toBe("/api/decks/..%2F..%2Fbrands%2Fb1");
    expect(pathname.split("/")).toHaveLength(4);   // still exactly `/api/decks/:one-segment`
  });

  it("routes the URL builders to real routes too", async () => {
    const routes = await routeTable();
    for (const url of [api.assetUrl("a1"), api.exportUrl("d1"), api.exportUrl("d1", "pptx")]) {
      const route = matchRoute(routes, url);
      expect(route, `${url} matches no route`).toBeDefined();
      // Both are navigations — an `<img src>` and a download — so GET is the only verb that can serve them.
      expect(route?.verbs.has("GET"), `${url} → ${route?.rel} has no GET`).toBe(true);
    }
  });

  it("sends JSON content-type only when there is a body, and never for FormData", async () => {
    const headersFor = async (invoke: () => Promise<unknown>): Promise<Record<string, string>> => {
      const captured: Record<string, string>[] = [];
      const stub = globalThis.fetch;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        captured.push((init?.headers ?? {}) as Record<string, string>);
        return Promise.resolve(new Response("", { status: 200 }));
      }) as typeof globalThis.fetch;
      try {
        await invoke();
      } finally {
        globalThis.fetch = stub;
      }
      return captured[0] ?? {};
    };

    expect(await headersFor(() => api.brands.get("b1"))).not.toHaveProperty("content-type");
    expect(await headersFor(() => api.brands.create({}))).toHaveProperty("content-type", "application/json");
    // The classic silent upload break: overriding content-type strips the multipart boundary the browser
    // must write itself, and the server then sees an unparseable body.
    expect(await headersFor(
      () => api.brands.upload("b1", new File(["x"], "x.png"), { kind: "logo" }),
    )).not.toHaveProperty("content-type");
  });
});
