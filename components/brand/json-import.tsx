"use client";

/**
 * The paste-or-pick JSON import control, shared by the two screens that import a brand config (SPEC §5,
 * §11 step 3, §12).
 *
 * ## Why this is one component and not two copies
 *
 * There are two import flows and they differ only in their *target*: the brand editor REPLACES the brand
 * being edited (`PUT /api/brands/:id/import`), the gallery CREATES a new one (`POST /api/brands/import`).
 * Everything else — parse locally only far enough to be an object, hand the rest to the server, render its
 * zod issues field-by-field, clear on success — is identical. The previous pass through this codebase found
 * a field class string hand-copied to eleven call sites with three of them subtly wrong; the same reasoning
 * applies to behaviour. So the shape lives here once and the *target* is a callback.
 *
 * ## Paste AND file, one submit path
 *
 * Pasting is how a config shared in a chat message arrives; a file is what "Export JSON" produces. Both are
 * offered, and picking a file fills the textarea rather than submitting directly — so there is exactly one
 * submit path, the user sees what is about to be sent, and a rejected file can be corrected in place
 * instead of re-exported.
 *
 * ## What is NOT validated here
 *
 * Only `JSON.parse`. A local parse failure gets its own message because it is not an `ApiError` and the
 * server would only produce a vaguer one. Everything else — required fields, colour formats, zone bounds,
 * unknown asset ids — is the server's judgement, surfaced through `InvalidBrandConfig`'s allowlisted
 * `issues`. Duplicating any of it here would be a second implementation of a rule that already has an
 * owner, and §12's "nothing partially applied" is guaranteed by the service validating before any write.
 */

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button, ErrorNote, Field, Textarea } from "@/components/ui/primitives";

export interface JsonImportFieldProps {
  label: string;
  hint: string;
  submitLabel: string;
  /** Rendered on the button while this import is the in-flight action. */
  pendingLabel: string;
  busy: boolean;
  /** Receives the parsed value — an object, but `unknown` because the server is the validator. */
  onSubmit: (parsed: unknown) => void;
}

export function JsonImportField(
  { label, hint, submitLabel, pendingLabel, busy, onSubmit }: JsonImportFieldProps,
) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setParseError(undefined);
    setText(await file.text());
    // Cleared so choosing the same file twice fires `change` again — otherwise a file that was rejected
    // cannot be retried after being edited on disk.
    if (fileInput.current !== null) fileInput.current.value = "";
  };

  const submit = (): void => {
    setParseError(undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setParseError("That isn't valid JSON. Paste the whole exported file, including its braces.");
      return;
    }
    onSubmit(parsed);
    setText("");
  };

  return (
    <div className="space-y-2">
      <Field label={label} hint={hint}>
        <Textarea
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder='{"name":"Acme","colors":{…},"fonts":{…},"tone":{…},"templates":{…}}'
        />
      </Field>

      {parseError !== undefined && <ErrorNote message={parseError} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={submit} disabled={busy || text.trim() === ""}>
          {busy ? pendingLabel : submitLabel}
        </Button>

        {/* A label wrapping a hidden input: the same styling as a Button without nesting a control inside
            one, which would be invalid HTML with unpredictable click behaviour. */}
        <label className="cursor-pointer text-xs text-ink-soft underline hover:text-ink">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => void pick(event.target.files?.[0])}
          />
          <Upload aria-hidden className="mr-1 inline size-3.5" />
          or choose a .json file
        </label>

        {text.trim() !== "" && (
          <button
            type="button"
            className="text-xs text-ink-soft underline hover:text-ink"
            onClick={() => { setText(""); setParseError(undefined); }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
