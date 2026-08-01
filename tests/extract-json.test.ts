/**
 * The tolerant JSON extractor (CLAUDE.md §9 row 3: "JSON wrapped in markdown fences / preamble text →
 * extractor recovers it (build a tolerant extractor), validates").
 *
 * Two properties, and the second is the one that needs the tests:
 *
 *  1. **Recovers** the packaging failures a compliant-ish model actually produces — a ```json fence, a
 *     "Here's the JSON:" preamble, trailing prose. Each of these costing the single repair call would be
 *     waste; repair exists for unusable content, not for wrapping.
 *  2. **Does not repair** malformed JSON. No quote-fixing, no trailing-comma stripping, no closing of
 *     unbalanced braces. Silently reinterpreting broken output invents content the model never produced,
 *     and §9 already has the correct answer (repair, then fallback). Most of this file asserts the
 *     *absence* of cleverness, because that is the property most likely to erode under a "just make this
 *     one case work" change.
 *
 * The brace scan is string- and escape-aware, and the cases that matter are slide copy containing braces
 * and quotes — which is not exotic: a deck about JSON, a `{placeholder}` in marketing copy, a quoted
 * statement with escaped quotes inside it.
 */

import { describe, expect, it } from "vitest";
import { extractJsonObject } from "@/lib/generation/extract-json";

const OBJ = { slots: { title: "Revenue grew 42%", items: ["Up from 4", "Six days"] } };
const JSON_TEXT = JSON.stringify(OBJ);

describe("the happy path", () => {
  it("parses bare JSON", () => {
    expect(extractJsonObject(JSON_TEXT)).toEqual(OBJ);
  });

  it("tolerates surrounding whitespace and newlines", () => {
    expect(extractJsonObject(`\n\n  ${JSON_TEXT}  \n`)).toEqual(OBJ);
  });

  it("handles pretty-printed JSON", () => {
    expect(extractJsonObject(JSON.stringify(OBJ, null, 2))).toEqual(OBJ);
  });
});

describe("§9 row 3 — packaging is stripped, not repaired", () => {
  it.each([
    ["```json fence", "```json\n" + JSON_TEXT + "\n```"],
    ["```JSON fence, upper case", "```JSON\n" + JSON_TEXT + "\n```"],
    ["bare ``` fence", "```\n" + JSON_TEXT + "\n```"],
    ["fence with a wrong info string", "```ts\n" + JSON_TEXT + "\n```"],
    ["fence with no trailing newline", "```json\n" + JSON_TEXT + "```"],
    ["preamble", "Here's the JSON you asked for:\n\n" + JSON_TEXT],
    ["postamble", JSON_TEXT + "\n\nLet me know if you'd like a different angle."],
    ["both", "Sure! Here you go:\n" + JSON_TEXT + "\nHappy to revise."],
    ["fence plus preamble plus postamble",
      "Here's the JSON:\n```json\n" + JSON_TEXT + "\n```\nHope that helps!"],
    ["an unclosed fence", "```json\n" + JSON_TEXT],
  ])("recovers from %s", (_label, text) => {
    expect(extractJsonObject(text)).toEqual(OBJ);
  });

  it("recovers from a fence whose content is followed by prose INSIDE the fence", () => {
    // Seen in practice when a model explains itself without closing the block properly.
    expect(extractJsonObject("```\n" + JSON_TEXT + "\n\nThat covers it.\n```")).toEqual(OBJ);
  });
});

describe("brace scanning is string- and escape-aware", () => {
  it("recovers an object whose content contains braces", () => {
    // A naive lazy regex stops at the first `}` inside the string and yields garbage.
    const obj = { slots: { title: "Use the {customerName} token" } };
    expect(extractJsonObject("Here: " + JSON.stringify(obj))).toEqual(obj);
  });

  it("recovers an object whose content contains an ESCAPED quote", () => {
    const obj = { slots: { quote: 'She said "it quadrupled" on the call' } };
    expect(extractJsonObject("Result:\n" + JSON.stringify(obj))).toEqual(obj);
  });

  it("recovers an object whose content contains an escaped backslash before a quote", () => {
    // `"…path\\"` — the backslash is escaped, so the quote DOES close the string. Getting this wrong
    // shifts the depth counter for the rest of the scan.
    const obj = { slots: { title: "The C:\\\\ drive" } };
    expect(extractJsonObject("ok " + JSON.stringify(obj))).toEqual(obj);
  });

  it("recovers an object containing a brace-and-quote-heavy code sample", () => {
    const obj = { slots: { items: ['{"a": 1}', 'if (x) { y() }', 'say "hello"'] } };
    expect(extractJsonObject("```json\n" + JSON.stringify(obj) + "\n```")).toEqual(obj);
  });

  it("handles nesting several levels deep", () => {
    const obj = { a: { b: { c: { d: { e: "deep" } } } } };
    expect(extractJsonObject("prose " + JSON.stringify(obj) + " prose")).toEqual(obj);
  });

  it("prefers the OUTERMOST object when prose contains a decoy object after it", () => {
    // The real response first, then an example the model volunteered. Taking the first complete
    // balanced span is right: the answer precedes the commentary.
    const text = JSON_TEXT + '\n\nFor reference, the shape is {"slots": {}}.';
    expect(extractJsonObject(text)).toEqual(OBJ);
  });

  it("skips a leading non-object and finds the object after it", () => {
    // Whole-text parse fails, fence scan finds nothing, brace scan wins.
    expect(extractJsonObject("[1, 2, 3]\n\nActually, here: " + JSON_TEXT)).toEqual(OBJ);
  });
});

describe("what it refuses — objects only", () => {
  it.each([
    ["an array of scalars", "[1, 2, 3]"],
    ["a bare string", '"just a string"'],
    ["a number", "42"],
    ["a boolean", "true"],
    ["null", "null"],
  ])("rejects %s", (_label, text) => {
    // Every schema in the app expects an object; accepting an array here would surface as a confusing
    // zod error two layers down instead of a clean "not a JSON object" issue the repair pass can act on.
    expect(extractJsonObject(text)).toBeUndefined();
  });

  it("finds an object nested inside an array wrapper rather than rejecting outright", () => {
    // The top-level value is rejected, but the brace scan then reaches the object inside. Debatable,
    // and worth pinning: a model that wrapped its single answer in an array has produced usable
    // content, and the alternative is a wasted repair call.
    expect(extractJsonObject("[" + JSON_TEXT + "]")).toEqual(OBJ);
    expect(extractJsonObject('[{"a":1}]')).toEqual({ a: 1 });
  });

  it("takes the FIRST object from a multi-element array, not a merge of them", () => {
    // The consequence of the rule above, made explicit: with two candidates there is no principled
    // choice, and merging would fabricate a response. First wins, and the schema decides from there.
    expect(extractJsonObject('[{"a":1},{"b":2}]')).toEqual({ a: 1 });
  });
});

describe("what it refuses — it does NOT repair malformed JSON", () => {
  // The property most likely to erode. Each of these is one small "fix" away from working, and each
  // fix would let the extractor invent content.

  it.each([
    ["a trailing comma", '{"a": 1,}'],
    ["single quotes", "{'a': 1}"],
    ["unquoted keys", "{a: 1}"],
    ["a missing closing brace", '{"a": 1'],
    ["a missing closing quote", '{"a": "unterminated'],
    ["truncated mid-key", '{"slots":{"tit'],
    ["truncated mid-array", '{"slots":{"items":["one","tw'],
    ["JS comments", '{"a": 1 /* nope */}'],
    ["NaN", '{"a": NaN}'],
    ["a python-ish None", '{"a": None}'],
  ])("returns undefined for %s", (_label, text) => {
    expect(extractJsonObject(text)).toBeUndefined();
  });

  it("does not close braces on a response truncated at max_tokens", () => {
    // The `max_tokens` case specifically: the tail is genuinely incomplete, and fabricating structure
    // here would produce a slide with content the model never finished writing.
    const truncated = JSON_TEXT.slice(0, JSON_TEXT.length - 8);
    expect(extractJsonObject(truncated)).toBeUndefined();
  });

  it("still recovers a COMPLETE object from a response truncated after it", () => {
    // The other side of the same coin: the object finished, only the prose was cut.
    expect(extractJsonObject(JSON_TEXT + "\n\nLet me know if you'd like me to adj")).toEqual(OBJ);
  });
});

describe("degenerate input never throws", () => {
  it.each([
    ["an empty string", ""],
    ["whitespace only", "   \n\t  "],
    ["prose with no JSON at all", "I'd be happy to help! Could you tell me more about the audience?"],
    ["an unmatched closing brace", "}"],
    ["only braces", "{}{}{}"],
    ["a lone fence", "```"],
    ["a fence with nothing in it", "```json\n```"],
  ])("handles %s", (_label, text) => {
    expect(() => extractJsonObject(text)).not.toThrow();
  });

  it("returns {} for an empty object, which is a valid object", () => {
    // Distinct from `undefined`: the caller's all-empty check (in `handlers.ts`) is what rejects it, and
    // conflating "no JSON found" with "an empty object" would report the wrong issue to the repair pass.
    expect(extractJsonObject("{}")).toEqual({});
  });

  it("does not hang or blow the stack on deeply unbalanced input", () => {
    expect(extractJsonObject("{".repeat(5000))).toBeUndefined();
    expect(extractJsonObject("}".repeat(5000))).toBeUndefined();
  });

  it("handles a long response with many fences", () => {
    const text = Array.from({ length: 50 }, (_, i) => `\`\`\`json\n{"n":${i}}\n\`\`\``).join("\n") ;
    // First complete parse wins; the whole-text parse fails, so the first fence does.
    expect(extractJsonObject(text)).toEqual({ n: 0 });
  });
});

describe("unicode and formatting survive intact", () => {
  it("preserves non-ASCII content", () => {
    const obj = { slots: { title: "日本語も確認 — em-dash, ellipsis…, 42 %" } };
    expect(extractJsonObject("```json\n" + JSON.stringify(obj) + "\n```")).toEqual(obj);
  });

  it("preserves escaped newlines inside strings", () => {
    const obj = { slots: { title: "line one\nline two" } };
    const parsed = extractJsonObject("here: " + JSON.stringify(obj)) as typeof obj;
    expect(parsed.slots.title).toBe("line one\nline two");
  });

  it("does not confuse a newline inside a string with the end of the object", () => {
    const obj = { slots: { title: "a\nb", items: ["c\nd"] } };
    expect(extractJsonObject(JSON.stringify(obj) + "\ntrailing")).toEqual(obj);
  });
});
