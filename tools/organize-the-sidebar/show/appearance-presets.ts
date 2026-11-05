// packages/group/show/appearance-presets.ts
//
// #225 P1 (R2 "presets") — a saveable APPEARANCE PRESET is a named bag of
// appearance keys (an `AppearanceProfile`), captured from any tier of the
// cascade and re-applyable to a board or an item. It is pure DATA + pure
// transforms: this leaf never enumerates WHICH keys a preset carries (L090) and
// never touches the log — it only shapes profiles into the per-key writes that
// the existing `setBoardAppearanceKey` / `patchItem(extra)` paths already apply,
// so a preset composes the P1 cascade instead of being a parallel mechanism.
//
// NON-NEGOTIABLE INVARIANTS
//   - GENERIC over keys: a preset holding a key this file never heard of applies
//     with zero code change here (the writes are produced by iterating the bag).
//   - CASCADE-COMPOSING: applying a preset to a board = one write per key through
//     `setBoardAppearanceKey`; to an item = one `extra` merge through `patchItem`.
//     A preset is therefore just "set these cascade keys at once", nothing new.
//   - EMPTY-SAFE: an undefined/empty profile yields zero writes (a no-op preset).

import type { AppearanceProfile } from './item-appearance.ts';

/** A named, reusable appearance profile — stored as DATA (a preset record). */
export interface AppearancePreset {
  readonly id: string;
  readonly name: string;
  /** The captured appearance keys. Opaque bag — this leaf never enumerates it. */
  readonly profile: AppearanceProfile;
}

/** One key→value the preset asks a target (board/item) to set. */
export interface AppearanceKeyWrite {
  readonly key: string;
  readonly value: unknown;
}

const isMeaningful = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/**
 * Capture a profile into a named preset. Only meaningful keys are kept, so a
 * preset never carries "unset" (empty/null) keys that would clobber a cascade
 * fallback when re-applied.
 */
export function makeAppearancePreset(id: string, name: string, profile: AppearanceProfile | undefined): AppearancePreset {
  const kept: Record<string, unknown> = {};
  if (profile && typeof profile === 'object') {
    for (const [key, value] of Object.entries(profile)) {
      if (isMeaningful(value)) kept[key] = value;
    }
  }
  return { id, name, profile: kept };
}

/**
 * The per-key writes to apply a preset to a target. GENERIC: one entry per key
 * in the bag, in stable (sorted) order so re-application is deterministic. The
 * caller feeds each `{key,value}` to `setBoardAppearanceKey` (board tier) or
 * folds them into an `extra` patch (item tier) — reusing the P1 cascade paths.
 */
export function presetKeyWrites(preset: AppearancePreset | undefined): AppearanceKeyWrite[] {
  const profile = preset?.profile;
  if (!profile || typeof profile !== 'object') return [];
  return Object.keys(profile)
    .filter((key) => isMeaningful((profile as Record<string, unknown>)[key]))
    .sort()
    .map((key) => ({ key, value: (profile as Record<string, unknown>)[key] }));
}

/**
 * Fold a preset onto an existing `extra`/profile bag (item-tier apply): the
 * preset's meaningful keys win, everything else is preserved. Pure merge.
 */
export function applyPresetToExtra(
  extra: Record<string, unknown> | undefined,
  preset: AppearancePreset | undefined,
): Record<string, unknown> {
  const base = extra && typeof extra === 'object' ? { ...extra } : {};
  for (const { key, value } of presetKeyWrites(preset)) base[key] = value;
  return base;
}

/** True when the preset would change nothing (no meaningful keys). */
export function presetIsEmpty(preset: AppearancePreset | undefined): boolean {
  return presetKeyWrites(preset).length === 0;
}
