import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Palette, Presentation } from "lucide-react";
import "./globals.css";

export const metadata: Metadata = {
  title: "On-Brand Deck Studio",
  description: "Generate on-brand presentation decks from a brand config and a briefing.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

/**
 * The app shell. A server component with no data fetching of its own — the nav is static, and a layout that
 * loaded the brand list would make every route wait on it.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <header className="border-b border-line bg-white">
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
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
