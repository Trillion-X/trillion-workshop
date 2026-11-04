// parts/screen-look/show/use-screen-looks.ts
//
// PURPOSE
//   The looks a person can choose and the one they wear, read the same way everywhere a look is painted or picked:
//   the app's looks (its DATA, input `editable-screen-look-themes`) with the person's own looks over them by id (input
//   `own-screen-look-themes`), their account's choice (input `current-screen-look`), and this device's own look when it
//   keeps one (do-work/device-screen-look.ts) and the look a look rule picks for where this screen is (use-look-rule.ts),
//   resolved by the one rule in read-data/resolve-chosen-screen-look.ts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A look of the person's with an app look's id replaces that app look for them only.
//   2. This device's own look wins over a rule's, and a rule's over the account's, while the looks hold them
//      (resolveChosenScreenLook).
//   3. A theme mode (look-follow-system.ts) names the look the account wears while it is set, and an Automatic one follows
//      the computer's own appearance setting (use-system-dark.ts), the only place the screen look reads it.
//   4. A chosen id no list holds falls back to the app's first look, never to a look this file names.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useBitfieldData, useWorkspacePreference } from '#workspace-records';
import { readDeviceScreenLook, subscribeDeviceScreenLook } from '../do-work/device-screen-look';
import { keepLastAccountScreenLook, readCurrentScreenLook, readLastAccountScreenLook, screenLookToWear } from '../read-data/read-current-screen-look';
import { readEditableScreenLookThemes, readScreenLookRecord, type EditableScreenLookTheme } from '../read-data/read-editable-screen-look-themes';
import { resolveChosenScreenLook } from '../read-data/resolve-chosen-screen-look';
import { FOLLOW_SYSTEM, followedLookId, readFollowSystem, type FollowSystem } from '../read-data/look-follow-system';
import { useSystemDark } from './use-system-dark';
import { useLookRule } from './use-look-rule';

export type ScreenLooks = {
  looks: EditableScreenLookTheme[];
  own: Set<string>;
  /** The look this screen wears. */
  chosen: EditableScreenLookTheme;
  /** True when `chosen` is this device's own look rather than the account's. */
  onThisDevice: boolean;
  /** True when a look rule, not the account, picked `chosen` for this screen. */
  byRule: boolean;
  /** The person's theme mode (light, dark or Automatic) and the looks it wears, or null when they have none. */
  follow: FollowSystem | null;
};

export function useScreenLooks(): ScreenLooks {
  const appRows = useBitfieldData('editable-screen-look-themes');
  const ownRows = useBitfieldData('own-screen-look-themes');
  // The account's look as read; null when the read failed or has not come back yet, so the page keeps the look it wears.
  const read = readCurrentScreenLook(useBitfieldData('current-screen-look'));
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!read) return;
    applied.current = read;
    keepLastAccountScreenLook(read);
  }, [read]);
  const current = screenLookToWear({ read, applied: applied.current, stored: readLastAccountScreenLook() });
  const device = useSyncExternalStore(subscribeDeviceScreenLook, readDeviceScreenLook, () => null);
  const ruled = useLookRule();
  const follow = readFollowSystem(useWorkspacePreference(FOLLOW_SYSTEM.record_key));
  const systemDark = useSystemDark();
  return useMemo(() => {
    const app = readEditableScreenLookThemes(appRows);
    const mine = (Array.isArray(ownRows) ? ownRows : []).map(readScreenLookRecord).filter((theme): theme is EditableScreenLookTheme => !!theme);
    const byId = new Map(app.map(theme => [theme.id, theme] as const));
    for (const theme of mine) byId.set(theme.id, theme);
    const looks = [...byId.values()];
    return { looks, own: new Set(mine.map(theme => theme.id)), follow, ...resolveChosenScreenLook(looks, current, device, ruled, followedLookId(looks, follow, systemDark)) };
  }, [appRows, ownRows, current, device, ruled, follow?.mode, follow?.light, follow?.dark, systemDark]);
}
