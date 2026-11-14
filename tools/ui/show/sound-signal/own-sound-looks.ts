// parts/ui/show/sound-signal/own-sound-looks.ts
//
// PURPOSE
//   A person's own sound looks (saved from any place that tunes one): kept the same way as any kept look (a name with
//   a starting look and their changes, sound-looks.ts keepSoundLook) in their records (OWN_SOUND_LOOKS), so they reach
//   every device and anything a look is kept with reads them without knowing they are someone's own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only this file reads or writes the person's records for looks; sound-looks.ts stays free of the records store,
//      so drawing a kept look never brings the store (and its live connection) along.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { useWorkspacePreference, writeWorkspacePreference } from '#workspace-records';
import { keepSoundLook, readSoundLook, type SoundLook } from './sound-looks';

/** The person's own looks, by the record every device reads. */
export const OWN_SOUND_LOOKS = 'own-sound-looks';
type KeptLook = { look: string; custom: Partial<SoundLook> };

/** The person's own looks, read back whole, newest last. */
export function useOwnSoundLooks(): SoundLook[] {
  const rows = useWorkspacePreference<unknown>(OWN_SOUND_LOOKS);
  return (Array.isArray(rows) ? rows : []).filter((row): row is KeptLook => !!row && typeof row === 'object' && typeof (row as KeptLook).look === 'string').map(readSoundLook);
}

/** Keeps `look` among the person's own looks under `name` (a look of that name is replaced); answers it as kept. */
export async function saveOwnSoundLook(look: SoundLook, name: string, own: readonly SoundLook[]): Promise<SoundLook> {
  const label = name.trim();
  if (!label) throw new Error('Give your look a name.');
  const named = { ...look, label };
  const rows = [...own.filter(row => row.label !== label), named].map(keepSoundLook);
  await writeWorkspacePreference(OWN_SOUND_LOOKS, rows);
  return named;
}
