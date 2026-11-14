'use client';

import React from 'react';
import { GuidedMediaOverlay } from './GuidedMediaOverlay';
import { useProgramLandingData } from './ProgramLandingData';

export function GuidedMediaSection() {
  const data = useProgramLandingData().guidedMedia;
  return <GuidedMediaOverlay {...data} />;
}
