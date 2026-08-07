"use client";

/**
 * `useResource` — the one way a screen loads server state.
 *
 * ## Why this exists rather than a `load()` per page
 *
 * Every screen needs the same four things: fetch on mount, expose the data, expose an `ApiError` for
 * `ErrorNote`, and expose a reload for its Retry button. Written per page that is four copies of a fetch
 * effect, and all four had the same latent bug: nothing cancels a response that arrives after the component
 * moved on, so a slow first request can overwrite the result of a fast second one. The `live` flag below is
 * the fix, in one place.
 *
 * It also satisfies `react-hooks/set-state-in-effect` honestly. The rule objects to state set *synchronously*
 * during an effect, because that cascades renders; state set after an `await`, guarded by a liveness check,
 * is exactly the "subscribe to an external system and call setState in a callback" shape the rule documents
 * as intended. Note that wrapping a `setState`-calling callback in an async IIFE also silences the rule — that
 * would have been silencing rather than fixing, which is why the awaited value is assigned here instead.
 *
 * ## Contract for callers
 *
 * `fetcher` MUST be stable — wrap it in `useCallback`. An inline arrow changes identity on every render and
 * would refetch in a loop. The dependency array below deliberately includes it rather than omitting it: a
 * fetcher that closes over a changing id (a deck id, say) *should* refetch when that id changes.
 *
 * A non-`ApiError` throw is re-thrown from the effect rather than stored: `ApiError` is the only failure the
 * UI knows how to render, and swallowing a programming error into an error banner hides bugs.
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/client/api";

export interface Resource<T> {
  /** `undefined` until the first response arrives — the loading state. */
  data: T | undefined;
  error: ApiError | undefined;
  /** Refetch. Safe to call from an event handler; the in-flight response is discarded. */
  reload: () => void;
  /**
   * Local override, for the optimistic paths (a slide's slots while typing, a row removed after DELETE).
   * A mutation that could change anything derived — tokens, zones, the layout set — should `reload` instead.
   */
  set: (next: T | undefined) => void;
}

export function useResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  // A counter rather than a boolean: `reload` must re-run the effect even if it is called twice with no
  // render in between, and incrementing always produces a new dependency value.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await fetcher();
        if (!live) return;
        setData(next);
        setError(undefined);
      } catch (cause) {
        if (!live) return;
        if (cause instanceof ApiError) setError(cause);
        else throw cause;
      }
    })();
    return () => { live = false; };
  }, [fetcher, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, reload, set: setData };
}
