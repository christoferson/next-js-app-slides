"use client";

/**
 * The workspace slide grid, drag-reorderable (SPEC §9, §12's `@dnd-kit` grid).
 *
 * ## The problem this component exists to solve
 *
 * Each card is *both* a click target (select this slide for editing) and a drag handle candidate. Those
 * two conflict: dnd-kit's pointer listeners call `preventDefault` on the events a `<button>` needs to fire
 * a click, so attaching `{...listeners}` to the card would make the whole grid unselectable — the drag
 * would work and nothing else would.
 *
 * The fix here is a **dedicated grip**, not a distance-activated sensor on the whole card. A
 * `PointerSensor` with `activationConstraint: {distance: 6}` does let both gestures coexist, but it makes
 * every click a 6-pixel gamble: a slightly shaky press selects nothing, and on a touchscreen it competes
 * with scrolling. A visible grip says which pixels drag, works identically for mouse and touch, and leaves
 * the card a plain button. The grip is also the keyboard handle (see below), so there is exactly one
 * affordance to learn.
 *
 * ## Reorder is optimistic, then reconciled — and that is a correctness requirement, not polish
 *
 * `onReorder` receives the new id order. The caller sends it to `PUT /slides/order`, which replies with the
 * authoritative list. Between those two moments this component shows the dragged position, because a grid
 * that snapped back for 200ms and then re-sorted reads as a failed drag. But the local order is a *guess*:
 * the route rejects a stale permutation outright (`InvalidSlideOrder`) rather than applying part of it, so
 * a concurrent delete makes our guess wrong. That is why `slides` remains the single source of truth — this
 * component holds no order state of its own, and the caller reloads from the response.
 *
 * ## Accessibility
 *
 * `KeyboardSensor` + `sortableKeyboardCoordinates` gives the grip Space-to-lift, arrows-to-move,
 * Space-to-drop, Escape-to-cancel — the reorder is not mouse-only. `announcements` are supplied because
 * dnd-kit's defaults describe positions ("moved to position 3") without saying what moved, which is
 * useless in a grid of nine near-identical thumbnails.
 */

import { useMemo, useState } from "react";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type Announcements, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";

export interface SlideGridProps<T> {
  /** Server order. The component never mutates or caches this — see the header. */
  items: readonly T[];
  keyOf: (item: T) => string;
  /** The card body. Rendered inside a plain `<button>`; the grip sits outside it. */
  children: (item: T) => ReactNode;
  /** Called with the full permutation of keys. The caller `PUT`s it and reloads from the response. */
  onReorder: (orderedKeys: string[]) => void;
  /** A human label per item, for screen-reader announcements ("Slide 3, bullets"). */
  labelOf: (item: T) => string;
  disabled?: boolean;
}

export function SlideGrid<T>(
  { items, keyOf, children, onReorder, labelOf, disabled }: SlideGridProps<T>,
) {
  /**
   * The permutation shown while a drag is in flight, or `null` when idle.
   *
   * Deliberately null-when-idle rather than "a copy of `items` kept in sync": a mirrored copy needs an
   * effect to follow the server, and that effect is exactly where a stale render survives a reload. Idle
   * renders read `items` directly, so the server's answer always wins the moment the drag ends.
   */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const keys = useMemo(() => items.map(keyOf), [items, keyOf]);

  const ordered = useMemo(() => {
    if (dragOrder === null) return items;
    const byKey = new Map(items.map((item) => [keyOf(item), item]));
    // Filter, don't assert: if the server list changed mid-drag (a concurrent delete), a key in
    // `dragOrder` may no longer exist. Dropping it renders a correct-if-shorter grid instead of crashing.
    return dragOrder.map((key) => byKey.get(key)).filter((item): item is T => item !== undefined);
  }, [dragOrder, items, keyOf]);

  const labelFor = (key: string): string => {
    const item = items.find((i) => keyOf(i) === key);
    return item ? labelOf(item) : key;
  };

  /** Announcements name WHAT moved, not just where — see the header. */
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${labelFor(String(active.id))}.`,
    onDragOver: ({ active, over }) => (over
      ? `${labelFor(String(active.id))} is over ${labelFor(String(over.id))}.`
      : undefined),
    onDragEnd: ({ active, over }) => (over
      ? `Dropped ${labelFor(String(active.id))} at position ${
        (dragOrder ?? keys).indexOf(String(over.id)) + 1
      }.`
      : `Dropped ${labelFor(String(active.id))}. Order unchanged.`),
    onDragCancel: ({ active }) => `Cancelled. ${labelFor(String(active.id))} is back in place.`,
  };

  const onDragStart = (event: DragStartEvent): void => {
    setActiveKey(String(event.active.id));
    setDragOrder(keys);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    setActiveKey(null);

    // Dropped outside, or back where it started: clear the local order so the render falls back to the
    // server's, and do NOT call `onReorder` — a no-op PUT would still cost a request and a reload.
    if (!over || active.id === over.id) {
      setDragOrder(null);
      return;
    }

    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from === -1 || to === -1) {
      setDragOrder(null);
      return;
    }

    const next = arrayMove([...keys], from, to);
    // Held until the caller's reload replaces `items`, so the card stays where it was dropped rather than
    // snapping back for the duration of the request.
    setDragOrder(next);
    onReorder(next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{ announcements }}
      // Keeps a dragged card inside the grid: without it a card can be dragged over the editor panel,
      // which suggests a drop target that does not exist.
      modifiers={[restrictToParentElement]}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => { setActiveKey(null); setDragOrder(null); }}
    >
      {/* `rectSortingStrategy`, not `verticalListSortingStrategy`: this is a two-column wrapping grid, and
          the vertical strategy assumes a single column, so cards would shift along the wrong axis. */}
      <SortableContext items={ordered.map(keyOf)} strategy={rectSortingStrategy}>
        <ul className="grid gap-4 sm:grid-cols-2">
          {ordered.map((item) => {
            const key = keyOf(item);
            return (
              <SortableCard
                key={key}
                id={key}
                label={labelOf(item)}
                dragging={activeKey === key}
                {...(disabled !== undefined ? { disabled } : {})}
              >
                {children(item)}
              </SortableCard>
            );
          })}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

/**
 * One sortable cell: the caller's card, plus the grip that is the only draggable surface.
 *
 * `useSortable`'s `setNodeRef` goes on the `<li>` (it is what dnd-kit measures), while `listeners` and
 * `attributes` go on the grip alone. That split is the whole point — see the file header.
 */
function SortableCard(
  { id, label, dragging, disabled, children }: {
    id: string;
    label: string;
    dragging: boolean;
    disabled?: boolean;
    children: ReactNode;
  },
) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    ...(disabled !== undefined ? { disabled } : {}),
  });

  return (
    <li
      ref={setNodeRef}
      style={{
        // `CSS.Transform.toString` is dnd-kit's own helper rather than a hand-built `translate3d`: it emits
        // the transform WITHOUT scale, which a sorted grid must not apply (a scaled card would overlap its
        // neighbours and change the hit boxes mid-drag).
        transform: CSS.Transform.toString(transform),
        ...(transition !== undefined && transition !== null ? { transition } : {}),
      }}
      className={
        "relative rounded-lg " + (isDragging || dragging ? "z-10 opacity-80 shadow-lg" : "")
      }
    >
      {children}
      <button
        type="button"
        // Two things here are load-bearing rather than cosmetic:
        //  - `touch-none`: without it a touch drag on the grip scrolls the page instead of lifting the
        //    card, because the browser claims the gesture first.
        //  - `[li:hover_&]` reveals the grip on card hover. A `group`/`group-hover` pair would be the
        //    idiomatic spelling, but `group` would have to go on the <li> HERE while the hover target is
        //    also here — and the arbitrary variant says it in one place instead of coupling two classes
        //    across the element. `focus-visible:opacity-100` is the keyboard equivalent, so the grip is
        //    reachable without a pointer; it must stay paired with the hover rule or a Tab-only user
        //    cannot see the handle they just focused.
        className="absolute right-2 top-2 inline-flex size-7 touch-none items-center justify-center rounded-md border border-line bg-surface text-ink-soft opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 [li:hover_&]:opacity-100 disabled:pointer-events-none"
        aria-label={`Reorder ${label}. Press space or enter to lift, then use the arrow keys.`}
        disabled={disabled === true}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden className="size-4" />
      </button>
    </li>
  );
}
