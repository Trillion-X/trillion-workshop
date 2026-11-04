// parts/screen-look/read-data/resolve-chosen-screen-look.ts
//
// PURPOSE
//   Which look a screen wears: the look this device keeps for itself, when it keeps one, over the look a look rule picks
//   for where this screen is (where-looks-apply.ts: the app, the device, the hour), over the look the person chose for
//   their account ("everywhere else"), with the look the person's theme mode names (look-follow-system.ts: light, dark or
//   Automatic) standing in for the account's choice. One rule, read by every place a look is painted or picked (use-screen-looks.ts), so the
//   chooser's check mark and the painted page can never disagree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A device's own look wins only while the looks still hold it; a look that is gone lets the rule's look, and then
//      the account's choice, through. A rule's look the looks no longer hold lets the account's choice through.
//   2. An account choice the looks do not hold falls back to the first look, never to a look this file names.
//   3. Pure: no storage, no records, no page. The caller hands in the choices, the rule's already decided.
//   5. A theme mode's look is the account's choice for as long as the mode is set: it never beats a device's look or a rule's,
//      and a look it names that the looks no longer hold lets the account's choice through.
//   4. `byRule` says a rule picked the look for this screen, so the look plan for the day does not move it (a rule that
//      names an hour already says when); the account's look and a device's look follow the plan as they always did.

import type { EditableScreenLookTheme } from './read-editable-screen-look-themes';

export type ChosenScreenLook = {
  /** The look to wear. */
  chosen: EditableScreenLookTheme;
  /** True when that look is this device's own choice rather than the account's. */
  onThisDevice: boolean;
  /** True when a look rule picked that look for this screen. */
  byRule: boolean;
};

export function resolveChosenScreenLook(
  looks: readonly EditableScreenLookTheme[],
  accountChoice: string,
  deviceChoice: string | null,
  ruleChoice: string | null = null,
  followChoice: string | null = null,
): ChosenScreenLook {
  const byId = new Map(looks.map(theme => [theme.id, theme] as const));
  const onDevice = deviceChoice ? byId.get(deviceChoice) : undefined;
  if (onDevice) return { chosen: onDevice, onThisDevice: true, byRule: false };
  const ruled = ruleChoice ? byId.get(ruleChoice) : undefined;
  if (ruled) return { chosen: ruled, onThisDevice: false, byRule: true };
  const followed = followChoice ? byId.get(followChoice) : undefined;
  return { chosen: followed ?? byId.get(accountChoice) ?? looks[0], onThisDevice: false, byRule: false };
}
