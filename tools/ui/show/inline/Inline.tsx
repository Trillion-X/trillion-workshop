// packages/ui/show/inline/Inline.tsx
//
// A horizontal cluster — the row counterpart to a vertical Stack. Children lay
// out in a flex row with a chosen gap and cross-axis alignment. Pure layout L2
// atom: no domain knowledge, no colors, no borders. Lets feature code compose a
// row (e.g. nav arrows + a tab strip) without hand-rolling `<div className=flex>`
// (L065/L066). `grow` makes the cluster fill remaining space and clamps min-width
// so an overflowing child (a scroll strip) shrinks instead of pushing siblings.

import * as React from 'react';
import { cn } from '../cn';

const GAP_CLASS = {
  none: 'gap-0',
  xs: 'gap-1',
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-4',
} as const;

const ALIGN_CLASS = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
  baseline: 'items-baseline',
} as const;

const JUSTIFY_CLASS = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
} as const;

export interface InlineProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly gap?: keyof typeof GAP_CLASS;
  readonly align?: keyof typeof ALIGN_CLASS;
  readonly justify?: keyof typeof JUSTIFY_CLASS;
  /** Fill remaining space and clamp min-width (so a scroll child can shrink). */
  readonly grow?: boolean;
}

/** A horizontal flex cluster — the row sibling of Stack. */
export const Inline = React.forwardRef<HTMLDivElement, InlineProps>(function Inline(
  { gap = 'sm', align = 'center', justify, grow, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex',
        GAP_CLASS[gap],
        ALIGN_CLASS[align],
        justify ? JUSTIFY_CLASS[justify] : undefined,
        grow ? 'flex-1 min-w-0' : undefined,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});
