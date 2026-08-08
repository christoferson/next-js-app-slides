"use client";

/**
 * The per-slide content editor (SPEC §7.4) — one control per slot, driven by the layout's `SlotSpec[]`.
 *
 * ## Why the layout registry decides the form
 *
 * Nothing here knows what a `title` or a `bullets` slot is. The fields, their order, whether each is a
 * textarea or a list, and every character budget come from the layout's declared slots, fetched from
 * `/api/registry/layouts`. That is CLAUDE.md §4's rule applied to the UI: adding a layout must not require
 * editing a screen, and §10's one-file proof would fail if this file carried a parallel table of slot keys.
 *
 * ## Budgets are shown, not enforced
 *
 * The counter goes amber past `maxChars`, and typing is NOT blocked. The server truncates at a word
 * boundary and returns a `trimmed` flag (§9), so a client-side hard limit would be a second, subtly
 * different implementation of a rule that already has one owner — and one that silently ate keystrokes.
 * Showing the budget while letting the server decide keeps the two honest.
 */

import { useId } from "react";
import { Plus, X } from "lucide-react";
import type { SlotValue, SlotValues } from "@/lib/domain/slots";
import { isListSlot } from "@/lib/domain/slots";
import type { SlotSpec } from "@/lib/layouts/types";
import { Button, Textarea, cn } from "@/components/ui/primitives";

export interface SlotEditorProps {
  slots: readonly SlotSpec[];
  values: SlotValues;
  onChange: (next: SlotValues) => void;
  disabled?: boolean;
}

export function SlotEditor({ slots, values, onChange, disabled }: SlotEditorProps) {
  const set = (key: string, value: string | string[]): void => onChange({ ...values, [key]: value });

  return (
    <div className="space-y-4">
      {slots.map((spec) => (
        <SlotField
          key={spec.key}
          spec={spec}
          value={values[spec.key]}
          onChange={(value) => set(spec.key, value)}
          {...(disabled !== undefined ? { disabled } : {})}
        />
      ))}
    </div>
  );
}

function SlotField(
  { spec, value, onChange, disabled }: {
    spec: SlotSpec;
    // Explicitly optional: a slot a layout declares may simply be absent from a slide's values (an optional
    // slot the model left out, or a slide whose layout was switched). `noUncheckedIndexedAccess` surfaces
    // that, and the honest fix is to accept it here rather than assert it away at the call site.
    value: SlotValue | undefined;
    onChange: (value: string | string[]) => void;
    disabled?: boolean;
  },
) {
  const id = useId();
  const isList = spec.type === "list";

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-ink-soft">
          {spec.key}
          {spec.required && <span className="ml-1 text-red-600" title="Required">*</span>}
        </label>
        <span className="text-[11px] text-ink-soft/70" title={spec.description}>
          {isList
            ? `${(isListSlot(value) ? value : []).length}/${spec.maxItems ?? "∞"} items`
            : <Counter used={typeof value === "string" ? value.length : 0} budget={spec.maxChars} />}
        </span>
      </div>

      {isList
        ? (
          <ListInput
            id={id}
            items={isListSlot(value) ? value : []}
            spec={spec}
            onChange={onChange}
            {...(disabled !== undefined ? { disabled } : {})}
          />
        )
        : (
          <Textarea
            id={id}
            // Two rows for short slots, four for prose. Derived from the budget rather than hardcoded per
            // slot so a new layout's fields are sized sensibly with no edit here.
            rows={spec.maxChars > 120 ? 4 : 2}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            placeholder={spec.description}
          />
        )}
    </div>
  );
}

/** Amber past budget — the same signal as the `trimmed` badge, before the server has to apply it. */
function Counter({ used, budget }: { used: number; budget: number }) {
  return (
    <span className={cn(used > budget && "font-medium text-flag")}>
      {used}/{budget}
    </span>
  );
}

function ListInput(
  { id, items, spec, onChange, disabled }: {
    id: string;
    items: readonly string[];
    spec: SlotSpec;
    onChange: (value: string[]) => void;
    disabled?: boolean;
  },
) {
  const replace = (index: number, text: string): void =>
    onChange(items.map((item, i) => (i === index ? text : item)));
  const remove = (index: number): void => onChange(items.filter((_, i) => i !== index));
  const add = (): void => onChange([...items, ""]);

  const itemBudget = spec.itemMaxChars ?? spec.maxChars;
  const atMax = spec.maxItems !== undefined && items.length >= spec.maxItems;

  return (
    <div className="space-y-1.5">
      {items.map((item, index) => (
        // Index keys: list items are positional content with no identity of their own, and an
        // item-text key would remount the input the user is typing in on every keystroke.
        <div key={index} className="flex items-start gap-1.5">
          <Textarea
            {...(index === 0 ? { id } : {})}
            rows={1}
            value={item}
            onChange={(event) => replace(index, event.target.value)}
            disabled={disabled}
          />
          <span className="w-14 shrink-0 pt-2 text-right text-[11px] text-ink-soft/70">
            <Counter used={item.length} budget={itemBudget} />
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => remove(index)}
            disabled={disabled}
            aria-label={`Remove item ${index + 1}`}
            className="mt-0.5"
          >
            <X aria-hidden className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={add} disabled={disabled || atMax}>
        <Plus aria-hidden className="size-3.5" />
        Add item
      </Button>
      {atMax && (
        <p className="text-[11px] text-ink-soft/70">
          This layout holds {spec.maxItems} items — extras would be dropped on export.
        </p>
      )}
    </div>
  );
}
