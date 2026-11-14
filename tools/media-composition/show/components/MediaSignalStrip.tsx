import * as React from 'react';

import { Waveform } from '../../../ui/show/waveform';

export type MediaSignalStripProps = {
  tone?: 'blue' | 'emerald' | 'purple' | 'cyan';
  seed?: string;
  className?: string;
};

export function MediaSignalStrip({ tone = 'blue', seed, className }: MediaSignalStripProps) {
  return <Waveform {...{ tone, seed, className }} />;
}
