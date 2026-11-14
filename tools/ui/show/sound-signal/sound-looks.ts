// parts/ui/show/sound-signal/sound-looks.ts
//
// NO PRIOR: searched bitfield-packages show for sound look, visualizer preset, and screen-look for motion looks
//
// PURPOSE
//   The looks anything moving with sound can wear: the starting looks (screen-look's sound-looks.json, where every
//   appearance lives) and how a kept look is read back. A kept look is the starting look it began from (`look`) with
//   the person's own changes laid over it (`custom`), so a starting look improved later still reaches everyone who
//   did not change that part. A person's own looks are kept the same way in their records (own-sound-looks.ts), apart
//   from this file, so anything that only draws a kept look (a background layer, a page without the person's records)
//   never carries the records store.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import looks from '../../../screen-look/show/sound-looks.json';
import type { SoundLook } from './sound-painters';

export type { SoundLook };
export const soundLooks = looks as { default_look: string; looks: SoundLook[] };

const starting = (id: unknown) => soundLooks.looks.find(row => row.id === id) ?? soundLooks.looks.find(row => row.id === soundLooks.default_look) ?? soundLooks.looks[0];

/** The look kept as `{ look, custom }` (a layer's input, a screen's saved choice), read back whole. A kept name
 *  (`custom.label`) is the person's own look's name. */
export function readSoundLook(kept: { look?: unknown; custom?: unknown } | null | undefined): SoundLook {
  const base = starting(kept?.look);
  const custom = kept?.custom && typeof kept.custom === 'object' ? (kept.custom as Partial<SoundLook>) : {};
  return { ...base, ...custom, id: base.id, label: typeof custom.label === 'string' && custom.label ? custom.label : base.label };
}

/** A look as it is kept: which starting look, and only what differs from it (its name too, when it is the person's). */
export function keepSoundLook(look: SoundLook): { look: string; custom: Partial<SoundLook> } {
  const base = starting(look.id);
  const custom: Partial<SoundLook> = {};
  for (const key of ['label', 'about', 'motion', 'palette', 'ground', 'strength', 'speed'] as const) {
    if (JSON.stringify(look[key]) !== JSON.stringify(base[key])) (custom as Record<string, unknown>)[key] = look[key];
  }
  return { look: base.id, custom };
}

/** True when two looks are the same as kept (the same starting look and the same changes). */
export const sameSoundLook = (a: SoundLook, b: SoundLook): boolean => JSON.stringify(keepSoundLook(a)) === JSON.stringify(keepSoundLook(b));
