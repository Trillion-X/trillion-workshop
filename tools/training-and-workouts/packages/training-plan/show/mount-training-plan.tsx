import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { useBitfieldData } from '@/packages/training-plan/.bitfield-entry-scope/training-plan/runtime-kit-react';
import { decodeTrainingPlan } from '@/packages/training-plan/read-data/training-plan';
import { selectAdaptiveNextSession } from '@/packages/training-plan/read-data/select-adaptive-next-session';
import { TrainingPlanPanel } from '@/packages/training-plan/show/TrainingPlanPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function TrainingPlanMaterial({ props }: { props: Record<string, unknown> }) {
  const rawPlan = useBitfieldData<unknown>('surface-state');
  const plan = decodeTrainingPlan(rawPlan);
  const adapted = selectAdaptiveNextSession(rawPlan);
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="training plan material">
        <TrainingPlanPanel plan={plan} adapted={adapted} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <TrainingPlanMaterial props={props} />);
}
