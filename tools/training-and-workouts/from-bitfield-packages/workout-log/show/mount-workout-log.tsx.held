import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { useBitfieldData } from '@/packages/workout-log/.bitfield-entry-scope/workout-log/runtime-kit-react';
import { decodeWorkoutLog } from '@/packages/workout-log/read-data/workout-log';
import { WorkoutLogPanel } from '@/packages/workout-log/show/WorkoutLogPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function WorkoutLogMaterial({ props }: { props: Record<string, unknown> }) {
  const rawLog = useBitfieldData<unknown>('surface-state');
  const log = decodeWorkoutLog(rawLog);
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="workout log material">
        <WorkoutLogPanel log={log} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <WorkoutLogMaterial props={props} />);
}
