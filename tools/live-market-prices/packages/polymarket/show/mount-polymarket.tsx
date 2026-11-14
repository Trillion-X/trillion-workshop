import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { PolymarketPanel } from '@/packages/polymarket/show/PolymarketPanel';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function PolymarketMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="polymarket material">
        <PolymarketPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <PolymarketMaterial props={props} />);
}
