import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { readPublishedRecords } from '@/packages/ui/show/placeable-surface-intent/placeable-surface-record';
import { readInstructionBlocks } from '../read-data/read-ai-instruction-blocks';
import { InstructionBlockList } from './InstructionBlockList';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function InstructionBlockMaterial({ props }: { props: Record<string, unknown> }) {
  const source = useBitfieldData('instruction-blocks');
  const items = React.useMemo(() => readInstructionBlocks(readPublishedRecords(source)), [source]);
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Trillion working method">
        <InstructionBlockList items={items} title="How Trillion should work" />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <InstructionBlockMaterial props={props} />);
}
