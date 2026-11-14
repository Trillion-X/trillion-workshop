import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { TradeAuditPanel } from '@/packages/trade-audit/show/TradeAuditPanel';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function TradeAuditMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="trade-audit material">
        <TradeAuditPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <TradeAuditMaterial props={props} />);
}
