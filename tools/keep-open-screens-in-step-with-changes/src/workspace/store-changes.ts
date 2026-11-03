// src/workspace/store-changes.ts
//
// PURPOSE
//   The one listener every open workspace screen shares for "the person's store changed": the Worker tells the page
//   over one WebSocket (/work/live, src/live-screen.mjs) each time the store's screen revision advances, including a
//   change in a space the person is in. A screen hands `onStoreChange` the function that reads it again and
//   gets back the function that stops it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One socket per page, however many screens listen, and one socket for the whole browser, however many tabs of this
//      page are open: the tab that holds the browser's lock for this stream (Web Locks) owns the socket and hands every
//      frame it hears to the other tabs over a BroadcastChannel; when it closes, the next tab waiting for the lock takes
//      over and opens the socket, whose first frame (the store's current revision) tells every tab whether it missed
//      anything. A browser without Web Locks or BroadcastChannel keeps one socket per tab, as before.
//   2. Reads are gathered: at most one round of reloads every few seconds, one round at a time, and only while the tab
//      is shown; a hidden tab reloads once when it is shown again. Reading a screen can never keep the store busy.
//   3. A dropped socket listens again, backing off with jitter, so every tab of every person does not reconnect in the
//      same second after a deploy or a network drop; nothing reconnects while no screen listens.
//   4. A revision already heard is not a change: the store tells a socket its current revision as it opens, so a
//      reconnect after a deploy, a computer waking or a dropped connection reloads the screens only when the store
//      moved on while the socket was down (every open tab reread every screen on every reconnect before, 2026-10-05).
//      The first revision a page hears is checked against the one the page itself carries (first-answers.json
//      screen_revision, read before every other answer the page brought), so opening a page rereads nothing unless the
//      store moved on since; a page that carries none (its answers taken out, an old Worker) reloads as before.
//   5. A page being left closes its socket cleanly, and a page brought back from the browser's cache listens again.
//   8. Lists the store windows (src/live-scopes.json) are held by `watchWindow` and kept current by ops; the `ops` event
//      type is that owner's, so a screen handles the other types through `onLiveEvent`.
//   7. The socket speaks the one live protocol (src/live-protocol.mjs, rules in src/live-protocol.json): its first frame's
//      hello can steer the page (reload, clear what it kept, sign in again, stop); requests are numbered and answered by
//      reply_to and fail with a named error when the socket closes; a socket silent past the dead-man time is closed and
//      listened for again; a numbered scope with a hole is filled by one catch-up request; a dirty notice reads its
//      kind again only when its version moved; ops, bundle and supplemental frames reach the one typed handler
//      registry (`onLiveEvent`), same-type events together; a socket opened before this code loaded
//      (window.trillionEarlySocket) is taken over with every frame it heard.
//   6. A change only some reads show (`{ changed: [read] }`, src/live-screen.mjs changedFor) reloads only the screens
//      listening for one of those reads, and moves no revision this page has heard; every other screen stays drawn.
//   7. A reconnect names the last numbered change it heard (`epoch`, `after`); the store replays the changes it missed in order,
//      or sends `reset` when it no longer holds them and every screen reads again. A message that is not a frame is dropped,
//      never taken for "everything changed".
//   9. A revision can name what changed (`writes`: record ids and the fields written, never values; src/live-screen.mjs).
//      A screen that says what its last read depended on (`onRecordsChange`, src/record-depends.mjs) reads again only
//      when such a revision touches it and is newer than that read; every other screen reads again as before. Only a
//      revision directly after the one this page heard is trusted to name every change: after a gap, or with no
//      `writes`, every screen reads again. A touching change that arrives while the screen's own write for the same key
//      is still on its way (`whileWriting`) waits until that write is answered, then reads once.

import { canShareTabs, leadBrowser } from './tab-leader.ts';
import firstAnswers from './first-answers.json' with { type: 'json' };
import storeChangeReads from './store-change-reads.json' with { type: 'json' };
import { touches, writesOf } from '../record-depends.mjs';
import { LIVE, applyWindowOps, bootAction, createCounters, createDirty, createEventRegistry, createFreshness, createRequests } from '../live-protocol.mjs';

/** What a screen's last read depended on (src/record-depends.mjs `depends`). */
export type ReadDepends = { version: string | null; ids: string[]; rows: string[]; members: { prefix: string; fields: string[] | null }[] };
type RecordWrites = NonNullable<ReturnType<typeof writesOf>>;

/** The reads naming writes only some screens show (store-change-reads.json): an AI's own messages and its activity. A
 *  screen drawn from them names them in `onStoreChange(reload, reads)`; AI_WORK is both, for a screen showing an AI's
 *  work as it happens (a job's run, a tool's own screen, any list or chart over the person's records). */
export const AI_MESSAGES = [storeChangeReads.messages] as const;
export const AI_ACTIVITY = [storeChangeReads.activity] as const;
export const AI_WORK = [storeChangeReads.messages, storeChangeReads.activity] as const;

// Every open screen reads itself again when the person's store changes (a decision made by their AI, a service
// connected in another tab): the Worker tells the open workspace over one WebSocket (/work/live, src/live-screen.mjs)
// with the store's revision, and each screen reads itself again. A dropped socket listens again, backing off.

const storeChanged = new Set<() => Promise<void> | void>();
// The reads each screen is drawn from, for the screens that named them (invariant 6).
const readsOf = new Map<() => Promise<void> | void, readonly string[]>();
const headsOf = new Map<() => Promise<void> | void, string>();
const seenHeads = new Map<() => Promise<void> | void, number | string>();
// What each screen that said so last read depended on, and the key its own writes go under (invariant 9).
const dependsOfScreen = new Map<() => Promise<void> | void, { depends: () => ReadDepends | null; key?: string }>();
// The keys with a write of this page on its way, how many each; and the screens a change reached while one was.
const writing = new Map<string, number>();
const waitingForWrite = new Map<string, Set<() => Promise<void> | void>>();
// The screens a narrow change asked to read again, gathered with the rest (invariant 2).
const narrowly = new Set<() => Promise<void> | void>();
let listening = false;
// Changes arrive in bursts (a computer uploading files changes the store many times a second), so the open screens
// reload at most once every few seconds, one reload at a time, and only while the tab is shown; a hidden tab reloads
// once when it is shown again. Reading a screen must never be able to keep the person's store busy.
const QUIET_MS = 3000;
let pending = false, everything = false, running = false, lastAt = 0;
// A revision (no `only`) reaches a screen that said what it depended on only when `writes` touches it (invariant 9).
function revisionReaches(reload: () => Promise<void> | void, writes?: RecordWrites | null): boolean {
  const said = dependsOfScreen.get(reload);
  const depends = said?.depends() ?? null;
  if (!writes || !depends || touches(depends, writes)) {
    if (said?.key && writing.has(said.key)) { waitingForWrite.get(said.key)?.add(reload) ?? waitingForWrite.set(said.key, new Set([reload])); return false; }
    return true;
  }
  return false;
}
function changed(only?: readonly string[], heads?: Record<string, number | string> | null, writes?: RecordWrites | null) {
  if (!only && !heads && !writes && !dependsOfScreen.size) everything = true;
  else for (const reload of storeChanged) {
    const head = headsOf.get(reload);
    const value = head ? heads?.[head] : undefined;
    if (value !== undefined) {
      if (value !== seenHeads.get(reload)) narrowly.add(reload);
      seenHeads.set(reload, value);
    } else if (only ? readsOf.get(reload)?.some(read => only.includes(read)) : revisionReaches(reload, writes)) narrowly.add(reload);
  }
  if (everything || narrowly.size) { pending = true; reloadSoon(); }
}
function reloadSoon() {
  if (running || document.visibilityState !== 'visible') return;
  const wait = Math.max(0, lastAt + QUIET_MS - Date.now());
  running = true;
  window.setTimeout(async () => {
    const due = everything ? [...storeChanged] : [...narrowly].filter(reload => storeChanged.has(reload));
    pending = false; everything = false; narrowly.clear();
    lastAt = Date.now();
    try { await Promise.all(due.map(reload => reload())); } finally { running = false; if (pending) reloadSoon(); }
  }, wait);
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (pending && document.visibilityState === 'visible') reloadSoon(); });
// The last revision the store told this page (invariant 4), and the socket listening now.
let heard: number | null = null;
// The revision the page was served at: its answer element, never asked for again, since a revision read now could be
// newer than the screens drawn (invariant 4).
function pageRevision(): number | null {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
  for (const element of document.querySelectorAll<HTMLElement>('script[data-page-answer]')) {
    if (element.dataset.pageAnswer !== firstAnswers.screen_revision) continue;
    try { const answer = JSON.parse(element.textContent || 'null') as { status?: number; body?: { revision?: unknown } } | null; return answer?.status === 200 && typeof answer.body?.revision === 'number' ? answer.body.revision : null; } catch { return null; }
  }
  return null;
}
let socket: WebSocket | null = null;
// The page's one handler registry for frames that carry state itself (ops, boot, supplemental); a screen names the type it handles.
const registry = createEventRegistry();
/** Handles every frame of this type, a batch at a time; one handler per type (a second is refused). Returns the function that stops it. */
export const onLiveEvent = (type: string, handler: (batch: { type: string; [key: string]: unknown }[]) => void | Promise<void>) => registry.on(type, handler);
/** Freshness of what this page holds (src/live-protocol.json freshness). */
export const liveFreshness = createFreshness();
let requests: ReturnType<typeof createRequests> | null = null;
/** Asks the store to push changes for exactly these ids; they are fresh while it holds the subscription. Fails with LiveSocketClosed when no socket is open. */
export async function keepFresh(ids: string[]): Promise<number> {
  if (!requests) throw new Error('No live connection is open.');
  const reply = await requests.request('subscribe', { ids: liveFreshness.wanted(ids) }) as { acked?: string[] };
  liveFreshness.acknowledged(reply.acked ?? []);
  return reply.acked?.length ?? 0;
}
const dirty = createDirty({ read: kind => changed([kind]) });
const counters = createCounters({
  // A jump in a scope's number is normal (a frame says where the scope is now, and several writes can share one): one
  // catch-up read says what changed after the number held, and only the screens listening for that scope's read read again.
  catchUp: async (scope, after) => {
    const caught = await requests?.request('catch_up', { scope, after }) as { read?: string | null; items?: unknown[]; error?: string } | undefined;
    const read = caught?.read ? (storeChangeReads as Record<string, string>)[caught.read] : undefined;
    if (read) { if (caught?.items?.length) changed([read]); } else changed();
    return caught;
  },
});
// Windowed lists (F-0896): the page holds a window of a list the store keeps up to date by ops.
type Watched = { from: number; to: number; rows: unknown[]; total?: number; stale: boolean; read?: string };
const watched = new Map<string, Set<Watched>>();
const askWindow = async (list: string, held: Watched) => {
  const reply = await requests?.request('window', { list, from: held.from, to: held.to }) as { rows?: unknown[]; total?: number; read?: string; error?: string } | undefined;
  if (!reply || reply.error) return;
  held.rows = reply.rows ?? []; held.total = reply.total; held.stale = false; held.read = reply.read;
};
const askAllWindows = () => { for (const [list, holders] of watched) for (const held of holders) void askWindow(list, held).catch(() => {}); };
registry.on('ops', batch => {
  for (const event of batch as unknown as { list: string; ops: Parameters<typeof applyWindowOps>[1]; read?: string }[]) {
    for (const held of watched.get(event.list) ?? []) {
      const next = applyWindowOps({ from: held.from, rows: held.rows, total: held.total }, event.ops);
      Object.assign(held, { rows: next.rows, total: next.total, stale: next.stale });
      if (event.ops.length) { const read = event.read ? (storeChangeReads as Record<string, string>)[event.read] : undefined; if (read) changed([read]); }
    }
  }
});
/** Holds the newest `to` rows of a list the store windows (src/live-scopes.json) and keeps them current by ops; the screens drawing
 *  the list's read are read again when its rows change. Answers a handle to read the rows and to stop. */
export function watchWindow(list: string, to: number): { rows: () => unknown[]; stop: () => void } {
  const held: Watched = { from: 0, to, rows: [], stale: true };
  const holders = watched.get(list) ?? new Set<Watched>();
  holders.add(held); watched.set(list, holders);
  if (requests) void askWindow(list, held).catch(() => {});
  return { rows: () => held.rows, stop: () => { holders.delete(held); if (!holders.size) watched.delete(list); } };
}
let pingTimer: number | null = null;
type EarlySocket = { socket: WebSocket; take: (consume: (text: string) => void) => void };
let retryTimer: number | null = null;
let stableTimer: number | null = null;
let listenGeneration = 0;
const STABLE_CONNECTION_MS = 30_000;
// The last listener leaving closes the socket only when none came back within live-protocol.json early.last_listener_grace_ms.
let leaveTimer: number | null = null;
type Frame = { revision: number | null; changed: string[] | null; heads: Record<string, number | string> | null; reset: boolean; epoch: string | null; seq: number | null; writes: RecordWrites | null };
// null: not a frame at all (dropped, never taken for "everything changed").
const frameOf = (data: unknown): Frame | null => {
  try {
    const frame = JSON.parse(String(data)) as { revision?: unknown; changed?: unknown; heads?: unknown; reset?: unknown; epoch?: unknown; seq?: unknown; writes?: unknown } | null;
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
    const heads = frame.heads && typeof frame.heads === 'object' && !Array.isArray(frame.heads)
      ? Object.fromEntries(Object.entries(frame.heads).filter(([, value]) => typeof value === 'number' || typeof value === 'string')) as Record<string, number | string> : null;
    return { revision: typeof frame.revision === 'number' ? frame.revision : null, changed: Array.isArray(frame.changed) ? frame.changed.filter((read): read is string => typeof read === 'string') : null, heads,
      reset: frame.reset === true, epoch: typeof frame.epoch === 'string' ? frame.epoch : null, seq: typeof frame.seq === 'number' && Number.isInteger(frame.seq) ? frame.seq : null, writes: writesOf(frame.writes) };
  } catch { return null; }
};
// Where this page left off in the store's numbered narrow changes (src/live-resume.json): a reconnect names it, so the
// store replays what was missed, or says `reset` and every screen reads again (invariant 7).
let streamEpoch: string | null = null;
let lastSeq = -1;
const resumeQuery = () => (streamEpoch !== null && lastSeq >= 0 ? `?${new URLSearchParams({ epoch: streamEpoch, after: String(lastSeq) })}` : '');
// One frame from the store, however it reached this tab (its own socket, or the tab that holds the browser's stream).
function handleFrame(data: unknown) {
  // Only the tab that owns the socket tracks its silence and asks over it; the others only apply what it heard.
  const arrived = requests?.heard(String(data));
  if (String(data) === LIVE.requests.pong_text) return;
  const parsed = (() => { try { return JSON.parse(String(data)) as Record<string, any>; } catch { return {} as Record<string, any>; } })();
  if (arrived?.epoch_changed) { liveFreshness.lost(); if (requests) askAllWindows(); changed(); }
  if (parsed.hello && requests) askAllWindows();
  const frame = frameOf(data);
  if (!frame) return;
  if (frame.epoch !== null && frame.seq !== null) {
    if (frame.epoch !== streamEpoch) { streamEpoch = frame.epoch; lastSeq = frame.seq; } else lastSeq = Math.max(lastSeq, frame.seq);
  }
  if (frame.reset) { changed(undefined, frame.heads); return; }
  const step = bootAction(parsed.hello);
  if (step) {
    // Kept for a listener that is not published yet (live-instructions.ts takes it when it starts).
    (window as unknown as { trillionPendingInstruction?: unknown }).trillionPendingInstruction = step;
    window.dispatchEvent(new CustomEvent('trillion-live-instruction', { detail: step }));
    // What the page does for the instruction is live-instructions.ts's (reload, clear what it kept, sign in); stopping is ours.
    if (step.action === 'stop') { stopListening(); return; }
  }
  if (typeof parsed.reply_to === 'number') return;
  if (parsed.counters && typeof parsed.counters === 'object') for (const [scope, n] of Object.entries(parsed.counters)) if (typeof n === 'number' || typeof n === 'string') void counters.observe(scope, n);
  if (parsed.dirty && typeof parsed.dirty.kind === 'string') dirty.notice(parsed.dirty);
  for (const type of ['ops', 'bundle', 'supplemental', 'badge'] as const) if (parsed[type] !== undefined) registry.push({ type, ...(typeof parsed[type] === 'object' ? parsed[type] : { value: parsed[type] }) });
  if (registry.pending()) queueMicrotask(() => { void registry.flush(); });
  // A frame that names no revision and no read (ops, a dirty notice, a bundle) changes no screen by itself.
  if (parsed.revision === undefined && !Array.isArray(parsed.changed)) return;
  const { revision, changed: only, heads, writes } = frame;
  if (only) { changed(only, heads); return; }
  const before = heard ?? pageRevision();
  if (revision !== null && revision === before) { heard = revision; if (heads) changed([], heads); return; }
  if (revision !== null) heard = revision;
  // Only the revision right after the one heard names every change since (invariant 9).
  changed(undefined, heads, revision !== null && before !== null && revision === before + 1 ? writes : null);
}
// The browser-wide stream: the tab holding this lock owns the socket; the others listen on the channel. Both exist in
// every current browser; without either, a tab keeps its own socket.
const STREAM_LOCK = LIVE.early.stream_lock;
// Opened when this tab starts listening and closed when it stops, so a page that never listens holds no channel.
let shared: BroadcastChannel | null = null;
let leading = false;
let stopLeading: (() => void) | null = null;
function stopListening() {
  if (leaveTimer !== null) window.clearTimeout(leaveTimer);
  leaveTimer = null;
  stopLeading?.();
  stopLeading = null;
  shared?.close();
  shared = null;
  leading = false;
  listening = false;
  listenGeneration += 1;
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  if (stableTimer !== null) window.clearTimeout(stableTimer);
  retryTimer = null;
  stableTimer = null;
  const leaving = socket;
  socket = null;
  if (pingTimer !== null) window.clearTimeout(pingTimer);
  pingTimer = null;
  requests?.close();
  requests = null;
  leaving?.close(1000);
}
function listenForStoreChanges() {
  if (listening || !storeChanged.size || typeof WebSocket === 'undefined') return;
  listening = true;
  const generation = ++listenGeneration;
  if (typeof BroadcastChannel !== 'undefined' && canShareTabs()) {
    shared = new BroadcastChannel('trillion-store-changes');
    shared.addEventListener('message', event => { if (listening && !leading) handleFrame(event.data); });
  }
  let wait = 1000;
  const retry = () => {
    if (generation !== listenGeneration || !listening || !storeChanged.size) return;
    const delay = wait * (0.5 + Math.random());
    wait = Math.min(wait * 2, 60000);
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      if (generation === listenGeneration && listening && storeChanged.size) listen();
    }, delay);
  };
  const listen = () => {
    if (generation !== listenGeneration || !listening || !storeChanged.size) return;
    retryTimer = null;
    const early = (window as unknown as { trillionEarlySocket?: EarlySocket }).trillionEarlySocket;
    (window as unknown as { trillionEarlySocket?: EarlySocket }).trillionEarlySocket = undefined;
    const opened = early?.socket && early.socket.readyState <= WebSocket.OPEN ? early.socket : new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/work/live${resumeQuery()}`);
    socket = opened;
    const live = createRequests({ send: text => { if (opened.readyState === WebSocket.OPEN) opened.send(text); } });
    requests = live;
    if (pingTimer !== null) window.clearTimeout(pingTimer);
    // Pings when it is time and closes a socket silent past the dead-man time, which then listens again like any dropped one.
    const beat = () => {
      pingTimer = window.setTimeout(() => {
        if (socket !== opened || generation !== listenGeneration) return;
        if (live.tick() === 'dead') { opened.close(4000, 'silent'); return; }
        beat();
      }, LIVE.requests.ping_ms / 2);
    };
    if (early?.socket === opened) beat();
    // When this socket opened, so its close is counted with how long it lived (an early socket may already be open).
    let openedAt = opened.readyState === WebSocket.OPEN ? performance.now() : null;
    opened.addEventListener('open', () => {
      openedAt = performance.now();
      if (generation !== listenGeneration || socket !== opened) return;
      beat();
      if (stableTimer !== null) window.clearTimeout(stableTimer);
      // A quick open/close still counts as a failed attempt. Reset only after the connection stays up.
      stableTimer = window.setTimeout(() => {
        stableTimer = null;
        if (generation === listenGeneration && listening && socket === opened && opened.readyState === WebSocket.OPEN) wait = 1000;
      }, STABLE_CONNECTION_MS);
    });
    // The other tabs of this browser do not open a socket of their own: they hear what this one hears.
    const hear = (data: unknown) => { handleFrame(data); shared?.postMessage(data); };
    if (early?.socket === opened) early.take(hear); else opened.addEventListener('message', event => hear(event.data));
    opened.addEventListener('close', event => {
      // Counted as a closed error-report category (src/interactions.mjs liveClosed): its code and how long it lived.
      (window as unknown as { trillionCounting?: { liveClosed?: (code: number, ms: number) => void } }).trillionCounting?.liveClosed?.(event.code, openedAt === null ? 0 : performance.now() - openedAt);
      live.close();
      if (socket === opened && pingTimer !== null) { window.clearTimeout(pingTimer); pingTimer = null; }
      if (generation !== listenGeneration || socket !== opened) return;
      socket = null;
      if (stableTimer !== null) window.clearTimeout(stableTimer);
      stableTimer = null;
      if (!storeChanged.size) { stopListening(); return; }
      retry();
    });
  };
  // Own the socket only when this tab holds the browser's stream lock; until it does, the stream arrives on the channel.
  if (!shared) { listen(); return; }
  stopLeading = leadBrowser(STREAM_LOCK, () => {
    if (generation !== listenGeneration || !listening) return;
    leading = true;
    listen();
    return () => { if (generation === listenGeneration) leading = false; };
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', stopListening);
  window.addEventListener('pageshow', event => { if (event.persisted && storeChanged.size) listenForStoreChanges(); });
}

/** Read `reload` again whenever the person's store changes; returns the function that stops it. A screen that names the
 *  reads it is drawn from (`reads`) is also read again when only one of them changed (invariant 6). */
export function onStoreChange(reload: () => Promise<void> | void, reads?: readonly string[]): () => void {
  if (leaveTimer !== null) { window.clearTimeout(leaveTimer); leaveTimer = null; }
  storeChanged.add(reload);
  if (reads?.length) readsOf.set(reload, reads);
  listenForStoreChanges();
  return () => {
    storeChanged.delete(reload);
    readsOf.delete(reload);
    headsOf.delete(reload);
    seenHeads.delete(reload);
    if (!storeChanged.size && leaveTimer === null) leaveTimer = window.setTimeout(() => { leaveTimer = null; if (!storeChanged.size) stopListening(); }, LIVE.early.last_listener_grace_ms);
  };
}

/** Read `reload` again when a store change touches what its last read depended on (`depends()`, an answer's `depends`;
 *  null reads again on every change), and not for changes to anything else (invariant 9). `key` names the screen's own
 *  writes (`whileWriting`): a touching change waits while one is on its way; `reads` are narrow reads it is also drawn
 *  from (as `onStoreChange` takes them). Returns the function that stops it. */
export function onRecordsChange(reload: () => Promise<void> | void, depends: () => ReadDepends | null, key?: string, reads?: readonly string[]): () => void {
  dependsOfScreen.set(reload, { depends, ...(key ? { key } : {}) });
  const stop = onStoreChange(reload, reads);
  return () => { dependsOfScreen.delete(reload); for (const waiting of waitingForWrite.values()) waiting.delete(reload); stop(); };
}

/** Runs the page's own write under `key`: a change touching a screen that writes under it waits until the write is
 *  answered (or fails), then that screen reads once (invariant 9). Answers what the write answers. */
export async function whileWriting<T>(key: string, write: () => Promise<T>): Promise<T> {
  writing.set(key, (writing.get(key) ?? 0) + 1);
  try { return await write(); } finally {
    const left = (writing.get(key) ?? 1) - 1;
    if (left > 0) writing.set(key, left);
    else {
      writing.delete(key);
      const waiting = waitingForWrite.get(key);
      waitingForWrite.delete(key);
      if (waiting?.size) { for (const reload of waiting) if (storeChanged.has(reload)) narrowly.add(reload); pending = true; reloadSoon(); }
    }
  }
}

/** Read only when this named account-local source head moves. Older servers without the head retain broad refreshes. */
export function onStoreHeadChange(reload: () => Promise<void> | void, head: string): () => void {
  headsOf.set(reload, head);
  return onStoreChange(reload);
}

/** Every open screen reads itself again (gathered like any change): the person's Focus changed, so every list it
 *  narrows answers differently (scope-focus.ts). */
export function readEveryScreenAgain(): void { changed(); }
/** Reads again only the screens drawn from `reads` (a run's declared `changes`, parts/ai-tool-catalog/read-data/declared-effects.ts), as a narrow change from the store would. */
export function readTheseAgain(reads: readonly string[]): void { if (reads.length) changed(reads); }
