// parts/ui/show/speed-control/SpeedControl.tsx
//
// NO PRIOR: searched parts/ui (slider, segmented-control, audio-clip-player's 0.5-2x menu), 21st.dev 'playback speed
//   control slider with preset steps' (Marks Slider 29217: ruler marks and snap stops) and Mobbin 'audio playback speed
//   picker' (Brink's Playback Speed: the chosen speed large with its word under it, steps beside it; Matter and Moonly:
//   a column of preset speeds with a check). Adapted as original code on the shared Slider and Button.
//
// PURPOSE
//   One control for how fast a voice or a sound plays, from very slow to very fast: the speed written large, a slider
//   that moves on a log scale (so 0.1x to 1x has as much room as 1x to 16x, and fine steps stay fine everywhere), and
//   the preset steps as one press each. Any surface that sets a speed (Ambience, a player, a voice row) uses this.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The scale (min, max, step, presets, default) is DATA (speeds.json, or the caller's own); nothing here names a
//      speed.
//   2. The caller owns the value and where it is kept; this only says the speed the person picked, rounded to `step`
//      and kept inside the scale.
//   3. Built from the shared Slider and Button, so it takes the active screen look and keyboard focus like every other
//      control.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';

import { Button } from '../button/Button';
import { Container } from '../container';
import { Slider } from '../slider';
import { Text } from '../text/Text';
import speeds from './speeds.json';

export type SpeedScale = { min: number; max: number; step: number; default: number; presets: readonly number[] };

export type SpeedControlProps = {
  /** What is being sped up or slowed down, said as the slider's name. */
  label: string;
  /** The speed now, as times natural (1 is natural); null when nothing is set, shown as the scale's default. */
  value: number | null;
  onSpeed: (speed: number) => void;
  /** A line under the label, such as where this speed is used. */
  description?: string;
  /** The scale; the shared speeds.json when left out. */
  scale?: SpeedScale;
};

/** The shared scale every voice and player reads. */
export const speedScale: SpeedScale = speeds;

/** How a speed reads: "0.8×", "12×". */
export const speedLabel = (speed: number): string => `${Number(speed.toFixed(2))}×`;

const SLIDER_STEPS = 1000;

/** A speed rounded to the scale's step and kept inside it. */
export function speedOnScale(speed: number, scale: SpeedScale = speedScale): number {
  const stepped = Math.round(speed / scale.step) * scale.step;
  return Number(Math.min(scale.max, Math.max(scale.min, stepped)).toFixed(4));
}

/** Where a speed sits on the slider (0 to SLIDER_STEPS), on a log scale. */
const positionOf = (speed: number, scale: SpeedScale) =>
  Math.round((Math.log(speed / scale.min) / Math.log(scale.max / scale.min)) * SLIDER_STEPS);

/** The speed at a slider position. */
const speedAt = (position: number, scale: SpeedScale) =>
  speedOnScale(scale.min * Math.pow(scale.max / scale.min, position / SLIDER_STEPS), scale);

export function SpeedControl({ label, value, onSpeed, description, scale = speedScale }: SpeedControlProps) {
  const speed = value ?? scale.default;
  return (
    <Container layout="vertical" gap="sm">
      <Slider
        label={label}
        description={description}
        value={positionOf(speed, scale)}
        min={0}
        max={SLIDER_STEPS}
        step={1}
        valueLabel={speedLabel(speed)}
        aria-valuetext={speedLabel(speed)}
        onValueChange={position => onSpeed(speedAt(position, scale))}
      />
      <Container layout="horizontal" gap="xs" wrap role="group" aria-label={`${label}: steps`}>
        {scale.presets.map(step => (
          <Button key={step} variant="ghost" size="xs" active={Math.abs(step - speed) < scale.step / 2} onClick={() => onSpeed(step)}>
            {speedLabel(step)}
          </Button>
        ))}
      </Container>
      <Text variant="caption" color="faint" tabular>{`${speedLabel(scale.min)} to ${speedLabel(scale.max)}`}</Text>
    </Container>
  );
}
