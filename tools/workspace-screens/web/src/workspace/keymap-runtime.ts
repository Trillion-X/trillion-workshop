// src/workspace/keymap-runtime.ts
//
// PURPOSE
//   The one listener for every key chord Trillion's pages answer. keymap.json says which chord runs which verb where,
//   keymap.mjs holds the rules, and this file does the listening: one `keydown` listener, the verbs features register,
//   the person's own keys (their account record), and the keys the Mac app is asked to register for use from any app.
//   A feature that wants a key adds a row to keymap.json and calls `registerVerb`; it never listens for keys itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One listener, installed once, standing down for a key another surface already claimed (keyboard-claim.ts).
//   2. A row runs only when its verb has a handler on this page; a key whose row has no handler here is left alone, so it
//      still reaches the browser and any surface that does listen.
//   3. The person's keys are read from and written to their account record (`workspace-preference:` + keymap.json
//      `preference`), merged against the current value, so every device hears the same keys and one device's save never
//      drops another row's key.
//   4. A key is refused before it is saved (reserved, taken by another row, missing the modifier a key from any app
//      needs) and the refusal is the table's words, never a silent no-op.
//   5. Global rows are only told to the host (the Mac app registers them); the page itself never runs a global chord, it
//      runs the verb when the host says the key was pressed.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import table from './keymap.json';
import {
  activeScopes, chordOfEvent, effectiveRows, hostRows, mayRun, normalizeChord, refusalFor, rowFor, takenBy,
} from './keymap.mjs';
import { claimKeyboardEvent, withKeyboardClaim } from '../../parts/ui/show/keyboard-claim/keyboard-claim';
import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { toggleTheme } from '../../parts/screen-look/show/theme-toggle';
import { readJson } from './api';
import { readWorkspacePreference, subscribeRecordLabel, updateWorkspacePreferenceDurably } from './records';

export type KeymapRow = Omit<(typeof table.rows)[number], 'chord'> & { chord: string | null; with?: Record<string, unknown>; id?: string };
export type EffectiveRow = KeymapRow & { name: string; own: boolean };
type Overrides = Record<string, string | null>;
export type Verb = (row: EffectiveRow, event?: KeyboardEvent) => void | Promise<void>;
export type Refusal = 'needs_modifier' | 'reserved' | 'taken';

export const KEYMAP = table;
const LABEL = `workspace-preference:${table.preference}`;
const verbs = new Map<string, Verb>();

/** True on a Mac, where `mod` is Command; the same row is Ctrl on any other computer. */
export const onMac = (): boolean => {
  const label = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '';
  return /mac|iphone|ipad/i.test(label);
};

/** Gives a verb its handler on this page; the returned function takes it away again. */
export function registerVerb(verb: string, run: Verb): () => void {
  verbs.set(verb, run);
  return () => { if (verbs.get(verb) === run) verbs.delete(verb); };
}

/** Every row with the person's own keys laid over the usual ones. */
export const currentRows = (): EffectiveRow[] => effectiveRows(table, readWorkspacePreference<Overrides>(table.preference)) as EffectiveRow[];

/** Calls the listener whenever the person's keys change on this or another device. */
export const subscribeKeymap = (listener: () => void): (() => void) => subscribeRecordLabel(LABEL, listener);

export type Refused = { refusal: Refusal; holder: string | null };

/** Why `chord` may not be given to the row, and the words of the row that holds it when that is why, or null when it may. */
export function refusalOf(name: string, chord: string): Refused | null {
  const rows = currentRows();
  const row = rows.find(one => one.name === name);
  const refusal = row ? refusalFor(table, rows, row, chord) as Refusal | null : null;
  return row && refusal ? { refusal, holder: refusal === 'taken' ? takenBy(table, rows, row, chord)?.words ?? null : null } : null;
}

/** Saves the row's key (null takes it away). Answers why when the key may not be given, and then saves nothing. */
export async function setRowChord(name: string, chord: string | null): Promise<Refused | null> {
  const wanted = chord === null ? null : normalizeChord(chord, table);
  if (chord !== null) {
    if (wanted === null) return { refusal: 'needs_modifier', holder: null };
    const refused = refusalOf(name, wanted);
    if (refused) return refused;
  }
  await updateWorkspacePreferenceDurably<Overrides>(table.preference, current => ({ ...(current as Overrides | null ?? {}), [name]: wanted }));
  return null;
}

/** Puts the row back to its usual key (or, with no name, every row), by removing the person's own key. */
export async function resetRows(name?: string): Promise<void> {
  await updateWorkspacePreferenceDurably<Overrides>(table.preference, current => {
    if (name === undefined) return {};
    const rest = { ...(current as Overrides | null) };
    delete rest[name];
    return rest;
  });
}

const matchesTarget = (target: Element, selector: string): boolean => typeof target.closest === 'function' && target.closest(selector) !== null;

let listening = false;
/** Installs the one key listener (once) and the verbs every page can run; a screen's own verbs come from `registerVerb`. */
export function publishKeymap(): void {
  if (listening) return;
  listening = true;
  registerVerb('open-screen', row => {
    window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: row.with }));
  });
  registerVerb('join-upcoming-call', () => joinUpcomingCall());
  registerVerb('toggle-theme', () => { toggleTheme(); });
  // The Mac app registers the global keys and calls this when one is pressed; any other host has no channel and tells nobody.
  (window as unknown as Record<string, unknown>)[table.host.page_entry] = { pressed: runHotkey };
  const channel = ((window as unknown as { webkit?: { messageHandlers?: Record<string, { postMessage(message: unknown): void } | undefined> } }).webkit?.messageHandlers ?? {})[table.host.channel];
  if (channel) keepHostHotkeys(message => channel.postMessage(message));
  window.addEventListener('keydown', withKeyboardClaim(event => {
    if (event.repeat || event.isComposing) return;
    const text = chordOfEvent(event, table, onMac());
    if (!text) return;
    const active = activeScopes(table, selector => document.querySelector(selector) !== null);
    const row = rowFor(table, currentRows(), text, active, verb => verbs.has(verb));
    if (!row || !mayRun(table, text, event.target as Element | null, matchesTarget)) return;
    claimKeyboardEvent(event);
    void verbs.get(row.verb)?.(row, event);
  }));
}

/** Runs the row the Mac app says was pressed from any app. A row the person has since changed or a verb this page does not run does nothing. */
export function runHotkey(name: string): boolean {
  const row = currentRows().find(one => one.name === name && one.chord !== null);
  const run = row && verbs.get(row.verb);
  if (!row || !run) return false;
  void run(row);
  return true;
}

/** Tells the host the global keys now, and again whenever they change; answers the function that stops telling. */
export function keepHostHotkeys(tell: (message: { kind: 'hotkeys'; rows: ReturnType<typeof hostRows> }) => void): () => void {
  let told = '';
  const send = () => {
    const rows = hostRows(table, currentRows());
    const text = JSON.stringify(rows);
    if (text === told) return;
    told = text;
    tell({ kind: 'hotkeys', rows });
  };
  send();
  return subscribeKeymap(send);
}

type Called = { id: string; title: string; starts_at: string; ends_at: string | null; conference_url: string | null };

/** Opens the link of the call that is starting: the nearest event with a link that began no longer ago, or begins no later from now, than keymap.json `join_upcoming` says. */
async function joinUpcomingCall(): Promise<void> {
  const rules = table.join_upcoming;
  const now = Date.now();
  try {
    const span = new URLSearchParams({ from: new Date(now - rules.from_minutes_ago * 60_000).toISOString(), to: new Date(now + rules.look_ahead_hours * 3_600_000).toISOString() });
    const answer = await readJson<{ items: Called[] }>(`/work/api/calendar?${span}`);
    const next = answer.items
      .filter(item => item.conference_url && Date.parse(item.starts_at) <= now + rules.until_minutes_ahead * 60_000)
      .sort((left, right) => Math.abs(Date.parse(left.starts_at) - now) - Math.abs(Date.parse(right.starts_at) - now))[0];
    if (!next?.conference_url) { notify(table.words.no_call, { kind: 'info' }); return; }
    const link = document.createElement('a');
    link.href = next.conference_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    notify(`${table.words.call_failed} ${errorWords(error)}`.trim(), { kind: 'error' });
  }
}
