import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { readPublishedRecords } from '@/packages/ui/show/placeable-surface-intent/placeable-surface-record';
import { readActionGuards } from '../read-data/read-ai-action-guards';
import { ActionGuardPanel } from './ActionGuardPanel';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function ActionGuardMaterial({ props }: { props: Record<string, unknown> }) {
  const limits = useBitfieldData('guard-limits');
  const states = useBitfieldData('guard-states');
  const decisions = useBitfieldData('guard-decisions');
  const data = React.useMemo(
    () => readActionGuards([...readPublishedRecords(limits), ...readPublishedRecords(states), ...readPublishedRecords(decisions)]),
    [limits, states, decisions],
  );
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Trillion action boundaries">
        <ActionGuardPanel data={data} title="What Trillion can do without asking" />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ActionGuardMaterial props={props} />);
}
