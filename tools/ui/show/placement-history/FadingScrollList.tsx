import * as React from 'react';
import { PLACEMENT_HISTORY_STYLE } from '../../../screen-look/show/placement-history-style';

/**
 * Domain-blind vertical list that scrolls past `maxHeight` and fades its top
 * and bottom edges (the sidebar's edge fade), so a long history never grows
 * the surface holding it.
 */
export function FadingScrollList({ children, maxHeight = '10rem', className, ...rest }: {
  children: React.ReactNode;
  maxHeight?: string;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return <>
    <style>{PLACEMENT_HISTORY_STYLE}</style>
    <div
      {...rest}
      className={['bf-placement-history-list flex flex-col gap-1 overflow-y-auto py-1', className].filter(Boolean).join(' ')}
      style={{ maxHeight }}
    >
      {children}
    </div>
  </>;
}
