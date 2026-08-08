import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Palette, Presentation } from "lucide-react";
import { ThemeProvider, ThemeToggle } from "@/components/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "On-Brand Deck Studio",
  description: "Generate on-brand presentation decks from a brand config and a briefing.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

/**
 * The app shell. A server component with no data fetching of its own — the nav is static, and a layout that
 * loaded the brand list would make every route wait on it.
 *
 * It stays a server component with dark mode added: `ThemeProvider` is a `"use client"` island
 * (`components/theme.tsx`) wrapped around `children` rather than this file gaining the directive, which
 * would ship the whole shell to the browser.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` is REQUIRED here, and only here. `next-themes` injects a blocking script
    // that sets `class="dark"` on this element before paint — that is what prevents a flash of the wrong
    // theme — so the DOM React hydrates against legitimately differs from the HTML it sent. Without this,
    // React logs a mismatch on every load for a difference that is the intended behaviour. It applies to
    // this element's own attributes, not to its subtree, so it hides nothing else.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh">
        <ThemeProvider>
          <header className="border-b border-line bg-surface">
            <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
              <Link href="/" className="text-sm font-semibold">On-Brand Deck Studio</Link>
              <nav className="flex items-center gap-1 text-sm">
                <Link
                  href="/brands"
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-ink-soft hover:bg-canvas hover:text-ink"
                >
                  <Palette aria-hidden className="size-4" />
                  Brands
                </Link>
                <Link
                  href="/decks"
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-ink-soft hover:bg-canvas hover:text-ink"
                >
                  <Presentation aria-hidden className="size-4" />
                  Decks
                </Link>
              </nav>
              <div className="ml-auto">
                <ThemeToggle />
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}
