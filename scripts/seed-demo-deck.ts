/**
 * Seed a real, generated deck against a RUNNING server — so the UI can be clicked through with content
 * rather than empty states.
 *
 * Not a test and not part of `verify`: it needs a live server and live Bedrock credentials, exactly like
 * `scripts/smoke.ts`. Unlike smoke, it deliberately leaves everything behind — the point is to have a brand
 * and a fully generated deck sitting in the dev data directory to open in the browser.
 *
 * Usage: `npx tsx scripts/seed-demo-deck.ts` with `npm run dev` already running.
 *
 * It drives the SAME HTTP API the browser uses, which is what makes it a check on the UI's data path and not
 * just on the services: anything this script cannot do through the API, the UI cannot do either.
 */

const BASE = process.env["BASE_URL"] ?? "http://127.0.0.1:3000";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

async function main(): Promise<void> {
  const brand = await call<{ id: string; name: string }>("POST", "/api/brands", {
    name: "Northwind Studio",
    // Non-default colours and fonts on purpose: a demo deck in the default palette proves nothing about
    // whether the brand actually reaches the render path.
    colors: {
      primary: "0B3D2E", secondary: "35564B", accent: "C9743B",
      background: "FBF9F4", surface: "F1EDE3", textOnLight: "14211C", textOnDark: "FBF9F4",
    },
    fonts: { heading: "georgia", body: "verdana" },
    tone: {
      // A TONES registry id, not prose — the registry owns each voice's `promptFragment`, which is the only
      // brand field allowed to reach a prompt (§7). `/api/registry/tones` lists the valid ids.
      voice: "consultative",
      traits: ["concrete", "unhurried"],
      bannedWords: ["synergy", "leverage", "utilize"],
    },
  });
  console.log(`brand   ${brand.id}  ${brand.name}`);

  const deck = await call<{ id: string }>("POST", "/api/decks", {
    title: "Trunk-based development: a pilot proposal",
    brandId: brand.id,
  });
  console.log(`deck    ${deck.id}`);

  await call("PATCH", `/api/decks/${deck.id}`, {
    briefing: {
      topic: "Adopting trunk-based development on the platform team",
      audience: "Engineering managers, mixed technical depth",
      objective: "Get agreement to pilot it on one team next quarter",
      targetSlideCount: 6,
    },
  });
  console.log("briefing saved");

  const outline = await call<{
    outline: { sections: { heading: string; slides: { visualHint: string; message: string }[] }[] };
    advisories: unknown[];
    repaired: boolean;
  }>("POST", `/api/decks/${deck.id}/outline`, {});

  const slides = outline.outline.sections.flatMap((s) => s.slides);
  console.log(`outline  ${outline.outline.sections.length} sections, ${slides.length} slides, repaired=${outline.repaired}`);
  console.log(`         advisories: ${JSON.stringify(outline.advisories)}`);
  for (const section of outline.outline.sections) {
    console.log(`  § ${section.heading}`);
    for (const slide of section.slides) {
      console.log(`     - ${slide.visualHint.padEnd(10)} ${slide.message.slice(0, 68)}`);
    }
  }

  // Generation is SSE. Consumed with a manual parser here rather than importing the client's
  // `streamGeneration`, which is browser-oriented — but the frames are the same ones the UI reads, so a
  // decode failure here would be a decode failure there.
  console.log("\ngenerating…");
  const response = await fetch(`${BASE}/api/decks/${deck.id}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ includeSpeakerNotes: true }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`generate → ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart()).join("\n");
      if (data === "") continue;
      const event = JSON.parse(data) as Record<string, unknown>;
      // `slide-delta` and `ping` are high-frequency and uninteresting in a log.
      if (event["type"] === "slide-delta" || event["type"] === "ping") continue;
      console.log(`  ${JSON.stringify(event)}`);
    }
  }

  const workspace = await call<{
    slides: { order: number; layoutId: string; flags: string[]; issue?: { message: string } }[];
    tokens: { notices: unknown[] };
    exportFormats: string[];
  }>("GET", `/api/decks/${deck.id}/workspace`);

  console.log(`\nworkspace: ${workspace.slides.length} slides, formats=${workspace.exportFormats.join(",")}`);
  console.log(`theme notices: ${JSON.stringify(workspace.tokens.notices)}`);
  for (const slide of [...workspace.slides].sort((a, b) => a.order - b.order)) {
    const flags = slide.flags.length > 0 ? ` [${slide.flags.join(",")}]` : "";
    const issue = slide.issue ? ` ⚠ ${slide.issue.message}` : "";
    console.log(`  ${String(slide.order + 1).padStart(2)}  ${slide.layoutId.padEnd(16)}${flags}${issue}`);
  }

  console.log(`\n▶ open ${BASE}/decks/${deck.id}`);
}

// Not top-level `await`: tsx transforms these scripts to CJS, which rejects it. Same shape as `smoke.ts`.
main().catch((err: unknown) => {
  console.error(`\nSEED FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
