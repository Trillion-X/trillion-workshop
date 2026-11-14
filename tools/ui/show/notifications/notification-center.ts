// packages/ui/show/notifications/notification-center.ts
//
// PURPOSE
// The one notification store for every surface. A caller emits a notification
// (title, optional detail, optional progress, optional actions) and gets a
// handle to update, finish or dismiss it. Renderers (the stacked toasts and
// the history bell) subscribe to CHANGES, never re-read the whole list.
//
// NON-NEGOTIABLE INVARIANTS
// 1. One store per document. Every toast, every progress card and every
//    history row reads the same record; nothing keeps a second copy.
// 2. Kinds are DATA. The store never names a kind; appearance for a kind key
//    comes from notification-kinds.json (beside this file) through the renderer.
// 3. A running notification (live progress or `running: true`) never expires.
//    It stays until the caller finishes it, then expires on its settled
//    timeout. Dismissing it hides the card; its history row remains.
// 4. Every change is published as {type, record}: subscribers do O(changed).
// 5. `key` is the caller's stable identity for one ongoing thing (a transfer,
//    a batch). Emitting with a live key updates that card instead of stacking
//    a duplicate.
//
// KEY CONCEPTS
// - visible: the card is on screen. History keeps records after they hide.
// - read: the person has dealt with it in the notification center (row
//   opened, "Mark as read", "Mark all as read"). Unread records drive the
//   bell's count. Merely opening the center does not mark anything read.
// - progress.value: 0..1 for determinate, null for indeterminate.
// - shown: before a card pops up the center asks the page's show rules (parts/ui/show/show-rules showOf) how a
//   notice like it shows on the toast channel; a silenced or hidden one is kept in history without a card. When the
//   rules change, a card they now silence leaves the screen. The center never decides a rule itself.

import {onShowChange, showOf, type ShowThing} from '../show-rules/show-of.ts';
import {sayHappened} from '../happened/happened.ts';

export interface NotificationAction {
  /** Stable id within one notification, used for keyboard focus and tests. */
  id?: string;
  label: string;
  /** A NamedIcon name drawn before the label; `danger` draws it in the destructive colour (a Stop). */
  icon?: string;
  danger?: boolean;
  /** Runs when chosen, with the person's words when the action asks for them (`input`). A returned promise keeps the
   *  button busy until it settles. */
  onAction?: (text?: string) => unknown;
  /** The action asks for words first (a reply): pressing it opens a field over the notification, and Send runs it. */
  input?: {placeholder?: string; button?: string};
  /** Hide the card after the action runs. Defaults to true. */
  dismisses?: boolean;
  /** The row's own press: pressing anywhere on the notification runs it, and it is not drawn as a button. */
  press?: boolean;
}

/** Who a notification is about, leading it in place of the kind's icon: the provider's mark when `provider` is known,
 *  else the `picture`, else initials. */
export interface NotificationFace {
  name: string;
  picture?: string | null;
  provider?: string | null;
}

export interface NotificationProgress {
  /** 0..1 for a known fraction; null when the amount is not known yet. */
  value: number | null;
  /** Plain words under the bar: "12 of 42 · 3.1 GB of 8.2 GB · About 4 min left". */
  label?: string;
}

/** A short fact said as a chip (who has it, what state it is in); `tone` names a badge colour. */
export interface NotificationChip {
  text: string;
  tone?: string;
}

export interface NotificationInput {
  /** Kind key resolved against notification-kinds DATA. Unknown keys draw with the fallback. */
  kind?: string;
  detail?: string;
  /** Short facts drawn as one row of chips under the title, instead of a sentence. */
  chips?: NotificationChip[];
  progress?: NotificationProgress | null;
  actions?: NotificationAction[];
  /** Milliseconds on screen. 0 keeps it until dismissed or finished. */
  timeout?: number;
  /** Keeps the card up with no progress bar (for example "Waiting for the card"). */
  running?: boolean;
  /** Who it is about, drawn as its lead. */
  face?: NotificationFace;
  /** A small picture of the thing this notice is about, read from its saved preview. */
  preview?: string | null;
  /** Someone is doing the work now (the face turns). Left out, a running notification counts as being worked on. */
  working?: boolean;
  /** Stable identity for an ongoing thing; a live match is updated in place. */
  key?: string;
  /**
   * Background work the person did not start: it appears in the notification
   * center's "In progress" section and history, never as a toast, and does not
   * add to the unread count.
   */
  quiet?: boolean;
  /**
   * The id this notification has in the caller's own lasting store (a request, a message, a finished job). Emitting
   * the same id again updates that record in place, whatever its state, so a list read again never stacks copies.
   */
  id?: string;
  /** When it happened (ms since the epoch), for a notification read from a store; defaults to now. */
  at?: number;
  /** Whether the person has read it, as the caller's store says. */
  read?: boolean;
  /** false: it goes into the center only, with no card on screen (a list read at page open is not news again). */
  toast?: boolean;
  /** The caller's store is told when the person marks it read or unread; the store stays the one truth. */
  onRead?: (read: boolean) => void;
  /** It belongs to the caller's store: Remove and Clear leave it; the store decides when it goes. */
  kept?: boolean;
  /** The id of the thing it is about in the caller's store (a request, a press that asked for work), so a control on
   *  that thing can follow what its notifications say. */
  about?: string;
}

export interface NotificationRecord extends NotificationInput {
  id: string;
  kind: string;
  title: string;
  actions: NotificationAction[];
  running: boolean;
  timeout: number;
  visible: boolean;
  read: boolean;
  createdAt: number;
  updatedAt: number;
  /** Increments on every change so renderers can replay a settle animation. */
  revision: number;
}

export type NotificationChange =
  | { type: 'added'; record: NotificationRecord }
  | { type: 'updated'; record: NotificationRecord }
  | { type: 'hidden'; record: NotificationRecord }
  | { type: 'removed'; record: NotificationRecord };

export interface NotificationHandle {
  id: string;
  update(patch: Partial<NotificationInput> & { title?: string }): NotificationHandle;
  /** Settle a running notification: progress clears and it expires normally. */
  finish(patch?: Partial<NotificationInput> & { title?: string }): NotificationHandle;
  dismiss(): void;
}

export interface NotificationCenterOptions {
  /** Default time on screen for a settled notification. */
  defaultTimeout?: number;
  /** How many records history keeps. */
  historyLimit?: number;
  now?: () => number;
}

export interface NotificationCenter {
  emit(title: string, input?: NotificationInput): NotificationHandle;
  get(id: string): NotificationRecord | undefined;
  /** Newest first. */
  history(): NotificationRecord[];
  visible(): NotificationRecord[];
  unreadCount(): number;
  setRead(id: string, read: boolean): void;
  markAllRead(): void;
  /** Forget one settled record. Running work cannot be removed, only cancelled by its owner. */
  remove(id: string): void;
  /** Hide one card; history keeps it. */
  hide(id: string): void;
  /** Hide every settled card. Running progress stays on screen. */
  clearTransient(): void;
  /** Forget everything in history that is no longer running (a kept record stays). */
  clearHistory(): void;
  /** The caller's store no longer holds this record: it leaves history, kept or not. */
  forget(id: string): void;
  subscribe(listener: (change: NotificationChange) => void): () => void;
}

const DEFAULT_KIND = 'info';
/** What show rules call a notification (show-rules.json subjects). */
export const NOTICE_SUBJECT = 'notification';
/** A notice as show rules read it: its own fields, and the channel it would show on (`toast`, `list`). */
export function noticeThing(record: Pick<NotificationRecord, 'id' | 'kind' | 'title'> & {key?: string; about?: string}, channel: string): ShowThing {
  return {id: record.id, kind: record.kind, title: record.title, ...(record.key ? {key: record.key} : {}), ...(record.about ? {about: record.about} : {}), channel};
}
const poppedUp = (record: Pick<NotificationRecord, 'id' | 'kind' | 'title'>) => !showOf(NOTICE_SUBJECT, noticeThing(record, 'toast')).silenced;
/** How long a settled card stays on screen unless its caller says otherwise. */
export const NOTIFICATION_TIMEOUT = 5000;

export function createNotificationCenter(options: NotificationCenterOptions = {}): NotificationCenter {
  const defaultTimeout = options.defaultTimeout ?? NOTIFICATION_TIMEOUT;
  const historyLimit = options.historyLimit ?? 50;
  const now = options.now ?? Date.now;
  const records: NotificationRecord[] = [];
  const byId = new Map<string, NotificationRecord>();
  const liveByKey = new Map<string, string>();
  const listeners = new Set<(change: NotificationChange) => void>();
  let sequence = 0;

  const publish = (change: NotificationChange) => {
    for (const listener of listeners) {
      try { listener(change); } catch (error) { console.error('Notification listener failed', error); }
    }
  };
  const isRunning = (input: NotificationInput) => Boolean(input.running) || (input.progress !== undefined && input.progress !== null);
  const clampProgress = (progress: NotificationProgress | null | undefined) => {
    if (!progress) return progress;
    const value = progress.value === null || !Number.isFinite(progress.value) ? null : Math.min(1, Math.max(0, progress.value));
    return { ...progress, value };
  };
  const trim = () => {
    while (records.length > historyLimit) {
      let index = records.length - 1;
      while (index >= 0 && (records[index].running || records[index].visible || records[index].kept)) index -= 1;
      if (index < 0) break;
      const [removed] = records.splice(index, 1);
      byId.delete(removed.id);
      publish({ type: 'removed', record: removed });
    }
  };

  const apply = (record: NotificationRecord, patch: Partial<NotificationInput> & { title?: string }, settle: boolean) => {
    const next: NotificationRecord = { ...record };
    if (patch.title !== undefined) next.title = String(patch.title);
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.detail !== undefined) next.detail = patch.detail;
    if (patch.chips !== undefined) next.chips = patch.chips;
    if (patch.actions !== undefined) next.actions = [...patch.actions];
    if (patch.progress !== undefined) next.progress = clampProgress(patch.progress);
    if (patch.running !== undefined) next.running = patch.running;
    else if (patch.progress !== undefined) next.running = isRunning({ ...next, progress: patch.progress });
    if (settle) { next.running = false; next.progress = null; }
    next.timeout = patch.timeout ?? (next.running ? 0 : record.running ? defaultTimeout : record.timeout);
    // A finished or updated notification the person already dismissed comes
    // back into view only when it changes state (running → settled), because
    // that is news; a routine progress tick stays in the bell.
    if (!next.quiet && (settle || (record.running && !next.running)) && poppedUp(next)) next.visible = true;
    next.read = next.quiet || (next.read && !(settle || (record.running && !next.running)));
    next.updatedAt = now();
    next.revision = record.revision + 1;
    const index = records.indexOf(record);
    records[index] = next;
    byId.set(next.id, next);
    if (!next.running && next.key && liveByKey.get(next.key) === next.id) liveByKey.delete(next.key);
    if (next.running && next.key) liveByKey.set(next.key, next.id);
    publish({ type: 'updated', record: next });
    return next;
  };

  const handleFor = (id: string): NotificationHandle => ({
    id,
    update(patch) { const record = byId.get(id); if (record) apply(record, patch, false); return this; },
    finish(patch = {}) { const record = byId.get(id); if (record) apply(record, patch, true); return this; },
    dismiss() { center.hide(id); },
  });

  // A rule saved (Silence for 1 hour on a card) takes every card it now silences off the screen.
  onShowChange(() => {
    for (const record of [...records]) if (record.visible && !poppedUp(record)) center.hide(record.id);
  });

  const center: NotificationCenter = {
    emit(title, input = {}) {
      const stored = input.id ? byId.get(input.id) : undefined;
      if (stored) {
        const time = input.at ?? stored.updatedAt;
        const next: NotificationRecord = { ...stored, ...input, id: stored.id, title: String(title), kind: input.kind ?? stored.kind,
          actions: [...(input.actions ?? stored.actions)], read: input.read ?? stored.read, updatedAt: time, revision: stored.revision + 1 };
        records[records.indexOf(stored)] = next;
        byId.set(next.id, next);
        publish({ type: 'updated', record: next });
        return handleFor(next.id);
      }
      const liveId = input.key ? liveByKey.get(input.key) : undefined;
      const live = liveId ? byId.get(liveId) : undefined;
      if (live) {
        const settle = live.running && !isRunning(input);
        apply(live, { ...input, title }, settle);
        return handleFor(live.id);
      }
      const running = isRunning(input);
      const time = input.at ?? now();
      const record: NotificationRecord = {
        ...input,
        id: input.id ?? `notification-${time.toString(36)}-${(sequence++).toString(36)}`,
        kind: input.kind ?? DEFAULT_KIND,
        title: String(title),
        actions: [...(input.actions ?? [])],
        progress: clampProgress(input.progress),
        running,
        timeout: input.timeout ?? (running ? 0 : defaultTimeout),
        visible: false,
        read: input.read ?? Boolean(input.quiet),
        createdAt: time,
        updatedAt: time,
        revision: 0,
      };
      record.visible = !input.quiet && input.toast !== false && poppedUp(record);
      // Newest first: a record from a store lands at its own time among the rest.
      const at = records.findIndex((other) => other.createdAt <= record.createdAt);
      records.splice(at < 0 ? records.length : at, 0, record);
      byId.set(record.id, record);
      if (record.key && running) liveByKey.set(record.key, record.id);
      publish({ type: 'added', record });
      // A notice that pops up is said on the happened channel, so the device's feel answers its arrival.
      if (record.visible) sayHappened({ event_kind: 'notice-arrived', kind: record.kind });
      trim();
      return handleFor(record.id);
    },
    get: (id) => byId.get(id),
    history: () => [...records],
    visible: () => records.filter((record) => record.visible),
    // A notice a show rule hides is out of the list, so it is not counted either.
    unreadCount: () => records.reduce((count, record) => count + (record.read || showOf(NOTICE_SUBJECT, noticeThing(record, 'list')).hidden ? 0 : 1), 0),
    setRead(id, read) {
      const record = byId.get(id);
      if (!record || record.read === read) return;
      const next = { ...record, read };
      records[records.indexOf(record)] = next;
      byId.set(id, next);
      publish({ type: 'updated', record: next });
      record.onRead?.(read);
    },
    markAllRead() {
      for (const record of [...records]) center.setRead(record.id, true);
    },
    remove(id) {
      const record = byId.get(id);
      if (!record || record.running || record.kept) return;
      records.splice(records.indexOf(record), 1);
      byId.delete(id);
      publish({ type: 'removed', record });
    },
    hide(id) {
      const record = byId.get(id);
      if (!record || !record.visible) return;
      const next = { ...record, visible: false };
      records[records.indexOf(record)] = next;
      byId.set(id, next);
      publish({ type: 'hidden', record: next });
      trim();
    },
    clearTransient() {
      for (const record of [...records]) if (record.visible && !record.running) center.hide(record.id);
    },
    clearHistory() {
      for (const record of [...records]) {
        if (record.running || record.kept) continue;
        records.splice(records.indexOf(record), 1);
        byId.delete(record.id);
        publish({ type: 'removed', record });
      }
    },
    forget(id) {
      const record = byId.get(id);
      if (!record) return;
      records.splice(records.indexOf(record), 1);
      byId.delete(id);
      publish({ type: 'removed', record });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return center;
}

const units = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 45) return 'Less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `About ${minutes} min left`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `About ${hours} h${rest ? ` ${rest} min` : ''} left`;
}

export interface TransferMeasure {
  doneItems: number;
  totalItems: number;
  doneBytes: number;
  totalBytes: number;
  /** Milliseconds since the bytes started moving. */
  elapsedMs: number;
  itemNoun?: [singular: string, plural: string];
}

/** Progress for anything that moves counted bytes: fraction plus one plain line. */
export function describeTransfer(measure: TransferMeasure): NotificationProgress {
  const { doneItems, totalItems, doneBytes, totalBytes, elapsedMs } = measure;
  const [singular, plural] = measure.itemNoun ?? ['file', 'files'];
  const value = totalBytes > 0 ? doneBytes / totalBytes : totalItems > 0 ? doneItems / totalItems : null;
  const parts = [`${Math.min(doneItems, totalItems)} of ${totalItems} ${totalItems === 1 ? singular : plural}`];
  if (totalBytes > 0) parts.push(`${formatBytes(doneBytes)} of ${formatBytes(totalBytes)}`);
  // A rate needs a few seconds of movement before it means anything.
  if (totalBytes > 0 && doneBytes > 0 && elapsedMs >= 3000 && doneBytes < totalBytes) {
    const rate = doneBytes / (elapsedMs / 1000);
    parts.push(formatRemaining((totalBytes - doneBytes) / rate));
  }
  return { value, label: parts.join(' · ') };
}
