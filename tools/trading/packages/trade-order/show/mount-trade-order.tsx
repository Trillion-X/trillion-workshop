import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { TradeOrderPanel } from '@/packages/trade-order/show/TradeOrderPanel';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function TradeOrderMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="trade-order material">
        <TradeOrderPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <TradeOrderMaterial props={props} />);
}
