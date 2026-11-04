// parts/screen-arrangement/show/container-selection-look.ts
//
// PURPOSE
//   The one look of the focused (selected) container and of a container being dragged, the same in every layout
//   geometry: tiles (SplitTreeArranger) and the free canvas (FreeformArranger) both draw it from here, so selection
//   reads the same wherever the person arranges screens and follows the screen look's focus token.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Colours come only from the screen look's tokens (--border-focus); no fixed colour.
//   2. Class names stay whole literals so the stylesheet build finds them.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The focused container's border. */
export const FOCUSED_CONTAINER_BORDER = '!border-[var(--border-focus)]'

/** A container while it is being dragged. */
export const DRAGGING_CONTAINER_BORDER = 'cursor-grabbing !border-[var(--border-focus)]'
