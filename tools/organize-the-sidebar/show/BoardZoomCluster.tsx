// packages/group/show/BoardZoomCluster.tsx
// The compact header zoom cluster: [bare track] then one shared icon toolbar
// [-] [reset, badge %] [+] [fit] (+ Present / carousel when frames exist); each item shows
// its name when pointed at.

import React from 'react';
import { Container, ExpandableTabs } from '../../ui/index.ts';
import { RangeInput } from '../../ui/show/range-input';

export interface BoardZoomClusterProps {
  zoom: number;
  minZoom: number;
  maxZoom: number;
  onStepZoom: (dir: 1 | -1) => void;
  onSetZoom: (z: number) => void;
  onResetZoom: () => void;
  onZoomToFit: () => void;
  /** Present is only offered when the board has frames (L118: no dead affordance). */
  showPresent: boolean;
  onPresent: () => void;
  onCarousel: () => void;
}

export function BoardZoomCluster({
  zoom,
  minZoom,
  maxZoom,
  onStepZoom,
  onSetZoom,
  onResetZoom,
  onZoomToFit,
  showPresent,
  onPresent,
  onCarousel,
}: BoardZoomClusterProps) {
  return (
    <Container layout="horizontal" gap="xs" alignItems="center">
      {/* The track is for a pointer; on a phone the buttons and a pinch zoom, and the track would take a row of its own.
          In a narrow pane's canvas dock (screen-look canvas-dock.css) it stays out too. */}
      <Container className="hidden md:flex" data-canvas-toolbar-only>
        <RangeInput
          value={zoom}
          min={minZoom}
          max={maxZoom}
          step={0.05}
          width={120}
          onValueChange={onSetZoom}
          aria-label="Zoom level"
        />
      </Container>
      <ExpandableTabs
        mode="action"
        size="sm"
        ariaLabel="Zoom"
        items={[
          { id: 'out', label: 'Zoom out', icon: 'Minus' },
          { id: 'reset', label: 'Reset zoom to 100%', icon: 'RotateCcw', badge: `${Math.round(zoom * 100)}%` },
          { id: 'in', label: 'Zoom in', icon: 'Plus' },
          { id: 'fit', label: 'Zoom to fit', icon: 'Scan' },
          ...(showPresent ? [{ id: 'present', label: 'Present frames', icon: 'Presentation' }] : []),
          ...(showPresent ? [{ id: 'carousel', label: 'View frames as carousel', icon: 'Images' }] : []),
        ]}
        onSelect={(id) => {
          if (id === 'out') onStepZoom(-1);
          else if (id === 'in') onStepZoom(1);
          else if (id === 'reset') onResetZoom();
          else if (id === 'fit') onZoomToFit();
          else if (id === 'present') onPresent();
          else if (id === 'carousel') onCarousel();
        }}
      />
    </Container>
  );
}
