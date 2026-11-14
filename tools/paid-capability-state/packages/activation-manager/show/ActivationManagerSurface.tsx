'use client';

import React from 'react';
import { readActivationManagerSurfaceState } from '../do-work/read-activation-manager-surface-state';
import {
  readActivations,
  type ActivationListProjection,
} from '../read-data/read-activations';
import { ActivationManager } from './ActivationManager';

export function ActivationManagerSurface() {
  const [activationState, setActivationState] =
    React.useState<ActivationListProjection | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function loadActivations() {
      const nextActivationState = await readActivationManagerSurfaceState();
      if (!cancelled) setActivationState(nextActivationState);
    }
    void loadActivations();
    return () => {
      cancelled = true;
    };
  }, []);

  return <ActivationManager activations={readActivations(activationState)} />;
}
