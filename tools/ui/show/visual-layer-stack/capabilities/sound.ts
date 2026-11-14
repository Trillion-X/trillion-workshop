// packages/ui/show/visual-layer-stack/capabilities/sound.ts
//
// NO PRIOR: searched bitfield-packages show for sound layer, audio reactive background, and the visual-layer-stack capability packs
//
// PURPOSE
//   `effect.sound`: a layer that moves with the sound around the person ("Moves with sound"). Added from any
//   region's Background menu (behind the panes, a pane, a board card), it paints the kept look with the page's one
//   sound reading and has the person's chosen lights follow the same sound (parts/ui/show/sound-signal). Its
//   settings are the same controls the Ambience screen uses.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The layer's input is the kept look (`look`, `custom`, sound-looks.ts) and the ids that follow (`following`);
//      nothing else is stored, so a shared layout carries the look to whoever opens it.
//   2. Like every capability, it is one entry in the pack: the renderer, the Add menu and the settings panel read it
//      blind.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { later } from '../../load-later/later';
import { keepSoundLook, readSoundLook, soundLooks } from '../../sound-signal/sound-looks';
import type { VisualLayerCapability } from '../visual-layer-registry';

// A pane draws its sound layer once the layer's code has arrived; a page with no sound layer never fetches it.
const SoundLayer = later(() => import('../../sound-signal/SoundLayer'), module => module.SoundLayer);
const SoundControls = later(() => import('../../sound-signal/SoundControls'), module => module.SoundControls);

export const effectSound: VisualLayerCapability = {
  presentation: { label: 'Moves with sound', icon: 'AudioLines' },
  addAffordance: { order: 55, defaultZ: -1, defaultInput: { look: soundLooks.default_look, custom: {}, following: [] } },
  editor: ({ input, patchInput }) =>
    React.createElement(SoundControls, {
      look: readSoundLook(input),
      onLook: look => patchInput(keepSoundLook(look)),
      following: Array.isArray(input.following) ? (input.following as string[]) : [],
      onFollowing: ids => patchInput({ following: ids }),
    }),
  render: ({ descriptor }) => React.createElement(SoundLayer, { input: descriptor.paint.input }),
};
