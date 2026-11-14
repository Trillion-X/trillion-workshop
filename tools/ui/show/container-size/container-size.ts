// bitfield/packages/ui/show/container-size/container-size.ts
//
// PURPOSE
// One shared way for any surface to adapt to the width of the container it is
// placed in, never to the width of the window. A pane that is 300px wide in a
// 1600px window is a phone-sized surface, and viewport media queries cannot see
// that. Two halves, one vocabulary:
//   1. CSS: a region declares itself a named size container ("surface"), so any
//      stylesheet inside it (including inside a shadow root, which container
//      lookup crosses) writes `@container surface (max-width: 600px)`.
//   2. JS: `bindContainerSize` measures one element and writes the size class
//      to `data-container-size`, for structural changes CSS cannot make (for
//      example, a calendar swapping its week grid for a month picker).
//
// NON-NEGOTIABLE INVARIANTS
// 1. Size classes are DATA (ordered `{id, below_px}` rows, last row open-ended).
//    Callers may pass their own rows; nothing here branches on a class name.
// 2. The class is derived from the element's own content-box width only.
// 3. onChange fires only when the class changes, never on every resize.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

export interface ContainerSizeClass {
  /** Name written to data-container-size. */
  id: string;
  /** Upper bound (exclusive) in CSS px. Omitted on the last, open-ended row. */
  below_px?: number;
}

/** Default classes. Bounds sit where composite surfaces measurably break. */
export const DEFAULT_CONTAINER_SIZE_CLASSES: readonly ContainerSizeClass[] = [
  {id: 'compact', below_px: 600},
  {id: 'medium', below_px: 900},
  {id: 'wide'},
];

/** The container name every surface region declares, for `@container surface (...)`. */
export const SURFACE_CONTAINER_NAME = 'surface';

/** Inline style that makes an element the named surface size container. */
export const SURFACE_CONTAINER_STYLE = {containerType: 'inline-size', containerName: SURFACE_CONTAINER_NAME} as const;

/** The first class whose bound exceeds `width`; the open-ended row otherwise. */
export function containerSizeClass(width: number, classes: readonly ContainerSizeClass[] = DEFAULT_CONTAINER_SIZE_CLASSES): string {
  for (const row of classes) if (row.below_px === undefined || width < row.below_px) return row.id;
  return classes[classes.length - 1]?.id ?? '';
}

export interface BindContainerSizeOptions {
  classes?: readonly ContainerSizeClass[];
  /** Called with the new class (and measured width) whenever the class changes. */
  onChange?: (sizeClass: string, width: number) => void;
}

/**
 * Measure `element`, keep `data-container-size` current, and report class
 * changes. Returns a disposer. An element not yet laid out (width 0) keeps no
 * class until it has a real width, so a hidden surface is never misclassified.
 */
export function bindContainerSize(element: HTMLElement, {classes = DEFAULT_CONTAINER_SIZE_CLASSES, onChange}: BindContainerSizeOptions = {}): () => void {
  let current = '';
  const apply = (width: number) => {
    if (!(width > 0)) return;
    const next = containerSizeClass(width, classes);
    if (next === current) return;
    current = next;
    element.dataset.containerSize = next;
    onChange?.(next, width);
  };
  apply(element.getBoundingClientRect().width);
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(entries => apply(entries[entries.length - 1]?.contentRect.width ?? 0));
  observer.observe(element);
  return () => observer.disconnect();
}
