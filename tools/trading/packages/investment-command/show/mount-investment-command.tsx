import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { InvestmentCommandPanel } from '@/packages/investment-command/show/InvestmentCommandPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function readSurfaceInput(props: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = props.surfaceInput;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function InvestmentCommandMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="investment-command material">
        <InvestmentCommandPanel surfaceInput={readSurfaceInput(props)} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <InvestmentCommandMaterial props={props} />);
}
