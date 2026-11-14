// bitfield/packages/ui/show/container-size/ContainerSizeRegion.tsx
//
// PURPOSE
// The region a layout owner (screen-arrangement panes, docks, dialogs) wraps
// around whatever surface it hosts. It is the named `surface` size container and
// carries `data-container-size`, so every surface inside adapts to the region's
// width with no per-surface wiring.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Pure layout wrapper: it adds no chrome, padding or scroll of its own
//    beyond what the caller passes in className.
// 2. The size class comes from bindContainerSize, the one measurement owner.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import React from 'react';
import {bindContainerSize, SURFACE_CONTAINER_STYLE, type ContainerSizeClass} from './container-size';

export interface ContainerSizeRegionProps extends React.HTMLAttributes<HTMLDivElement> {
  classes?: readonly ContainerSizeClass[];
}

export function ContainerSizeRegion({classes, style, children, ...props}: ContainerSizeRegionProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => (ref.current ? bindContainerSize(ref.current, {classes}) : undefined), [classes]);
  return <div ref={ref} data-surface-container="" style={{...SURFACE_CONTAINER_STYLE, ...style}} {...props}>{children}</div>;
}
