// src/workspace/send-choices.ts
//
// PURPOSE
//   The choices the shared message box sends with, from the person's own share list (GET /work/api/share-destinations,
//   src/share-destinations.mjs), the same list the phone's share sheet, the Chrome extension and the Mac app read:
//   where it goes (their own Trillion and each pursuit, nested as the sidebar shows them, a pursuit with other people
//   in it marked; a new pursuit from typed words) and what their AI does with it (one of their saved actions; a new one
//   from typed words). By default the box names no place: Trillion routes the share itself and the pickers stay behind a
//   "Choose where" button. Every send goes through the one delivery road (POST /work/api/share-destinations/deliver,
//   which checks every place and action before sending any) by the device outbox (src/workspace/share-outbox.ts), which
//   keeps the share on this device before posting and sends it again, with the same request_key, if the account cannot
//   be reached.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The places and actions are the person's own list; nothing here names a pursuit or an action.
//   2. Words are DATA (send-choices.json).
//   3. Files are kept once in the person's Files and travel by identity.
//   4. A default send carries no `to`; places are named only after the person opens Choose where.
//   5. A share the account could not be reached for is said as kept, never as failed, and shows a quiet Waiting to send.

import React from 'react';
import type { ComposerDraft, ComposerPicker } from '../../parts/ui/show/composer';
import { postJson, readJson } from './api';
// The device outbox is fetched when a box is drawn or something is sent, so the page's first load does not carry it.
export const deviceOutbox = () => import('./share-outbox').then(module => module.shareOutbox);
/** How many shares this device is keeping to send again (0 until the outbox has loaded). */
export function useWaitingToSend(): number {
  const [waiting, setWaiting] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    let stop = () => {};
    void deviceOutbox().then(outbox => {
      if (!live) return;
      setWaiting(outbox.count());
      stop = outbox.subscribe(() => setWaiting(outbox.count()));
    }, () => undefined);
    return () => { live = false; stop(); };
  }, []);
  return waiting;
}
/** The shares this device let go (refused, stopped by a place, or too old), newest first, and what to do with each. */
export function useDeadShares() {
  const [letters, setLetters] = React.useState<import('./share-outbox').DeadLetter[]>([]);
  React.useEffect(() => {
    let live = true;
    let stop = () => {};
    void deviceOutbox().then(outbox => {
      if (!live) return;
      setLetters(outbox.deadLetters());
      stop = outbox.subscribe(() => setLetters(outbox.deadLetters()));
    }, () => undefined);
    return () => { live = false; stop(); };
  }, []);
  return {
    letters,
    sendAgain: async (key: string) => (await deviceOutbox()).sendAgain(key),
    discard: async (key: string) => (await deviceOutbox()).discardDead(key),
  };
}
// What sends the files and words (the recorder, the uploader and its preview makers) is fetched when something is sent.
const sending = () => import('./send-message');
import type { RunRef } from 'trillion-workshop/tools/hand-work-to-ais/web/src/workspace/job-run.tsx';
import words from './send-choices.json';
import { actionPicker, type Action, type Folder } from './action-picker';
export { actionPicker, type Action, type Folder };

type Place = { id: string; label: string; depth?: number; others_count?: number; to: { private?: boolean; pursuit_id?: string; space_id?: string; tool_id?: string }; on_by_default: boolean };
type Choices = { destinations: Place[]; actions: Action[]; folders?: Folder[] };
/** The most jobs a box keeps showing, newest first. */
const RUNS_SHOWN = 3;
// The work the person's sends started, newest first, kept outside any one box so a box drawn again (Home reads itself
// again after each send) still shows what was sent from it.
let sentRuns: RunRef[] = [];
const runListeners = new Set<() => void>();
const runsStarted = (more: RunRef[]) => { if (!more.length) return; sentRuns = [...more, ...sentRuns].slice(0, RUNS_SHOWN); runListeners.forEach(listener => listener()); };
const onRuns = (listener: () => void) => { runListeners.add(listener); return () => { runListeners.delete(listener); }; };

export const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
export const listed = (labels: string[]) => new Intl.ListFormat('en', { type: 'conjunction' }).format(labels);
const kindOf = (type: string) => (type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'file');

/** The pickers kept behind one "Choose where" button, with the quiet "Waiting to send" line while shares are kept here.
 *  `all` is the pickers that open; with none to open (places not read yet) a bare carrier holds the status line. */
export function pickersBehind(all: ComposerPicker[], open: boolean, onToggle: () => void, waiting: number): ComposerPicker[] {
  const behind = { label: words.route.choose_where, closeLabel: words.route.hide_where, open, onToggle, ...(waiting ? { status: words.route.waiting } : {}) };
  if (!all.length) return waiting ? [{ id: 'route-status', label: '', icon: words.send_to.icon, many: false, options: [], chosen: [], onChange: () => undefined, behind }] : [];
  return all.map(picker => ({ ...picker, behind }));
}

/** The person's places and actions, as the message box offers them. */
export const readSendChoices = () => readJson<Choices>('/work/api/share-destinations');

/** The message box's pickers, the send that honours them, and the work each send from this box started, newest first
 *  (the box shows it being done, src/workspace/job-run.tsx). */
export function useSendChoices(): { pickers: ComposerPicker[]; send: (draft: ComposerDraft) => Promise<string>; runs: RunRef[] } {
  const [choices, setChoices] = React.useState<Choices | null>(null);
  const runs = React.useSyncExternalStore(onRuns, () => sentRuns);
  const started = runsStarted;
  const [places, setPlaces] = React.useState<string[]>([]);
  const [action, setAction] = React.useState<string | null>(null);
  const [choosing, setChoosing] = React.useState(false);
  const waiting = useWaitingToSend();
  const read = React.useCallback(async () => {
    const answer = await readSendChoices();
    setChoices(answer);
    return answer;
  }, []);
  React.useEffect(() => {
    read().then(answer => setPlaces(answer.destinations.filter(place => place.on_by_default).map(place => place.id)), () => undefined);
  }, [read]);

  // A new pursuit from the typed words, through the one pursuits owner; it is picked once the list has it.
  const makePursuit = React.useCallback(async (name: string) => {
    const saved = await readJson<{ pursuits?: { id: string; title: string }[] }>('/work/api/pursuits', { method: 'PUT', body: JSON.stringify({ pursuits: [{ title: name, now: words.send_to.new_now, after: name }] }) });
    const made = saved.pursuits?.find(pursuit => pursuit.title === name);
    const answer = await read();
    const place = answer.destinations.find(row => row.to.pursuit_id === made?.id);
    if (place) setPlaces(now => [...now, place.id]);
  }, [read]);
  const makeAction = React.useCallback(async (name: string) => {
    const current = await read();
    const saved = await postJson<Choices>('/work/api/share-destinations', {
      actions: [...current.actions.map(row => ({ id: row.id, label: row.label, words: row.words, folder: row.folder })), { label: name, words: name, folder: null }],
    });
    setChoices(saved);
    setAction([...saved.actions].reverse().find(row => row.label === name)?.id ?? null);
  }, [read]);

  const pickers: ComposerPicker[] = pickersBehind(choices ? [
    {
      id: 'send-to', label: words.send_to.label, icon: words.send_to.icon, many: true, chosen: places, onChange: setPlaces,
      options: choices.destinations.map(place => ({ value: place.id, label: place.label, depth: place.depth ?? 0,
        icon: place.to.private ? words.send_to.private_icon : place.to.tool_id ? words.send_to.tool_icon : place.others_count ? words.send_to.with_people_icon : words.send_to.pursuit_icon })),
      search: { placeholder: words.send_to.search, create: { label: words.send_to.create, onCreate: name => { void makePursuit(name); } } },
    },
    actionPicker(choices, action, setAction, name => { void makeAction(name); }),
  ] : [], choosing, () => setChoosing(open => !open), waiting);

  const send = React.useCallback(async (draft: ComposerDraft) => {
    const kept = await (await sending()).keepFiles(draft);
    const items = [
      ...draft.links.map(url => ({ kind: 'link', url })),
      ...kept.map((file, index) => ({ kind: kindOf(draft.files[index]?.type ?? ''), name: file.name, file: file.identity })),
    ];
    const text = draft.text.trim();
    // Not choosing: no `to`, so Trillion routes the share itself. Choosing: the person's places (and action) go as picked.
    const named = choosing && places.length > 0;
    // What is said after the send, and the work it started, are fetched with the send (send-routed.ts).
    return (await import('./send-routed')).deliverFromBox({
      items: items.length ? items : [{ kind: 'selection', text }], request_key: crypto.randomUUID(),
      from: words.from, from_agent: words.from_agent, ...(named ? { to: places, ...(action ? { action } : {}) } : {}), ...(text ? { own_words: text } : {}),
    }, started);
  }, [choosing, places, action, started]);

  return { pickers, send, runs };
}
