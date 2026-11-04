import * as React from 'react';
export const SCREEN_ARRANGEMENT_FOCUS_REQUEST = 'screen-arrangement-focus-request';

/** Give a live task the existing full-pane view when its split pane is too short to use. */
export function useFocusContainerWhile(active: boolean, element: React.RefObject<HTMLElement | null>, minimumHeight: number): void {
  React.useEffect(() => {
    if (!active) return;
    const pane = element.current?.closest<HTMLElement>('[data-container-id]');
    const containerId = pane?.dataset.containerId;
    if (!pane || !containerId || pane.getBoundingClientRect().height >= minimumHeight) return;

    let cancelled = false;
    let requested = false;
    queueMicrotask(() => {
      if (cancelled) return;
      requested = true;
      pane.dispatchEvent(new CustomEvent(SCREEN_ARRANGEMENT_FOCUS_REQUEST, { bubbles: true, detail: { active: true } }));
    });
    return () => {
      cancelled = true;
      if (requested) pane.dispatchEvent(new CustomEvent(SCREEN_ARRANGEMENT_FOCUS_REQUEST, { bubbles: true, detail: { active: false } }));
    };
  }, [active, element, minimumHeight]);
}
