import type { CSSProperties } from 'react';

/** Embedded panels share their owner's surface until they open over content. */
export function dockablePanelSurfaceStyle(overContent: boolean): CSSProperties {
  return {
    background: overContent ? 'var(--bg-surface, #111111)' : 'transparent',
    backdropFilter: 'none',
    borderColor: 'var(--border-secondary, rgba(255, 255, 255, 0.06))',
  };
}
