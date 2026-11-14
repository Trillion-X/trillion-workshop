// packages/ui/show/scrollable-surface/ScrollViewport.tsx
//
// PURPOSE
//   A bounded scroll container whose edges fade while content runs past
//   them. Measurement is the shared scroll-fade watcher; appearance is
//   screen-look/show/scroll-edge-style.ts. No fade obscures the last item.
//
// NON-NEGOTIABLE INVARIANTS
//   1. `edges` (DATA) picks which edges may fade; `axis` is shorthand for the
//      two edges of one scroll direction.
//   2. Scrolling never re-renders this component.
//   3. A horizontal viewport turns a vertical wheel into sideways scrolling.

import * as React from 'react';
import { useScrollFade, type ScrollFadeEdge } from './scroll-fade';

const AXIS_EDGES: Record<'vertical' | 'horizontal', readonly ScrollFadeEdge[]> = {
  vertical: ['top', 'bottom'],
  horizontal: ['left', 'right'],
};

export function ScrollViewport({ children, axis = 'vertical', edges, className = '', contentClassName, ...props }: React.HTMLAttributes<HTMLDivElement> & { axis?: 'vertical' | 'horizontal'; edges?: readonly ScrollFadeEdge[]; contentClassName?: string }) {
  const [viewport, setViewport] = React.useState<HTMLDivElement | null>(null);
  useScrollFade(viewport, edges ?? AXIS_EDGES[axis]);
  // A sideways viewport also scrolls under a mouse wheel, so its last row is reachable without a trackpad.
  React.useEffect(() => {
    if (!viewport || axis !== 'horizontal') return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || viewport.scrollWidth <= viewport.clientWidth) return;
      event.preventDefault();
      viewport.scrollLeft += event.deltaY;
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [viewport, axis]);
  return (
    <div {...props} ref={setViewport} tabIndex={props.tabIndex ?? 0} className={`bf-scroll-viewport ${className}`} data-axis={axis}>
      <div className={contentClassName} style={axis === 'horizontal' ? { display: 'flex', minWidth: 'max-content', height: '100%' } : undefined}>{children}</div>
    </div>
  );
}
