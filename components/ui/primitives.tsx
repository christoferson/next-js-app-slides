/**
 * The small shared UI vocabulary. Neutral chrome only — see `app/globals.css` for why the studio's own
 * colours never come from the user's brand.
 *
 * Kept deliberately small rather than pulling in the full shadcn/ui surface: SPEC §10 names it as the
 * stack, and these are its conventions (`cn` over `clsx`+`tailwind-merge`, `cva` variants), but generating
 * thirty component files to use six of them would make the real ones harder to find.
 */

import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { AlertTriangle } from "lucide-react";

/** The standard shadcn class merger: later Tailwind utilities win over earlier conflicting ones. */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

/* ─────────────────────────────── button ─────────────────────────────── */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors "
  + "disabled:pointer-events-none disabled:opacity-50";

const BUTTON_VARIANT: Record<NonNullable<ButtonProps["variant"]>, string> = {
  // `text-canvas`, not `text-white`: the fill is `bg-ink`, which becomes near-white in dark mode, so a
  // fixed white label would be white-on-white. Pairing the two tokens keeps the contrast inverted with
  // the theme instead of surviving only by luck in one of them.
  primary: "bg-ink text-canvas hover:bg-ink-soft",
  secondary: "border border-line bg-surface text-ink hover:bg-canvas",
  ghost: "text-ink-soft hover:bg-canvas hover:text-ink",
  danger: "border border-danger-line bg-surface text-danger hover:bg-danger-bg",
};

const BUTTON_SIZE: Record<NonNullable<ButtonProps["size"]>, string> = {
  sm: "h-8 px-2.5 text-xs",
  md: "h-9 px-3.5 text-sm",
};

export function Button({ variant = "secondary", size = "md", className, ...rest }: ButtonProps) {
  return (
    <button
      // `type` defaults to "submit" in HTML, which makes any button inside a form submit it by accident.
      // Defaulting to "button" here and letting callers opt into submit is the safer direction.
      type="button"
      className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      {...rest}
    />
  );
}

/* ─────────────────────────────── inputs ─────────────────────────────── */

const FIELD_BASE =
  "w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink "
  + "placeholder:text-ink-soft/60 disabled:opacity-50";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD_BASE, className)} {...rest} />;
}

export function Field(
  { label, hint, children }: { label: string; hint?: string; children: ReactNode },
) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-ink-soft">{label}</span>
      {children}
      {hint !== undefined && <span className="block text-xs text-ink-soft/80">{hint}</span>}
    </label>
  );
}

/* ─────────────────────────────── containers ─────────────────────────────── */

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-line bg-surface", className)} {...rest} />;
}

/* ─────────────────────────────── quality badge (§12) ─────────────────────────────── */

/**
 * The amber quality badge. ONE component for every flag kind, because §12 requires these to be
 * recognizable and never suppressed — a per-screen variant is how one of them quietly stops rendering.
 *
 * `title` carries the explanation rather than a tooltip library: these appear in dense lists, and the
 * native attribute is both accessible and always available.
 */
export function Flag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-flag-bg px-1.5 py-0.5 text-[11px] font-medium text-flag"
      {...(title !== undefined ? { title } : {})}
    >
      <AlertTriangle aria-hidden className="size-3" />
      {children}
    </span>
  );
}

/* ─────────────────────────────── error rendering ─────────────────────────────── */

/**
 * The one error surface — every screen renders `ApiError` through this.
 *
 * `issues` are listed when present, which is §12's "invalid config → field-level readable zod errors":
 * the brand JSON importer's failures arrive as that array, and collapsing them into the summary line
 * would leave the user to guess which field was wrong.
 */
export function ErrorNote(
  { message, issues, onRetry }: { message: string; issues?: readonly string[]; onRetry?: () => void },
) {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-danger-line bg-danger-bg p-3 text-sm text-danger">
      <p>{message}</p>
      {issues !== undefined && issues.length > 0 && (
        <ul className="list-inside list-disc space-y-0.5 text-xs">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      )}
      {onRetry !== undefined && <Button size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-ink-soft">
      {children}
    </div>
  );
}
