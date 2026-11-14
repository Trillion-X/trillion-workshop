// parts/ui/show/sound-signal/SoundLayer.tsx
//
// NO PRIOR: searched bitfield-packages show for sound background layer, visualizer wallpaper, and visual-layer-stack capabilities for sound
//
// PURPOSE
//   What a region shows when its background moves with sound (the visual layer capability `effect.sound`): the kept
//   look painted with the sound, and the lights the person picked following the same sound while it is on screen.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { SoundCanvas } from './SoundCanvas';
import { readSoundLook } from './sound-looks';
import { followSound } from './sound-targets';

export function SoundLayer({ input }: { input: Record<string, unknown> }) {
  const look = readSoundLook(input);
  const lookRef = React.useRef(look);
  lookRef.current = look;
  const following = Array.isArray(input.following) ? (input.following as unknown[]).filter((id): id is string => typeof id === 'string') : [];
  const followingKey = following.join('\n');
  React.useEffect(() => followSound(followingKey ? followingKey.split('\n') : [], () => lookRef.current), [followingKey]);
  return <SoundCanvas look={look} />;
}
