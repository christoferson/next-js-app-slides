import Link from "next/link";
import { Palette, Presentation } from "lucide-react";

/**
 * The landing page. A server component with no data fetching: it links to the two real screens, and a
 * dashboard that counted brands and decks here would make the first paint wait on two requests to show
 * numbers nobody navigates by.
 */
export default function Home() {
  return (
    <div className="max-w-2xl space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">On-Brand Deck Studio</h1>
        <p className="text-ink-soft">
          Describe a deck; get slides that already match your brand. Colours, fonts, and layout come from a
          brand config — the model only ever writes words.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/brands"
          className="group rounded-lg border border-line bg-white p-4 transition-colors hover:border-ink-soft"
        >
          <Palette aria-hidden className="size-5 text-ink-soft" />
          <h2 className="mt-2 font-medium group-hover:underline">Brands</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Colours, fonts, tone, and per-layout backgrounds. Start here — every deck renders through one.
          </p>
        </Link>

        <Link
          href="/decks"
          className="group rounded-lg border border-line bg-white p-4 transition-colors hover:border-ink-soft"
        >
          <Presentation aria-hidden className="size-5 text-ink-soft" />
          <h2 className="mt-2 font-medium group-hover:underline">Decks</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Write a briefing, generate an outline, fill the slides, then export to PowerPoint.
          </p>
        </Link>
      </div>
    </div>
  );
}
