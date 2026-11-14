/**
 * mount-activity-feed.tsx
 *
 * L069 Generative Primitive: Activity feed mount using scoped-recent-activity feed.
 * Follows mount-live-feed-board.tsx live-feed subscription pattern.
 * L090 DATA-driven: all styling via ActivityIndicator (no hardcoded actor types).
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
 * FeedSubscriber — Subscribe to scoped-recent-activity feed and render indicators.
 * Mirrors FeedReconciler pattern from mount-live-feed-board.tsx.
 */
function FeedSubscriber(): React.ReactElement {
  const activity = useBitfieldData() as ActivityFactRecord[] | undefined;
  return (
    <ActivityIndicator
      activity={activity}
      maxVisible={10}
      position="top-left"
    />
  );
}

function ActivityFeedMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={fillFrame(props.floating_frame)}>
      <ErrorBoundary zoneName="activity-feed material">
        <FeedSubscriber />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ActivityFeedMaterial props={props} />);
}
