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
// The real handlers, for the response-shape checks at the bottom of this file. Imported here rather than
// re-implemented, so the assertion is about what a browser actually receives.
import { GET as getLayouts } from "@/app/api/registry/layouts/route";
import { GET as getFonts } from "@/app/api/registry/fonts/route";
import { GET as getTones } from "@/app/api/registry/tones/route";
import { GET as getModels } from "@/app/api/registry/models/route";
import { GET as listBrandsRoute, POST as createBrandRoute } from "@/app/api/brands/route";
import { GET as listDecksRoute } from "@/app/api/decks/route";
import { req, routeHarness } from "@/tests/route-harness";

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
  "brands.importInto": () => api.brands.importInto("b1", {}),
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

/* ─────────────────────────── response SHAPE, not just path and verb ─────────────────────────── */

/**
 * The third fact a client method encodes, and the one this suite originally missed: the RESPONSE SHAPE.
 *
 * `request<T>` casts an `unknown` body to whatever the caller names, so `api.brands.list<BrandSummary[]>()`
 * type-checks perfectly while the route answers `{brands: [...]}`. Both screens that did this crashed at
 * runtime with `data.brands.map is not a function` — found by opening the page, not by any test. Path and
 * verb were both correct, which is exactly why the checks above could not see it.
 *
 * So: call the REAL handlers and assert that every collection route answers with a named envelope, and
 * that the key is the one the screens unwrap. Nothing here is hand-copied from the route sources — the
 * assertion is on live response bodies, so a route that changed its envelope fails here rather than in a
 * browser.
 *
 * Scoped to the list/registry GETs deliberately. The single-resource GETs are already pinned by the route
 * suites (`routes-decks.test.ts` asserts each envelope it returns), and re-asserting them here would be
 * the duplication `route-harness.ts` warns against.
 */
describe("API client ↔ route response shape", () => {
  /**
   * Registry routes need no container: they serve static data (§1.3 — the app must boot and serve
   * `/api/registry/*` with no AWS credentials). `/api/brands` and `/api/decks` DO need one, so they get
   * the memory-backed harness via `routeHarness`, the same wiring the route suites use.
   */
  const COLLECTIONS: ReadonlyArray<{ name: string; key: string; get: () => Promise<Response> }> = [
    { name: "registry.layouts", key: "layouts", get: getLayouts },
    { name: "registry.fonts", key: "fonts", get: getFonts },
    { name: "registry.tones", key: "tones", get: getTones },
    { name: "registry.models", key: "models", get: getModels },
    { name: "brands.list", key: "brands", get: () => listBrandsRoute(req("GET")) },
    { name: "decks.list", key: "decks", get: () => listDecksRoute(req("GET")) },
  ];

  it.each(COLLECTIONS)(
    "$name answers with a named `$key` envelope containing an array",
    async ({ key, get }) => {
      routeHarness();
      const body = (await (await get()).json()) as Record<string, unknown>;

      // An envelope, not a bare array: a top-level array cannot gain a sibling field later without
      // breaking every client, which is why every collection route here is wrapped.
      expect(Array.isArray(body)).toBe(false);
      expect(body, `expected a \`${key}\` key, got: ${Object.keys(body).join(", ")}`)
        .toHaveProperty(key);
      expect(Array.isArray(body[key])).toBe(true);
    },
  );

  /**
   * A CREATE response is not a list item, and the gallery screens must not treat it as one.
   *
   * `POST /api/brands` answers `BrandDefinition`; `GET /api/brands` answers `BrandSummary`, which carries
   * the DERIVED `templatedLayoutIds` (`Object.keys(brand.templates)`, computed in the repository). Same for
   * decks: a summary has `slideCount`, a `DeckMeta` does not. Both screens prepended the create response
   * straight into the list, so the new row rendered `undefined.length` and threw.
   *
   * Asserted on the LIVE responses, by diffing their key sets — a hand-written list of which fields are
   * derived would be the §4 parallel table this suite already refuses to keep.
   */
  it.each([
    { name: "brands", create: () => createBrandRoute(req("POST", { name: "T" })), list: () => listBrandsRoute(req("GET")), key: "brands" },
  ])("$name: the create response lacks derived summary fields, so a screen must not prepend it", async ({ create, list, key }) => {
    routeHarness();
    await (await create()).json();
    const listed = (await (await list()).json()) as Record<string, Record<string, unknown>[]>;
    const summary = listed[key]?.[0];
    expect(summary, "the created entity should appear in the list").toBeDefined();

    const created = (await (await create()).json()) as Record<string, unknown>;
    const derived = Object.keys(summary as Record<string, unknown>)
      .filter((k) => !Object.hasOwn(created, k));

    // If this ever becomes empty the two shapes have converged and the `reload` below could be relaxed —
    // but while it is non-empty, prepending is a crash.
    expect(derived.length, "expected at least one derived summary field").toBeGreaterThan(0);
  });

  /** So both galleries must re-read the list after creating, not splice the response in. */
  it.each([
    { rel: "app/brands/page.tsx", method: "api.brands.create" },
    { rel: "app/decks/page.tsx", method: "api.decks.create" },
  ])("$rel reloads after $method rather than prepending its response", async ({ rel, method }) => {
    const source = await readFile(path.join(ROOT, rel), "utf8");
    const call = source.slice(source.indexOf(method));
    const body = call.slice(0, call.indexOf("} catch"));
    expect(body, `${rel} should reload() after ${method}`).toMatch(/reload\(\)/);
    // The specific mistake: feeding the create response into the list state.
    expect(body, `${rel} should not splice the create response into the list`)
      .not.toMatch(/set\(\s*[[{][^)]*\.\.\./);
  });

  /**
   * The screens' side of the envelope contract.
   *
   * A route could answer `{brands}` while a screen still unwraps `.items` — the envelope check above would
   * pass and the page would render nothing. This reads the two list screens and asserts they name the key
   * the route actually sends, which is the pair that broke.
   */
  it("has the list screens unwrap the key their route sends", async () => {
    const cases = [
      { rel: "app/brands/page.tsx", key: "brands" },
      { rel: "app/decks/page.tsx", key: "decks" },
      { rel: "app/decks/page.tsx", key: "brands" },
    ];
    for (const { rel, key } of cases) {
      const source = await readFile(path.join(ROOT, rel), "utf8");
      // The generic names the envelope AND the value is read off it — an assertion of the bare array type
      // is what shipped, so both halves are checked.
      expect(source, `${rel} should assert a { ${key}: … } envelope`)
        .toMatch(new RegExp(`<\\{\\s*${key}:`));
      expect(source, `${rel} should read \`.${key}\` off the response`)
        .toMatch(new RegExp(`\\.${key}\\b`));
    }
  });
});

/* ─────────────────────────── is anything CALLING these methods? ─────────────────────────── */

/**
 * The fourth fact, and the one that hid every bug this file was written for: **whether a client method has
 * a caller at all.**
 *
 * `setSlideLayout` sent `PATCH` to a `PUT`-only route and was found by writing the first screen to use it.
 * `brands.update` and `decks.reorderSlides` had the same defect and were still latent — because no screen
 * called them either. The checks above now catch a wrong verb, path, or envelope, but only for a method
 * something exercises: an unreached method is verified against the route table and then never run, which is
 * precisely how three 405s survived a green suite.
 *
 * So this asserts reachability. A method with no caller is not necessarily a bug — but it IS unverified in
 * the only way that counts, so it must be declared as such rather than discovered later. Five were found in
 * exactly this state after the checks above shipped (`duplicateSlide`, `removeSlide`, `decks.update`,
 * `registry.models`, `brands.import`), all with complete and tested server sides and no UI.
 *
 * Deliberately a grep over `app/**` + `components/**` rather than a render test: there is no jsdom in this
 * repo, and "does a screen mention this method" is a static question that a static check answers honestly.
 * It cannot prove the call is on a reachable code path — only that the method is not orphaned.
 */
describe("API client reachability", () => {
  /**
   * Methods intentionally not called from any screen, each with the reason.
   *
   * Keeping this list short is the point. An entry here is a claim that the method is verified some OTHER
   * way — never a way to silence the check.
   */
  const UNREACHED: Record<string, string> = {
    // `POST /api/brands/import` CREATES from an exported config. The brands gallery creates from defaults
    // and the editor's JSON panel REPLACES an existing brand (`importInto`, which IS called), so nothing
    // needs the create-from-JSON path yet. Covered by `routes-brands.test.ts` and `scripts/smoke.ts`.
    "brands.import": "no screen creates a brand from pasted JSON yet; covered by route tests + smoke",
  };

  /**
   * Every screen and component file. `for await` rather than `Array.fromAsync`, matching `routeTable`
   * above — the latter is not in this project's `lib` target.
   */
  async function uiFiles(): Promise<string[]> {
    const rels: string[] = [];
    for await (const entry of glob("{app,components}/**/*.tsx", { cwd: ROOT })) {
      rels.push((entry as string).split(path.sep).join("/"));
    }
    return rels;
  }

  /** All screen + component source, concatenated. */
  async function uiSource(): Promise<string> {
    const sources = await Promise.all(
      (await uiFiles()).map((rel) => readFile(path.join(ROOT, rel), "utf8")),
    );
    return sources.join("\n");
  }

  /**
   * A call site for `decks.workspace` looks like `api.decks.workspace<WorkspaceView>(deckId)` — the type
   * argument sits between the name and the paren. Matching `api.name(` literally therefore finds NOTHING,
   * which is what the positive control below caught on the first run: every method looked orphaned. The
   * generic is optional (`api.decks.remove(id)` has none), so it is matched as optional too.
   *
   * The type argument is matched as "anything but a paren", not "anything but a semicolon": an inline object
   * type carries semicolons (`api.registry.models<{ models: ModelSummary[]; defaultModelId: string }>(…)`),
   * and excluding them made that one call invisible — a false orphan report, caught by this check's own
   * failure rather than by inspection. A paren is the correct boundary because it is where the call begins.
   */
  const callSite = (name: string): RegExp =>
    new RegExp(`\\bapi\\.${name.replace(".", "\\.")}\\s*(?:<[^()]*?>)?\\s*\\(`);

  it("has a screen calling every client method", async () => {
    const ui = await uiSource();
    const orphans = clientMethods().filter((name) => !callSite(name).test(ui));

    // Both directions, so the allowlist cannot rot: an unreached method must be declared, AND a declared
    // one that has since gained a caller must be removed from the list.
    expect(orphans.filter((name) => !(name in UNREACHED)), "unreached client methods — wire them to a screen or declare why not")
      .toEqual([]);
    expect(Object.keys(UNREACHED).filter((name) => !orphans.includes(name)), "declared unreached but now called — drop it from UNREACHED")
      .toEqual([]);
  });

  it("finds the screen sources and matches a known call site, so the check above is not vacuous", async () => {
    expect((await uiFiles()).length).toBeGreaterThan(8);

    const ui = await uiSource();
    // Two controls, because the first run failed BOTH ways at once. `workspace` is called WITH a type
    // argument and `decks.remove` WITHOUT one — the detector has to see both forms, and matching a literal
    // `api.name(` saw neither, reporting every method as an orphan.
    expect(callSite("decks.workspace").test(ui), "detector misses a call with a type argument").toBe(true);
    expect(callSite("decks.remove").test(ui), "detector misses a call without a type argument").toBe(true);
    // And a negative control: a method that does not exist must NOT match, or the regex is matching
    // anything and "no orphans" would mean nothing.
    expect(callSite("decks.notAMethod").test(ui)).toBe(false);
  });
});
