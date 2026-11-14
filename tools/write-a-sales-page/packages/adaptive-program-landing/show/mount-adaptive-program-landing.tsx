import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { assertProgramLandingData } from '../read-data/program-landing-data';
import { ProgramLanding } from './ProgramLanding';

type MountArgs = {
  el: HTMLElement;
};

function ProgramLandingRoot() {
  const landingData = useBitfieldData('adaptive-program-landing-data');
  if (landingData == null) {
    return <section role="status" aria-label="Loading the program" />;
  }
  assertProgramLandingData(landingData);
  return <ProgramLanding data={landingData} />;
}

export default function mount({ el }: MountArgs) {
  return mountReactSurface(
    el,
    <ErrorBoundary zoneName="program landing">
      <ProgramLandingRoot />
    </ErrorBoundary>,
  );
}
