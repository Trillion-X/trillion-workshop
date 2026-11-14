import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { PortfolioConnectorPanel } from '@/packages/portfolio-connector/show/PortfolioConnectorPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function PortfolioConnectorMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="portfolio-connector material">
        <PortfolioConnectorPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <PortfolioConnectorMaterial props={props} />);
}
