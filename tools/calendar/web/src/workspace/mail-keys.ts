// src/workspace/mail-keys.ts
//
// PURPOSE
//   The mail screen's keys, from the one keymap (keymap.json, scope `mail`): the screen registers one verb with the shared
//   key listener and reads each verb's current key back for the hints it draws. It listens for no key itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A mail verb's key is the row `mail-<verb>` of keymap.json, as the person has it (their own key over the usual one);
//      the hint beside a verb is that key, so re-recording it in Settings changes the hint everywhere.
//   2. The scope is heard only while the screen shows a message it can act on (the root carries `data-email-message-open`).
//   3. Nothing here names a key; keymap.json does, and keymap-runtime.ts decides when a press may run.

import * as React from 'react';
import { KEYMAP, currentRows, onMac, registerVerb, subscribeKeymap } from './keymap-runtime';
import { parseChord, shownChord } from './keymap.mjs';

/** The verb every mail row of keymap.json names; the row's `with.command` says which mail verb to run. */
export const MAIL_VERB = 'mail-command';
const ROW_PREFIX = 'mail-';

/** Runs `run(command)` when a mail row's key is pressed, for as long as the caller is mounted. */
export function useMailKeys(run: (command: string) => void): void {
  const latest = React.useRef(run);
  latest.current = run;
  React.useEffect(() => registerVerb(MAIL_VERB, row => { const command = (row.with as { command?: string } | undefined)?.command; if (command) latest.current(command); }), []);
}

export type MailKey = { chord: string | null; shown: string[]; menu: { key: string; modifiers: string[] } | null };

/** Each mail verb's key as the person has it now, drawn again when their keys change. */
export function useMailKeyOf(): (command: string) => MailKey {
  const [, redraw] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => subscribeKeymap(redraw), []);
  const rows = currentRows();
  return command => {
    const chord = rows.find(row => row.name === `${ROW_PREFIX}${command.replace(/_/g, '-')}`)?.chord ?? null;
    const parsed = chord ? parseChord(chord, KEYMAP) : null;
    if (!chord || !parsed) return { chord: null, shown: [], menu: null };
    const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.charAt(0).toUpperCase() + parsed.key.slice(1);
    return { chord, shown: shownChord(chord, KEYMAP, onMac()), menu: { key, modifiers: parsed.modifiers.map(name => name === 'mod' ? 'meta' : name) } };
  };
}
