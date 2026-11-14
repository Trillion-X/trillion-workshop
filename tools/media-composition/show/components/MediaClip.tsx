import * as React from 'react';

import { ClipBlock, type ClipBlockTone } from '../../../ui/show/clip-block';

export type MediaClipTone = 'source' | 'audio' | 'analysis' | 'motion' | 'identity' | 'output';

export type MediaClipProps = {
  label: string;
  detail?: string;
  tone?: MediaClipTone;
  active?: boolean;
  showSignal?: boolean;
  widthPct?: number;
  seed?: string;
  onClick?: () => void;
  className?: string;
};

function toClipBlockTone(tone: MediaClipTone): ClipBlockTone {
  // MediaClipTone maps 1:1 to ClipBlockTone — same string union
  return tone as ClipBlockTone;
}

function signalSeed(tone: MediaClipTone): 'blue' | 'emerald' | 'purple' | 'cyan' {
  if (tone === 'audio' || tone === 'output') return 'emerald';
  if (tone === 'analysis' || tone === 'identity') return 'purple';
  if (tone === 'motion') return 'cyan';
  return 'blue';
}

export function MediaClip({
  label,
  detail,
  tone = 'source',
  active,
  showSignal,
  widthPct,
  seed,
  onClick,
  className,
}: MediaClipProps) {
  const resolvedSeed = seed ?? signalSeed(tone);
  return (
    <ClipBlock
      {...{
        label,
        detail,
        tone: toClipBlockTone(tone),
        active,
        showWaveform: showSignal,
        widthPct,
        seed: resolvedSeed,
        onClick,
        className,
      }}
    />
  );
}
