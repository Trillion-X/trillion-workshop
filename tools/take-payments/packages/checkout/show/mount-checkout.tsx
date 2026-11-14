import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { CheckoutFlow, type CheckoutFlowProps } from './CheckoutFlow';

type MountArgs = {
  el: HTMLElement;
  props?: CheckoutFlowProps & { surfaceInput?: CheckoutFlowProps };
};

function CheckoutRoot({ props }: { props: CheckoutFlowProps }) {
  return (
    <ErrorBoundary zoneName="checkout">
      <CheckoutFlow {...props} />
    </ErrorBoundary>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  const { surfaceInput, ...directProps } = props;
  return mountReactSurface(el, <CheckoutRoot props={{ ...(surfaceInput ?? {}), ...directProps }} />);
}
