"use client";

/**
 * Theme provider + toggle for the studio chrome (SPEC §10's `next-themes`).
 *
 * ## Why a client component wrapper exists at all
 *
 * `app/layout.tsx` is a server component and must stay one — it renders on every route, and making it a
 * client component would ship the whole shell to the browser and cost every page a render pass. `ThemeProvider`
 * uses `useState`/`useEffect`, so it needs a `"use client"` boundary. This file is that boundary, and it is
 * the smallest possible one: the provider and the button, nothing else.
 *
 * ## What the provider is configured to do, and why
 *
 * - `attribute="class"` — pairs with the `@custom-variant dark (&:where(.dark, .dark *))` in `globals.css`.
 *   VERIFIED that without that declaration Tailwind 4.3.3 compiles `dark:` to a `prefers-color-scheme`
 *   media query and emits no `.dark` selector at all, so a class toggle would be inert
 *   (`out/probe-dark-variant/`). The two settings are one mechanism and must not be changed apart.
 * - `defaultTheme="system"` + `enableSystem` — an unvisited user gets their OS preference rather than a
 *   choice we invented for them. The explicit toggle then persists to `localStorage`.
 * - `enableColorScheme` — makes the library maintain `color-scheme` on <html>, which is what themes native
 *   widgets (scrollbars, the brand editor's file input). `globals.css` declares the same values as a
 *   no-JS fallback.
 * - `disableTransitionOnChange` — without it, every element carrying `transition-colors` (every Button)
 *   animates for 150ms on a theme flip, which reads as a stutter across the whole page.
 */

import { useSyncExternalStore } from "react";
import { ThemeProvider as NextThemeProvider, useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      enableColorScheme
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}

/** The three explicit states, in toggle order. `system` is a real choice, not the absence of one. */
const MODES = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/**
 * Is this render happening on the client, after hydration?
 *
 * ## Why `useSyncExternalStore` and not `useState` + `useEffect`
 *
 * The usual spelling of this guard is `const [m, setM] = useState(false); useEffect(() => setM(true), [])`,
 * and ESLint rejects it here — `react-hooks/set-state-in-effect`, the same rule `use-resource.ts` documents.
 * That rule is right: the effect exists only to learn *where the code is running*, which is not state to
 * synchronize, and the pattern costs a second render pass on every mount.
 *
 * `useSyncExternalStore` says exactly this and nothing more: the server snapshot is `false`, the client
 * snapshot is `true`, and nothing ever changes afterwards, so `subscribe` is a no-op returning a no-op.
 * React calls the server snapshot during SSR and the client snapshot after hydration, which is the precise
 * distinction needed — with no effect, no cascading render, and no rule to silence.
 *
 * A module-level `let` set in an effect would also satisfy the linter and would be a lie: it would make the
 * value depend on which component mounted first.
 */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};
const useHydrated = (): boolean => useSyncExternalStore(NOOP_SUBSCRIBE, () => true, () => false);

/**
 * The theme toggle.
 *
 * ## The hydration guard is not boilerplate
 *
 * On the server, and during the first client render, the active theme is genuinely unknown: it lives in
 * `localStorage`, which the server cannot read. Rendering the resolved icon immediately would mean the
 * server markup says "light" while the client corrects it to "dark" a moment later — a hydration mismatch,
 * and a visible flicker on every page load. So until hydrated this renders a same-sized placeholder, which
 * keeps the header from reflowing when the real control appears.
 *
 * It cycles rather than opening a menu: three states, and a popover for three options would be more
 * chrome than the choice deserves. `aria-label` announces both the current state and what pressing does,
 * because the icon alone cannot say which of the two it means.
 */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const hydrated = useHydrated();

  // Reserve the exact button box so mounting does not shift the nav beside it.
  if (!hydrated) return <div className="size-8" aria-hidden />;

  const index = MODES.findIndex((m) => m.value === theme);
  // An unrecognized stored value (a hand-edited localStorage key, or a theme we removed) lands on -1;
  // treating that as "before light" makes the next press land on `light` rather than crashing on undefined.
  const current = MODES[index === -1 ? 0 : index] ?? MODES[0];
  const next = MODES[(index + 1) % MODES.length] ?? MODES[0];
  const { Icon } = current;

  return (
    <button
      type="button"
      onClick={() => setTheme(next.value)}
      // Says what is on AND what the press will do — an icon cannot distinguish those two readings.
      aria-label={`Theme: ${current.label}${
        current.value === "system" && resolvedTheme ? ` (${resolvedTheme})` : ""
      }. Switch to ${next.label}.`}
      title={`Theme: ${current.label} — switch to ${next.label}`}
      className="inline-flex size-8 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-canvas hover:text-ink"
    >
      <Icon aria-hidden className="size-4" />
    </button>
  );
}
