/**
 * `stats` — two or three headline numbers with labels.
 *
 * ## Why parallel lists rather than three numbered slot triples
 *
 * The obvious shape is `value1/label1/value2/label2/…` — nine slots for three cards. Two problems: the
 * model has to keep nine keys straight, and the *count* becomes implicit (is `value2` with no `value3`
 * a two-card slide, or a dropped field?). Parallel `values`/`labels`/`notes` lists make the count
 * explicit and give `validate.ts` one budget per list to enforce. `pairCards` zips them.
 *
 * Ragged lists are a real failure mode — a model may return 3 values and 2 labels — so pairing is
 * tolerant: a card renders with whatever it has, and a value with no label still shows its number.
 * Dropping the slide over a missing label would trade real content for a fallback.
 *
 * ## Why this layout renders its own boxes
 *
 * It is the one seed layout whose structure repeats: three cards, each a value/label/note stack. A flat
 * `SlotPaint[]` cannot express "the second item of `values` goes in the second card", so `stats` calls
 * the leaf renderers itself. It still derives every *style* from `previewStyleFor`/`pptxStyleFor`, so
 * the only thing it owns is which box each string lands in — face, size and colour stay shared between
 * the two renderers, which is what §8 actually needs.
 *
 * The zones are the three lists' own band zones (see `cardColumns`), so every required slot has a
 * `defaultZones` entry and the §4 registry invariant holds.
 */

import type { ReactNode } from "react";
import type { SlotZone } from "@/lib/brand/types";
import type { PptxTarget, RenderArgs, SlideLayout } from "@/lib/layouts/types";
import { zoneFor } from "@/lib/layouts/render-mode";
import {
  listOf, paintPptx, paintPreview, Panel, panelPptx, type PaintStyle, type SlotPaint,
  previewStyleFor, pptxStyleFor,
} from "@/lib/layouts/paint";
import { addZoneText } from "@/lib/layouts/pptx-text";
import { SlideFrame, ZoneText } from "@/lib/layouts/preview";

const MAX_CARDS = 3;

/** `title` is flat, so it goes through the declarative painter like every other layout's title. */
const TITLE_PAINT: readonly SlotPaint[] = [
  { slotKey: "title", face: "heading", role: "title", color: "onBackground" },
];

/** The three card stacks' styles. Same shape as `SlotPaint` minus the slot key. */
const VALUE_STYLE: PaintStyle = { face: "heading", role: "display", color: "accent" };
const LABEL_STYLE: PaintStyle = { face: "heading", role: "heading", color: "onSurface" };
const NOTE_STYLE: PaintStyle = { face: "body", role: "caption", color: "onSurface" };

const VALUES_BAND: SlotZone = { slotKey: "values", x: 7, y: 34, w: 86, h: 20, align: "left", valign: "bottom" };
const LABELS_BAND: SlotZone = { slotKey: "labels", x: 7, y: 56, w: 86, h: 18, align: "left", valign: "top" };
const NOTES_BAND: SlotZone = { slotKey: "notes", x: 7, y: 76, w: 86, h: 14, align: "left", valign: "top" };

/** The panel behind the cards spans all three bands. */
const PANEL_Y = 30;
const PANEL_H = 62;
/** Gutter between cards, in slide percent. */
const GUTTER = 2.5;

interface Card {
  value: string;
  label?: string;
  note?: string;
}

/**
 * Zip the parallel lists into cards. Tolerant of ragged input by design — see the header. `values`
 * drives the count, since a label with no number is not a statistic.
 */
export function pairCards(
  values: readonly string[] | undefined,
  labels: readonly string[] | undefined,
  notes: readonly string[] | undefined,
): Card[] {
  return (values ?? []).slice(0, MAX_CARDS).map((value, index) => {
    const label = labels?.[index];
    const note = notes?.[index];
    return {
      value,
      ...(label === undefined || label.trim() === "" ? {} : { label }),
      ...(note === undefined || note.trim() === "" ? {} : { note }),
    };
  });
}

/**
 * Split a band zone into `count` equal columns.
 *
 * A deliberate limit, stated plainly: the brand editor can move and resize each *band* — so a template
 * can raise the numbers, widen the group, or reorder the stack — but it cannot reposition an individual
 * card. Nine zones in the zone table would make one of the commonest layouts the most confusing one to
 * edit, and three-equal-columns is this layout's identity rather than a parameter of it.
 *
 * Columns are computed from the band actually in use, so a customized band still lays out correctly.
 */
export function cardColumns(band: SlotZone, count: number): SlotZone[] {
  const n = Math.max(1, Math.min(count, MAX_CARDS));
  const w = (band.w - GUTTER * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ ...band, x: band.x + i * (w + GUTTER), w }));
}

const bandFor = (zones: readonly SlotZone[], fallback: SlotZone): SlotZone =>
  zoneFor(zones, fallback.slotKey) ?? fallback;

export const statsLayout: SlideLayout = {
  id: "stats",
  displayName: "Statistics",
  description: "Two or three headline numbers with labels — for metrics, results, or scale.",
  intents: ["metrics"],

  slots: [
    {
      key: "title", type: "text", required: true, typeRole: "title", maxChars: 55,
      description: "What these numbers together demonstrate. An assertion, not a label.",
    },
    {
      // A card column is ~27% wide, so at `display` (40pt) a figure has room for ~7 characters. That is
      // the constraint the description states in words: this slot is for "42%", not for "42% year on
      // year". The narrow budget is the layout working as intended rather than a limitation.
      key: "values", type: "list", required: true, typeRole: "display",
      maxChars: 21, maxItems: MAX_CARDS, itemMaxChars: 7,
      description:
        "Two or three short figures, at most seven characters each — e.g. \"42%\", \"3.5x\", \"$1.2M\". "
        + "Take them ONLY from the supplied evidence: never estimate, round beyond the source, or "
        + "invent a number. If the evidence states no figures, say so instead of inventing any.",
    },
    {
      key: "labels", type: "list", required: true, typeRole: "heading",
      maxChars: 81, maxItems: MAX_CARDS, itemMaxChars: 27,
      description:
        "One label per figure, in the same order — what each number measures. Two to four words each. "
        + "Supply exactly as many labels as there are figures.",
    },
    {
      key: "notes", type: "list", required: false, typeRole: "caption",
      maxChars: 180, maxItems: MAX_CARDS, itemMaxChars: 60,
      description:
        "Optional, one per figure in the same order: its source or timeframe. Omit the whole list if "
        + "the evidence does not state them.",
    },
  ],

  /**
   * One band per list. Cards are equal columns of the band — see `cardColumns`.
   * Every required slot has an entry, as the §4 load-time invariant requires.
   */
  defaultZones: [
    { slotKey: "title", x: 8, y: 8, w: 84, h: 24, align: "left", valign: "top" },
    VALUES_BAND,
    LABELS_BAND,
    NOTES_BAND,
  ],

  FallbackRenderer: (args: RenderArgs): ReactNode => {
    const { tokens, zones } = args;
    const cards = pairCards(listOf(args, "values"), listOf(args, "labels"), listOf(args, "notes"));
    const values = cardColumns(bandFor(zones, VALUES_BAND), cards.length);
    const labels = cardColumns(bandFor(zones, LABELS_BAND), cards.length);
    const notes = cardColumns(bandFor(zones, NOTES_BAND), cards.length);

    return (
      <SlideFrame tokens={tokens}>
        {values.map((column, i) => (
          <Panel
            key={`panel-${i}`} color={tokens.colors.surface}
            x={column.x} y={PANEL_Y} w={column.w} h={PANEL_H}
          />
        ))}
        {cards.map((card, i) => (
          <div key={`card-${i}`}>
            <ZoneText zone={values[i]!} text={card.value} style={previewStyleFor(tokens, VALUE_STYLE)} />
            <ZoneText zone={labels[i]!} text={card.label} style={previewStyleFor(tokens, LABEL_STYLE)} />
            <ZoneText zone={notes[i]!} text={card.note} style={previewStyleFor(tokens, NOTE_STYLE)} />
          </div>
        ))}
        {paintPreview(args, TITLE_PAINT)}
      </SlideFrame>
    );
  },

  toPptx(target: PptxTarget, args: RenderArgs): void {
    const { tokens, zones } = args;
    const cards = pairCards(listOf(args, "values"), listOf(args, "labels"), listOf(args, "notes"));
    const values = cardColumns(bandFor(zones, VALUES_BAND), cards.length);
    const labels = cardColumns(bandFor(zones, LABELS_BAND), cards.length);
    const notes = cardColumns(bandFor(zones, NOTES_BAND), cards.length);

    // Panels are painted in BOTH modes — the labels' colour is the AA-checked pairing for `surface`,
    // so the surface has to be there. Same call, same reasoning, as `two_column` and `quote`.
    for (const column of values) {
      panelPptx(target, tokens.colors.surface, column.x, PANEL_Y, column.w, PANEL_H);
    }

    for (const [i, card] of cards.entries()) {
      addZoneText(target, values[i]!, card.value, pptxStyleFor(tokens, VALUE_STYLE));
      if (card.label) addZoneText(target, labels[i]!, card.label, pptxStyleFor(tokens, LABEL_STYLE));
      if (card.note) addZoneText(target, notes[i]!, card.note, pptxStyleFor(tokens, NOTE_STYLE));
    }

    paintPptx(target, args, TITLE_PAINT);
  },
};
