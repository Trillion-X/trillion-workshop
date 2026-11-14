// parts/ui/show/nesting-guide/NestingGuide.tsx
// NO PRIOR: searched bitfield-packages/packages (indent-guide, nesting-guide, tree-guide, guide-line); searched
//   design-systems (shadcn SidebarMenuSub draws a 1px border-l, coss and kibo trees); searched 21st.dev
//   ("sidebar nested list indent guide line tree": #29954 Tree Nav's tree-style rail, #25276 Branching Tree Nav's SVG
//   branch lines, #4317 originui tree with vertical lines). None is a shared guide both a list and a tree can draw.
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The guide beside the rows of an open list: a soft pill down their side that says
// "these belong to the heading above". A user note: the line next to
// each open list was too thin, should be thicker with rounded ends like a pill, and the
// tips of one list's line and the next one's sat so close they read as one line.
//
// One guide is drawn as one pill (`start` and `end` both on): a sidebar list's rows. A
// tree draws its guides a row at a time, so a pill there is the run of segments from the
// first row under a folder (`start`) to the last row of that folder's open subtree
// (`end`); the segments between join into one line.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Structure only: no colour, width, inset or radius is written here. The look
//    (parts/screen-look/show/nesting-guide.css) draws it from --nesting-guide-* tokens.
// 2. Decorative: aria-hidden, takes no pointer input, never a control.
// 3. Placed by its parent: the parent is positioned and sets --nesting-guide-left (and,
//    for a tree, --nesting-guide-step per level); the guide reads its `level` from
//    --guide-level.
// 4. A guide's ends are inset (--nesting-guide-inset), so the pills of two lists one
//    after the other never touch.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type * as React from 'react';

export interface NestingGuideProps {
  /** How many levels in from the parent's first guide (a tree's depth); 0 for a list. */
  level?: number;
  /** This guide starts here: its top end is rounded and inset. */
  start?: boolean;
  /** This guide ends here: its bottom end is rounded and inset. */
  end?: boolean;
}

export function NestingGuide({ level = 0, start = true, end = true }: NestingGuideProps) {
  return (
    <span
      aria-hidden="true"
      className="nesting-guide"
      data-nesting-guide-start={start ? '' : undefined}
      data-nesting-guide-end={end ? '' : undefined}
      style={{ '--guide-level': level } as React.CSSProperties}
    />
  );
}
