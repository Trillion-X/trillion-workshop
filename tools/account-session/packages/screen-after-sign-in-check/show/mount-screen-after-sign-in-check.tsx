import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { ScreenAfterSignInCheck, type ScreenAfterSignInCheckProps } from './ScreenAfterSignInCheck';

type MountArgs = {
  el: HTMLElement;
  props?: ScreenAfterSignInCheckProps;
};

function ScreenAfterSignInCheckRoot({ props }: { props: ScreenAfterSignInCheckProps }) {
  return (
    <ErrorBoundary zoneName="screen after sign-in check">
      <ScreenAfterSignInCheck {...props} />
    </ErrorBoundary>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(
    el,
    <ScreenAfterSignInCheckRoot props={props} />,
  );
}
