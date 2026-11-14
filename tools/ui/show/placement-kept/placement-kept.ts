// parts/ui/show/placement-kept/placement-kept.ts
//
// PURPOSE
//   What a screen keeps about itself in the place it is put: the selection, grouping, view and depth a person chose
//   there (a pane, a piece inside an arranged screen, a tab of the menu bar panel). It is kept as DATA in the
//   placement's own input under `kept`, so the arrangement saves it with the placement on every device, an AI writes it
//   the same way it writes any placement (save_layout), and two placements of one screen each keep their own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One key: a placement's input carries what its screen kept at `kept`; nothing else of the input changes.
//   2. A screen keeps by announcing from inside its own element (`keepInPlacement`); whoever holds the placement (the
//      arrangement's pane, parts/screen-arrangement ContainerHost) writes it. A screen never writes a placement itself.
//   3. What a screen kept never remounts it (it already shows it); a `kept` changed by anyone else does
//      (parts/ui/show/source-bytes-screen-mount), so an AI's change shows at once.

/** The key a placement's input keeps its screen's own choices under. */
export const KEPT_KEY = 'kept';
/** The event a screen announces a new `kept` with, from inside its element; it bubbles to whoever holds the placement. */
export const KEEP_EVENT = 'trillion:placement-keep';

export type Kept = Record<string, unknown>;

/** What the placement whose input this is kept, or an empty object. */
export function keptIn(input: Record<string, unknown> | undefined): Kept {
  const kept = input?.[KEPT_KEY];
  return kept && typeof kept === 'object' && !Array.isArray(kept) ? (kept as Kept) : {};
}

/** Keeps `kept` in the placement `element` is inside (the whole of it: what is left out is forgotten). */
export function keepInPlacement(element: Element, kept: Kept): void {
  element.dispatchEvent(new CustomEvent(KEEP_EVENT, { bubbles: true, detail: { kept } }));
}

/** Hears what screens inside `host` keep; returns what stops hearing. */
export function hearKept(host: Element, heard: (kept: Kept) => void): () => void {
  const listener = (event: Event) => {
    const kept = (event as CustomEvent<{ kept?: unknown }>).detail?.kept;
    if (kept && typeof kept === 'object' && !Array.isArray(kept)) heard(kept as Kept);
  };
  host.addEventListener(KEEP_EVENT, listener);
  return () => host.removeEventListener(KEEP_EVENT, listener);
}
