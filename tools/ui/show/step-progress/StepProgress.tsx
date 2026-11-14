// packages/ui/show/step-progress/StepProgress.tsx
//
// The React mount seam over the blind style registry: resolve the renderer for
// `style` (an open DATA string) and mount it with the universal ProgressState.
// Never branches on style — counter/dots/bar/segmented and any future visual are
// registrations, not code branches.

import { createElement, type ComponentType, type ReactElement } from 'react';
import type { ProgressState, StepProgressRegistry } from './step-progress';

/** Props every progress visual receives — the universal projection. */
export interface StepProgressProps {
  readonly state: ProgressState;
}

/** A React progress visual (counter/dots/bar/segmented/…). */
export type StepProgressComponent = ComponentType<StepProgressProps>;

/** Mount the visual registered for `style` (or the fallback) with the progress state. */
export function StepProgress(props: {
  readonly registry: StepProgressRegistry<StepProgressComponent>;
  readonly style: string;
  readonly state: ProgressState;
}): ReactElement {
  const Visual = props.registry.resolve(props.style);
  return createElement(Visual, { state: props.state });
}
