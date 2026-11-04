/** Intrinsic bounds inside a positioned layout owner, independent of scroll and transforms. */
export function layoutBoundsWithin(element: HTMLElement, owner: HTMLElement) {
  let x = 0;
  let y = 0;
  let width = element.offsetWidth;
  let height = element.offsetHeight;
  let current: HTMLElement | null = element;
  while (current && current !== owner) {
    // The arrangement's explicit camera zoom is real presentation geometry;
    // transient Motion transforms on individual panes are not intrinsic size.
    if (current.hasAttribute('data-arrangement-camera')) {
      const scale = Number(current.style.transform.match(/^scale\(([^)]+)\)$/)?.[1]);
      if (Number.isFinite(scale) && scale > 0) {
        x *= scale; y *= scale; width *= scale; height *= scale;
      }
    }
    x += current.offsetLeft;
    y += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  // Hidden content and content positioned outside this owner have no local extent.
  return current === owner ? { x, y, width, height } : null;
}
