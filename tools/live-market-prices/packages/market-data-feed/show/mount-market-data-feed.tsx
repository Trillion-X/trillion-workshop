import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../../../ui';
import { MarketDataFeedPanel } from './MarketDataFeedPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function MarketDataFeedMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="market-data-feed material">
        <MarketDataFeedPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <MarketDataFeedMaterial props={props} />);
}
