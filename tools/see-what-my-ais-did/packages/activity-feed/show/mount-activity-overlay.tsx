/**
 * mount-activity-overlay.tsx
 *
 * L069 GENERATIVE PRIMITIVE: Live activity indicator overlay for any surface.
 * Subscribes to a scoped activity-fact feed and renders ephemeral actor badges.
 *
 * Following mount-live-feed-board.tsx pattern (line 39+):
 * - This entry reads its owner-defined default input exactly once
 * - ActivityIndicator receives decoded activity records, never an input selector
 *
 * L090 DATA-DRIVEN: All styling (colors, icons, durations) comes from data, not code.
 * No hardcoded actor types — actor_type field self-describes the presentation.
 */

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ActivityIndicator, type ActivityFactRecord } from '@/packages/activity-feed/show/ActivityIndicator';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

export function fillFrame(input: unknown): Record<string, unknown> {
  const frame = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const placed = frame.mode === 'fixed' || typeof frame.top_px === 'number' || typeof frame.left_px === 'number';
  return placed ? frame : { ...frame, mode: 'fill' };
}

/**
 * FeedSubscriber — Subscribe to the activity-fact feed and render indicators.
 * Mirrors FeedReconciler pattern from mount-live-feed-board.tsx (line 81-113).
 */
function FeedSubscriber({
  packageId,
}: {
  packageId?: string;
}): React.ReactElement {
  const activity = useBitfieldData() as ActivityFactRecord[] | undefined;
  return (
    <ActivityIndicator
      activity={activity}
      packageId={packageId}
      maxVisible={3}
      position="top-right"
    />
  );
}

function ActivityOverlayMaterial({ props }: { props: Record<string, unknown> }) {
  const packageId = typeof props.package_id === 'string' ? props.package_id : undefined;

  return (
    <FloatingMaterialFrame frame={fillFrame(props.floating_frame)}>
      <ErrorBoundary zoneName="activity-overlay material">
        <FeedSubscriber
          packageId={packageId}
        />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ActivityOverlayMaterial props={props} />);
}
