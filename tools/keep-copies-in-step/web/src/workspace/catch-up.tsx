// src/workspace/catch-up.tsx
//
// PURPOSE
//   What the page knows about whether every copy of the person's things is in step, handed to the shared catch-up part
//   (parts/ui/show/catch-up) as its sources, and shown everywhere the person is:
//     - this device: whether it is online, and how many of its changes wait to reach the store (quiet-writes.ts);
//     - the person's store: each of their devices (when it last caught up, what waits on it, how far it has got) and the
//       records it kept as two versions because two devices changed them apart (GET catch-up.json `store.read`);
//     - the sidebar's Your devices row (its dot in the leading state's tone, channel `catch-up`), its screen and hover
//       card (mountCatchUpScreen), the mark beside a pane's work (mountCatchUpMark), and the bell's running line while
//       changes go up or a device catches up, which the Mac menu bar item and the phone read from the same stream;
//     - every ⋯ menu on a record kept as two versions offers Two versions, opening the view that settles it in place
//       (versionsRows, read by menu-rows.tsx).
//   Words, tones, icons, ranks and actions are DATA (catch-up.json). Whether any of it shows is the person's show rules,
//   subject `catch-up`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a state the part draws: each source reports its own state keys and does its own actions.
//   2. No number is made up: this device counts the writes it holds; everything else comes from the store, and when
//      the store does not answer (it keeps no devices yet) its source reports nothing.
//   3. Every action and every settling is a promise its button shows (pending, done, Try again); nothing is told in a
//      separate toast. The bell's line for work going on is quiet and never pops up.
//   4. The store's own row for this device is left out: this page knows its own state first-hand. This device tells
//      the store how it stands (POST `store.here`) when that changes, so the person's other devices list it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { lazyPart } from '../../parts/ui/show/load-later/later';
import { createRoot } from 'react-dom/client';
import {
  CatchUpMark, catchUpReports, catchUpView, onCatchUpChange, provideCatchUpSource, provideCatchUpWords,
  type CatchUpFact, type CatchUpReport, type CatchUpSource, type CatchUpWords, type KeptApart, type ShownApart,
} from '../../parts/ui/show/catch-up';
import type { ActionMenuItem } from '../../parts/ui/show/action-menu';
// The whole picture (every device, its record copies and their cards) and the two-versions chooser are fetched the
// first time either is opened; the mark every pane carries is drawn at once.
const CatchUpPanel = lazyPart(() => import('../../parts/ui/show/catch-up/CatchUpPanel'), module => module.CatchUpPanel);
const TwoVersions = lazyPart(() => import('../../parts/ui/show/catch-up/TwoVersions'), module => module.TwoVersions);
import { notificationCenter } from '../../parts/ui/show/coss/notifications';
import { onShowChange, showOf } from '../../parts/ui/show/show-rules/show-of';
import { publishSurfaceBadge } from '../../parts/ui/show/surface-badges/surface-badges';
import { discardQuietDeadLetters, onQuietDeadLettersChange, onQuietWriteRefused, onQuietWritesChange, quietDeadLetters, quietWritesAcceptedAt, quietWritesWaiting, retryQuietDeadLetters, sendQuietWritesNow } from './quiet-writes';
import { onStoreChange } from './store-changes';
import { postNothingRead, readJson } from './api';
import { refusal } from './failure';
import { loadScreen, type EmptyScreenState } from '../../parts/ui/show/screen-state';
import { Container } from '../../parts/ui/show/container';
import data from './catch-up.json';

export const catchUpWords = data as unknown as CatchUpWords & { subject: string; send_wait_ms: number; store: { read: string; settle: string; here: string };
  device: { key: string; title: string; platforms: { match: string; name: string }[]; browsers: { match: string; name: string }[]; app: string; report_every_ms: number } };
const BADGE_CHANNEL = 'catch-up';
const MOVING_LINE = 'catch-up:moving';

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
function listening() {
  const listeners = new Set<() => void>();
  return { tell: () => { for (const listener of [...listeners]) listener(); }, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

/** What kind of device this page runs on, in the words catch-up.json `kinds` names icons by. */
function kindHere(): string {
  if (typeof navigator === 'undefined') return '';
  const mobile = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile
    ?? /iPhone|Android.+Mobile/.test(navigator.userAgent);
  if (mobile) return 'phone';
  return /iPad|Android/.test(navigator.userAgent) ? 'tablet' : 'computer';
}

/** The id this device keeps for itself, made once (the store tells devices apart by it). */
function deviceId(): string {
  const { key } = catchUpWords.device;
  try {
    const kept = localStorage.getItem(key);
    if (kept) return kept;
    const made = `d-${crypto.randomUUID()}`;
    localStorage.setItem(key, made);
    return made;
  } catch {
    return `d-${crypto.randomUUID()}`;
  }
}
/** This page's device, the same for every page this browser opens. */
export const thisDeviceId = typeof window === 'undefined' ? '' : deviceId();
/** This device's name for the person, from its browser's own description (catch-up.json `device`). */
function deviceTitle(): string {
  const { title, platforms, browsers, app } = catchUpWords.device;
  const said = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const platform = platforms.find(row => said.includes(row.match))?.name;
  const browser = browsers.find(row => said.includes(row.match))?.name;
  return platform ? (browser ? fill(title, { browser, platform }) : `${app} · ${platform}`) : app;
}

/** This device: online or not, and the writes it holds until the store takes them (invariant 2). */
function thisDevice(): CatchUpSource {
  const heard = listening();
  const openedAt = Date.now();
  window.addEventListener('online', heard.tell);
  window.addEventListener('offline', heard.tell);
  onQuietWritesChange(heard.tell);
  onQuietDeadLettersChange(heard.tell);
  // Sends everything waiting now and settles when the store has taken all of it, or fails when it has not in time
  // (the writes stay on this device and keep going up by themselves).
  const sendNow = () => new Promise<void>((resolve, reject) => {
    if (!navigator.onLine) { reject(new Error(catchUpWords.words.send_failed)); return; }
    const done = () => { if (quietWritesWaiting() > 0) return; finish(); resolve(); };
    const stopChange = onQuietWritesChange(done);
    const stopRefused = onQuietWriteRefused(() => { finish(); reject(new Error(catchUpWords.words.send_failed)); });
    const timer = window.setTimeout(() => { finish(); reject(new Error(catchUpWords.words.send_failed)); }, catchUpWords.send_wait_ms);
    const finish = () => { stopChange(); stopRefused(); window.clearTimeout(timer); };
    sendQuietWritesNow();
    done();
  });
  // The changes the store refused for good, kept whole: tried again by choice, or dropped by choice (quiet-writes.ts).
  const actions: Record<string, () => Promise<void>> = { 'send-now': sendNow, 'try-saved-again': async () => { await retryQuietDeadLetters(); }, 'drop-saved': async () => { await discardQuietDeadLetters(); } };
  const read = (): CatchUpReport => {
    const refused = quietDeadLetters().length;
    const waiting = refused || quietWritesWaiting();
    const state = !navigator.onLine ? 'offline' : refused ? 'not-saved' : waiting ? 'waiting' : 'caught-up';
    return { facts: [{ id: 'here', here: true, kind: kindHere(), state, waiting, at: quietWritesAcceptedAt() ?? openedAt, can: Object.keys(actions) }] };
  };
  // Tells the person's store how this device stands, so their other devices see it: when its state or waiting count
  // changes, else at most every report_every_ms; offline, nothing is sent and the store keeps the last it heard.
  // The copy of the records this device keeps is part of this device, so it is told with it (and never listed apart).
  let told = { state: '', waiting: -1, copy: '', at: 0 };
  // The page loads that copy once it is idle (main.tsx), so it is asked only from then on.
  let copy = '';
  let idle = false;
  const learnCopy = () => {
    if (!idle || copy) return;
    void import('./device-copy').then(module => module.deviceCopyId()).then(id => { if (id && !copy) { copy = id; tellStore(); } });
  };
  (window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 2000)))(() => { idle = true; learnCopy(); });
  const tellStore = () => {
    learnCopy();
    const [fact] = read().facts;
    if (!navigator.onLine) return;
    if (fact.state === told.state && fact.waiting === told.waiting && copy === told.copy && Date.now() - told.at < catchUpWords.device.report_every_ms) return;
    told = { state: fact.state, waiting: fact.waiting ?? 0, copy, at: Date.now() };
    const at = typeof fact.at === 'number' ? new Date(fact.at).toISOString() : fact.at;
    // Where this device stands changes nothing any screen here reads, so it never sets the page's kept copies aside.
    void postNothingRead(catchUpWords.store.here, { device_id: thisDeviceId, title: deviceTitle(), kind: fact.kind, state: fact.state, waiting: fact.waiting, at, ...(copy ? { copy_id: copy } : {}) })
      .catch(() => { told = { state: '', waiting: -1, copy: '', at: 0 }; });
  };
  heard.subscribe(tellStore);
  window.setInterval(tellStore, catchUpWords.device.report_every_ms);
  tellStore();
  return {
    read,
    subscribe: heard.subscribe,
    act: (action) => actions[action]?.(),
  };
}

type StoreAnswer = { devices?: (Omit<CatchUpFact, 'id'> & { device_id: string })[]; versions?: KeptApart[] };

/** The person's store: their devices and the records it kept apart (invariants 2 and 4). */
function theStore(): CatchUpSource & { reload: () => Promise<void> } {
  const heard = listening();
  let report: CatchUpReport = { facts: [] };
  let reading: Promise<void> | null = null;
  // A read that fails keeps what was read before (offline, the other devices are as last heard) and is thrown on, so
  // the screen can say it could not read.
  const reload = () => (reading ??= (async () => {
    const answer = await readJson<StoreAnswer>(catchUpWords.store.read);
    report = {
      facts: (answer.devices ?? []).filter(device => device.device_id !== thisDeviceId).map(device => ({ ...device, id: device.device_id })),
      apart: answer.versions ?? [],
    };
    heard.tell();
  })().finally(() => { reading = null; }));
  const read = () => { void reload().catch(() => {}); };
  read();
  onStoreChange(read, [catchUpWords.store.read]);
  window.addEventListener('online', read);
  return {
    reload,
    read: () => report,
    subscribe: heard.subscribe,
    settle: (apart, settle) => readJson(catchUpWords.store.settle, { method: 'POST', body: JSON.stringify({ id: apart.id, ...settle }) }).then(reload),
  };
}

/** The facts show rules read for the mark in one place. */
const ruleFacts = (where: string) => {
  const view = catchUpView(catchUpReports(), catchUpWords, Date.now());
  return { state: view.state, tone: view.row.tone ?? '', count: view.count, where };
};

let started = false;
let store: ReturnType<typeof theStore> | null = null;
/** Starts the page's sources, the sidebar row's dot and the bell's running line, once. */
export function keepCatchUp(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  provideCatchUpWords(catchUpWords);
  provideCatchUpSource('this-device', thisDevice());
  store = theStore();
  provideCatchUpSource('store', store);
  const center = notificationCenter();
  const show = () => {
    const view = catchUpView(catchUpReports(), catchUpWords, Date.now());
    const quiet = !view.state || view.row.quiet || showOf(catchUpWords.subject, ruleFacts('sidebar')).hidden;
    publishSurfaceBadge(BADGE_CHANNEL, quiet ? null : { text: view.label, kind: BADGE_CHANNEL, tone: view.row.tone });
    // Work going on is one quiet running line in the bell, so every place that follows the bell (the Mac menu bar's
    // ring, the phone) shows it too; it leaves the moment the work stops (invariant 3).
    if (view.row.moving && !showOf(catchUpWords.subject, ruleFacts('bell')).hidden) {
      center.emit(view.label, { id: MOVING_LINE, kind: 'info', quiet: true, toast: false, kept: true, running: true,
        ...(view.percent !== null ? { progress: { value: view.percent / 100 } } : {}) });
    } else if (center.get(MOVING_LINE)) center.forget(MOVING_LINE);
  };
  onCatchUpChange(show);
  onShowChange(show);
  window.setInterval(show, 60_000);
  show();
}

/** Mounts one of the catch-up screens once the store has been read: its loading and failed states are the shared
 *  screen states, and `empty` names when it has nothing to draw. */
function mountWithStore(element: HTMLElement, draw: () => React.ReactNode, empty?: () => EmptyScreenState | null, fitsContent = false): () => void {
  keepCatchUp();
  let root: ReturnType<typeof createRoot> | null = null;
  const host = document.createElement('div');
  // A screen fills its frame and scrolls inside it; a small piece (the mark) is as tall as what it draws.
  if (fitsContent) host.setAttribute('data-fits-content', ''); else host.className = 'catch-up-screen';
  element.replaceChildren(host);
  const panel = document.createElement('div');
  const stop = onCatchUpChange(() => root?.render(draw()));
  const screen = loadScreen(host, {
    loading: { label: catchUpWords.words.reading, layout: 'rows' },
    read: () => store?.reload() ?? Promise.resolve(),
    empty: () => empty?.() ?? null,
    failed: refusal(catchUpWords.words.read_failed),
    clear: () => { root?.unmount(); root = null; panel.remove(); },
    draw: () => {
      if (!root) { host.replaceChildren(panel); root = createRoot(panel); }
      root.render(draw());
    },
  });
  return () => { stop(); screen.dispose(); root?.unmount(); element.replaceChildren(); };
}

type ScreenProps = { surfaceInput?: Record<string, unknown> };

/** Your devices (and its hover card): the whole picture. */
export function mountCatchUpScreen(element: HTMLElement): () => void {
  return mountWithStore(element, () => <React.Suspense fallback={null}><CatchUpPanel words={catchUpWords} /></React.Suspense>);
}

/** Whether everything is in step, as a piece any screen or board can hold: the mark in its quiet form too, so a
 *  placed piece never vanishes (`form`: pill or icon). */
export function mountCatchUpStatusScreen(element: HTMLElement, props: ScreenProps = {}): () => void {
  const form = props.surfaceInput?.form === 'icon' ? 'icon' : 'pill';
  return mountWithStore(element, () => <CatchUpMark words={catchUpWords} form={form} always />, undefined, true);
}

/** Every record kept as two versions (or, with input `id`, one), each settled in place. */
export function mountTwoVersionsScreen(element: HTMLElement, props: ScreenProps = {}): () => void {
  const only = typeof props.surfaceInput?.id === 'string' ? props.surfaceInput.id : null;
  const kept = () => catchUpView(catchUpReports(), catchUpWords, Date.now()).apart.filter(apart => !only || apart.id === only);
  return mountWithStore(
    element,
    () => (
      <Container layout="vertical" gap="md" className="p-4">
        <React.Suspense fallback={null}>{kept().map(apart => <TwoVersions key={`${apart.source}:${apart.id}`} apart={apart} words={catchUpWords} />)}</React.Suspense>
      </Container>
    ),
    () => (kept().length ? null : { status: 'empty', title: catchUpWords.words.none_apart, description: catchUpWords.words.none_apart_detail, icon: 'GitCompareArrows' }),
  );
}

/** The small mark, into any host (a pane's bar, a host app's panel), drawn only while something is not in step and
 *  the person's show rules let it show there (`where`). */
export function mountCatchUpMark(element: HTMLElement, where: string, form: 'pill' | 'icon' = 'pill'): () => void {
  keepCatchUp();
  const root = createRoot(element);
  const draw = () => root.render(showOf(catchUpWords.subject, ruleFacts(where)).hidden ? null : <CatchUpMark words={catchUpWords} form={form} />);
  const stops = [onShowChange(draw), onCatchUpChange(draw)];
  draw();
  return () => { for (const stop of stops) stop(); root.unmount(); };
}

/** A ⋯ menu's rows for a thing its store kept as two versions: one row opening the view that settles it, in the menu. */
export function versionsRows(thing: { kind: string; id: string; record?: unknown }): ActionMenuItem[] {
  const ref = typeof thing.record === 'string' ? thing.record : null;
  const kept: ShownApart[] = [];
  for (const [source, report] of catchUpReports()) {
    for (const apart of report.apart ?? []) {
      if (apart.thing.id === thing.id || (ref && ref === `${apart.thing.kind}:${apart.thing.id}`)) kept.push({ ...apart, source });
    }
  }
  return kept.map(apart => ({
    id: `menu:versions:${apart.source}:${apart.id}`,
    label: catchUpWords.words.menu_label,
    icon: 'GitCompareArrows',
    hint: catchUpWords.words.apart_when,
    panel: close => <React.Suspense fallback={null}><TwoVersions apart={apart} words={catchUpWords} onSettled={close} /></React.Suspense>,
  }));
}
