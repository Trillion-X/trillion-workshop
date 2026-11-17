import React from 'react';
import { ErrorBoundary } from '../../../../ui/show/error-boundary';
import { FloatingMaterialFrame } from '../../../../ui/show/floating-material-frame';
import { mountReactSurface } from '../../../../ui/show/react-surface-mount';
import { OpponentGamePlanSurface } from './OpponentGamePlanSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function stringProp(props: Record<string, unknown>, snake: string, camel: string): string | undefined {
  return typeof props[snake] === 'string'
    ? props[snake]
    : typeof props[camel] === 'string'
      ? props[camel]
      : undefined;
}

function OpponentGamePlanMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Opponent Game Plan">
        <OpponentGamePlanSurface
          userId={stringProp(props, 'user_id', 'userId')}
          selfPlayerId={stringProp(props, 'self_player_id', 'selfPlayerId')}
        />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <OpponentGamePlanMaterial props={props} />);
}
