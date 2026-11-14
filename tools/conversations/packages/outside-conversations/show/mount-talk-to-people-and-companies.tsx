import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { TalkToPeopleAndCompaniesPanel } from './TalkToPeopleAndCompaniesPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function TalkToPeopleAndCompaniesMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="outside-conversations material">
        <TalkToPeopleAndCompaniesPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <TalkToPeopleAndCompaniesMaterial props={props} />);
}
