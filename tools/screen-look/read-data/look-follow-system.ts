// parts/screen-look/read-data/look-follow-system.ts
//
// PURPOSE
//   Theme mode for the screen look (F-0993): wear the person's light look, their dark look, or let the computer's own
//   appearance setting choose between them (Automatic). The record is { mode, light, dark } (look-follow-system.json); the
//   Theme control writes it and use-screen-looks.ts hands the look it names to resolveChosenScreenLook, so the chooser's
//   check mark and the painted page agree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: looks, the record and the system's appearance in; a look id or a record out. No storage, no page.
//   2. A look is light or dark by its own ground colour (look-scheme.ts), never by its name or id.
//   3. A slot the record leaves empty, or names a look that is gone, is the first look of that kind; when no look is of
//      that kind there is no followed look and the account's choice stands.
//   4. Pressing a look while a mode is set keeps that look for its own kind; a fixed mode (light or dark) follows the kind
//      of the look pressed, so the control never disagrees with the screen.

import settings from '../look-follow-system.json' with { type: 'json' };
import lookOverTime from '../look-over-time.json' with { type: 'json' };
import { resolveScreenLookPalette } from './resolve-screen-look-palette.js';
import { screenLookScheme } from './look-scheme.ts';
import type { EditableScreenLookTheme } from './read-editable-screen-look-themes';

export type LookKind = 'light' | 'dark';
export type FollowSystem = { mode: string; light: string | null; dark: string | null };

export const FOLLOW_SYSTEM = settings as {
  record_key: string;
  modes: { id: string; label: string; follows: 'light' | 'dark' | 'system' }[];
  words: Record<'theme' | 'automatic_note' | 'light_note' | 'dark_note' | 'failed', string>;
};

const kindOf = new WeakMap<EditableScreenLookTheme, LookKind | null>();
/** Whether a look is light or dark, from its own ground colour; null when the ground is not a plain colour. */
export function kindOfLook(look: EditableScreenLookTheme): LookKind | null {
  if (!kindOf.has(look)) kindOf.set(look, screenLookScheme(resolveScreenLookPalette(look) as Record<string, string>, lookOverTime.keep_readable.ground));
  return kindOf.get(look) ?? null;
}

/** The person's record as kept, or null when there is none or it is not one this file understands. */
export function readFollowSystem(value: unknown): FollowSystem | null {
  const row = value as Partial<Record<keyof FollowSystem, unknown>> | null;
  if (!row || typeof row !== 'object' || typeof row.mode !== 'string' || !FOLLOW_SYSTEM.modes.some(mode => mode.id === row.mode)) return null;
  const id = (slot: unknown) => (typeof slot === 'string' && slot ? slot : null);
  return { mode: row.mode, light: id(row.light), dark: id(row.dark) };
}

/** The look worn for `kind`: the record's own, else the first look of that kind; null when no look is of that kind. */
export function lookForKind(looks: readonly EditableScreenLookTheme[], follow: Pick<FollowSystem, LookKind> | null, kind: LookKind): EditableScreenLookTheme | null {
  const named = follow?.[kind];
  return looks.find(look => look.id === named) ?? looks.find(look => kindOfLook(look) === kind) ?? null;
}

/** The id of the look the mode wears now, or null when there is no mode (the account's choice stands). */
export function followedLookId(looks: readonly EditableScreenLookTheme[], follow: FollowSystem | null, systemDark: boolean): string | null {
  const follows = FOLLOW_SYSTEM.modes.find(mode => mode.id === follow?.mode)?.follows;
  if (!follow || !follows) return null;
  const kind: LookKind = follows === 'system' ? (systemDark ? 'dark' : 'light') : follows;
  return lookForKind(looks, follow, kind)?.id ?? null;
}

/** The record after the person picks `mode`: the slots they had, else the worn look in its own kind's slot. */
export function pickMode(follow: FollowSystem | null, mode: string, looks: readonly EditableScreenLookTheme[], worn: EditableScreenLookTheme): FollowSystem {
  const next: FollowSystem = { mode, light: follow?.light ?? null, dark: follow?.dark ?? null };
  const wornKind = kindOfLook(worn);
  if (wornKind && !looks.some(look => look.id === next[wornKind])) next[wornKind] = worn.id;
  return next;
}

/** The record after the person presses `look`: kept for its own kind, and a fixed mode follows that kind. */
export function pressLook(follow: FollowSystem, look: EditableScreenLookTheme): FollowSystem {
  const kind = kindOfLook(look);
  if (!kind) return follow;
  const fixed = FOLLOW_SYSTEM.modes.find(mode => mode.follows === kind);
  const current = FOLLOW_SYSTEM.modes.find(mode => mode.id === follow.mode);
  return { ...follow, [kind]: look.id, mode: current && current.follows !== 'system' && fixed ? fixed.id : follow.mode };
}
