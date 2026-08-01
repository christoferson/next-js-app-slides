/**
 * Pull a JSON object out of model text (CLAUDE.md §9 row 3: "JSON wrapped in markdown fences /
 * preamble text → extractor recovers it").
 *
 * A prompt can *ask* for bare JSON and mostly get it. "Mostly" is the problem: the observed failure
 * modes are a ```json fence, a "Here's the JSON:" preamble, a trailing "Let me know if…", or all
 * three. Each is trivially recoverable, and spending the single repair call on any of them would be
 * waste — repair exists for content that is genuinely unusable, not for packaging.
 *
 * ## Why brace-matching rather than a regex
 *
 * A regex for "the outermost {...}" is either greedy (swallows trailing prose that happens to contain
 * a brace) or lazy (stops at the first nested `}`). Both fail on real slide content, which routinely
 * contains braces inside strings — a quoted code snippet, a `{placeholder}` in copy. So this scans
 * with a depth counter that is **string- and escape-aware**: a brace inside a JSON string literal does
 * not change depth. That is the whole reason this is 40 lines instead of one.
 *
 * What this does NOT do: repair malformed JSON (no quote-fixing, no trailing-comma stripping). That
 * is a different and much riskier job — silently reinterpreting broken output can invent content that
 * the model never produced, and §9 already has a correct answer for it (the repair pass, then the
 * fallback). This only strips packaging.
 */

/** `undefined` when there is no parseable object — the caller escalates rather than guessing. */
export function extractJsonObject(text: string): unknown {
  for (const candidate of candidates(text)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      // Arrays and scalars are rejected: every schema in this app expects an object, and accepting an
      // array here would turn a structurally wrong response into a confusing zod error further down.
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate. A failure here is expected, not exceptional.
    }
  }
  return undefined;
}

/**
 * Candidate substrings, cheapest and most-likely first:
 *  1. the whole text (the happy path — a compliant model, and no scanning cost);
 *  2. each fenced block's contents (```json … ``` or a bare fence);
 *  3. each balanced brace span found by the depth scan.
 *
 * A generator so the common case stops after one `JSON.parse`.
 */
function* candidates(text: string): Generator<string> {
  const trimmed = text.trim();
  if (trimmed === "") return;
  yield trimmed;

  for (const block of fencedBlocks(trimmed)) yield block;
  for (const span of balancedObjects(trimmed)) yield span;
}

/**
 * Contents of ``` fences. The opening fence's info string (```json, ```JSON, ```ts) is dropped.
 *
 * An UNCLOSED fence still yields its remainder: a response truncated at `max_tokens` mid-fence is
 * exactly when recovery matters most, and the JSON inside may still be complete.
 */
function* fencedBlocks(text: string): Generator<string> {
  const fence = /```[^\n]*\n?/g;
  let match: RegExpExecArray | null;
  const starts: number[] = [];
  while ((match = fence.exec(text)) !== null) starts.push(match.index + match[0].length);

  for (const start of starts) {
    const end = text.indexOf("```", start);
    yield (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
  }
}

/**
 * Every balanced `{…}` span, outermost first.
 *
 * String-aware: a `{`, `}`, or `"` inside a JSON string literal is content, not structure, and `\"`
 * inside that string does not end it. Without this, slide copy containing a brace silently shifts the
 * depth counter and the extracted span is garbage — the kind of bug that only appears on real content.
 */
function* balancedObjects(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') { inString = true; continue; }

    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        yield text.slice(start, i + 1);
        start = -1;
      }
    }
  }

  // An unterminated object (truncated at `max_tokens`) yields nothing: the tail is genuinely
  // incomplete, and closing the braces ourselves would fabricate structure. §9's repair/fallback owns
  // that case, and `isTruncatedStopReason` tells the caller it happened.
}
