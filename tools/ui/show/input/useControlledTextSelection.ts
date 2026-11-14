import React from 'react';

export type ControlledTextSelection = readonly [number, number];

function clampSelectionOffset(offset: number, sourceLength: number): number {
  return Math.max(0, Math.min(sourceLength, offset));
}

/**
 * Restores one controlled UTF-16 selection, optionally making the control the
 * authoritative focus owner. Callers use the imperative focus form only for
 * explicit continuity transitions such as returning from point-compose.
 */
export function restoreControlledTextSelection<
  Element extends HTMLInputElement | HTMLTextAreaElement,
>(
  control: Element,
  source: string,
  selection: ControlledTextSelection,
  focus = false,
): void {
  const start = clampSelectionOffset(selection[0], source.length);
  const end = clampSelectionOffset(selection[1], source.length);
  if (focus) control.focus({ preventScroll: true });
  if (control.selectionStart !== start || control.selectionEnd !== end) {
    control.setSelectionRange(start, end);
  }
}

/**
 * Applies one controlled UTF-16 selection to every mounted text control that
 * presents the same draft. Selection is a property, not independent DOM
 * truth, so inactive mirrors are synchronized without stealing focus or
 * emitting input/select events.
 */
export function useControlledTextSelection<
  Element extends HTMLInputElement | HTMLTextAreaElement,
>(
  source: string,
  selection: ControlledTextSelection,
): React.RefObject<Element | null> {
  const ref = React.useRef<Element | null>(null);
  React.useLayoutEffect(() => {
    const control = ref.current;
    if (!control) return;
    restoreControlledTextSelection(control, source, selection);
  }, [selection, source]);
  return ref;
}
