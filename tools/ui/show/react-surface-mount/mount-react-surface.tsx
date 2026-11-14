import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

const REACT_SURFACE_MOUNT = Symbol.for('architect.commandCenter.reactSurfaceMount');

export type ReactSurfaceUnmount = (() => void) & { render?: (node: React.ReactNode) => void };

type ReactSurfaceMountRecord = {
  root: Root;
};

type ReactSurfaceMountElement = HTMLElement & {
  [REACT_SURFACE_MOUNT]?: ReactSurfaceMountRecord;
};

export function mountReactSurface(target: HTMLElement, node: React.ReactNode): ReactSurfaceUnmount {
  const element = target as ReactSurfaceMountElement;
  const previous = element[REACT_SURFACE_MOUNT];

  if (previous) {
    previous.root.unmount();
    delete element[REACT_SURFACE_MOUNT];
    target.replaceChildren();
  }

  // The screen draws into a box of its own that lays out as if it were not there: whoever hosts the screen may
  // empty the host as soon as it lets go (cleanupSourceBytesScreenMount does), and the screen's own nodes stay in
  // its box until React has taken them down.
  const own = document.createElement('div');
  own.style.display = 'contents';
  target.append(own);
  const root = createRoot(own);
  const record: ReactSurfaceMountRecord = { root };
  element[REACT_SURFACE_MOUNT] = record;
  root.render(node);

  const unmount: ReactSurfaceUnmount = () => {
    if (element[REACT_SURFACE_MOUNT] !== record) return;
    delete element[REACT_SURFACE_MOUNT];
    // A screen is often let go while the arrangement holding it is itself drawing (closing a window draws the next
    // arrangement), when React cannot take a root down; it goes as soon as that drawing is done.
    queueMicrotask(() => root.unmount());
  };
  unmount.render = node => {
    if (element[REACT_SURFACE_MOUNT] !== record) return;
    root.render(node);
  };
  return unmount;
}
