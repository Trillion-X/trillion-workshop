import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { readPublishedRecords } from '@/packages/ui/show/placeable-surface-intent/placeable-surface-record';
import { readMemoryContext } from '../read-data/read-memory-context';
import { AiMemoryPanel } from './AiMemoryPanel';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function readSubjectRef(props: Record<string, unknown>): string | undefined {
  const input = (props.surfaceInput ?? props.surface_input) as Record<string, unknown> | undefined;
  const value = input?.subjectRef ?? input?.subject_ref;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function AiMemoryMaterial({ props }: { props: Record<string, unknown> }) {
  const context = useBitfieldData('memory-context');
  const records = useBitfieldData('memory-records');
  const subjectRef = readSubjectRef(props);
  const items = React.useMemo(
    () => readMemoryContext([...readPublishedRecords(context), ...readPublishedRecords(records)], subjectRef),
    [context, records, subjectRef],
  );
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Trillion memory">
        <AiMemoryPanel items={items} title="What Trillion remembers" />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <AiMemoryMaterial props={props} />);
}
