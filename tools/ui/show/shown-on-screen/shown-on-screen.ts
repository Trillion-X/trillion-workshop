// parts/ui/show/shown-on-screen/shown-on-screen.ts
//
// PURPOSE
//   Whether a person can see an element right now (it is in the page, has a size, is not hidden, and its tab is
//   showing), and a watcher that says when that settles either way. A screen that should do something only once the
//   person is actually looking at it (start its tour, count its new things as seen) asks here, so every such screen
//   judges "shown" the same way.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One predicate for "shown", used by every watcher.
//   2. Shown settles only after the element has stayed shown for `settleMs`, so a tab flashed for a moment while the
//      page restores its layout never counts; hidden is said at once.
//   3. A browser without ResizeObserver counts the element as shown once, and is never watched.

/** The element is in the page, has a size, is not hidden and the page's tab is showing. */
export function isShownOnScreen(element: HTMLElement): boolean {
  if (!element.isConnected || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return false;
  const rect = element.getBoundingClientRect();
  const visible = typeof element.checkVisibility === 'function' ? element.checkVisibility({ visibilityProperty: true }) : true;
  return rect.width > 0 && rect.height > 0 && visible;
}

/**
 * Calls `onChange(true)` each time `element` has stayed shown for `settleMs`, and `onChange(false)` when it stops being
 * shown after that. Returns the call that stops watching.
 */
export function watchShownOnScreen(element: HTMLElement, onChange: (shown: boolean) => void, settleMs = 800): () => void {
  if (typeof ResizeObserver !== 'function') {
    onChange(true);
    return () => {};
  }
  let settling: ReturnType<typeof setTimeout> | undefined;
  let said = false;
  const check = () => {
    if (settling !== undefined) clearTimeout(settling);
    settling = undefined;
    if (!isShownOnScreen(element)) {
      if (said) { said = false; onChange(false); }
      return;
    }
    settling = setTimeout(() => {
      settling = undefined;
      if (isShownOnScreen(element) && !said) { said = true; onChange(true); }
    }, settleMs);
  };
  const observer = new ResizeObserver(check);
  observer.observe(element);
  document.addEventListener('visibilitychange', check);
  return () => {
    if (settling !== undefined) clearTimeout(settling);
    observer.disconnect();
    document.removeEventListener('visibilitychange', check);
  };
}
