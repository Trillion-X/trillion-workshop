// src/workspace/person-notifications.ts
//
// PURPOSE
//   Puts the person's notifications (GET /work/api/notifications, src/person-notifications.mjs) into the page's one
//   notification center (parts/ui/show/coss/notifications), so the bell, its panel and the Notifications screen all
//   show them. Their store is the truth: each is emitted with its own id, its time and its read state, kept (the
//   panel cannot remove it), and marking it read or unread writes the store (POST /work/api/notifications/read).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is made up here: every row is one the store answered; one the store no longer answers leaves.
//   2. What a row offers is the store's DATA: `post` sends its body to its path and reads the list again; `open`
//      opens a screen on one item. This file names no kind of notification.
//   3. The list read when the page opens goes into the center quietly; a row that arrives later, unread, shows a card.
//      Only a card that asks for an answer (an action that posts, like Accept) stays until it is answered or dismissed;
//      every other card leaves on the center's own timeout, so news never sits over the page.
//   4. The list is read again when the person's store changes (store-changes.ts), when the tab is shown again, and after
//      every action it offers.
//   5. A row whose kind says work is still going on is emitted running: it draws the one loading mark and stays under
//      In progress until the store says the work is done, while its card still leaves on the center's timeout. A control
//      on the thing a row is `about` follows it with followWork.
//   6. A row's face (who it is about) is drawn with that app's provider mark or picture (activity-providers.json and the
//      app marks the route sends); an action marked `press` is the row's own press, so the whole row opens it.
//   7. The list read when the page opens is answered from the copy this device kept, when there is one
//      (parts/ui/show/request/kept-answers.ts), and read again when the store's answer differs.
import { ensureNotificationHost } from '../../parts/ui/show/coss/notifications';
import { NOTIFICATION_TIMEOUT } from '../../parts/ui/show/notifications/notification-center';
import type { NotificationAction } from '../../parts/ui/show/notifications/notification-center';
import { postJson, readJson } from './api';
import { onKeptAnswerReplaced, readWithKeptAnswers } from '../../parts/ui/show/request/kept-answers';
import { sendQuietly } from './quiet-writes';
import { openScreen, openScreenOn } from './open-screen';
import { onStoreChange } from './store-changes';
import providerNames from './activity-providers.json';

type StoredAction = { id: string; label: string; press?: boolean; post?: { path: string; body: unknown }; open?: { surface_id: string; title?: string; input?: Record<string, unknown> } };
type StoredNotification = { id: string; kind: string; at: string; title: string; detail: string | null; chips?: { text: string; tone?: string }[]; actions: StoredAction[]; read: boolean; waiting: boolean; running: boolean; working?: boolean; about: string | null; face?: { name: string; app: string | null } | null };
type Apps = Record<string, { picture: string | null }>;

const API = '/work/api/notifications';
let shown = new Set<string>();
let first = true;
// Read marks go to the store together ("Mark all as read" is one request, not one per row), kept on this device and
// sent again by itself while the store is busy (quiet-writes.ts).
function tellStore(id: string, read: boolean) {
  sendQuietly({ key: `notification-read:${id}`, path: `${API}/read`, body: { read, ids: [id] }, together: 'ids' });
}

// Acting on a notification (Accept, Open space) is dealing with it, so it counts as read.
const actionOf = (id: string, action: StoredAction): NotificationAction => ({
  id: action.id,
  label: action.label,
  dismisses: false,
  ...(action.press ? { press: true } : {}),
  onAction: async () => {
    ensureNotificationHost().setRead(id, true);
    if (action.post) { await postJson(action.post.path, action.post.body); await readAgain(); return; }
    if (action.open?.input) openScreenOn(action.open.surface_id, action.open.input, action.open.title);
    else if (action.open) openScreen(action.open.surface_id);
  },
});

/** A row's face: the app's provider mark when it is a known one, else the app's own picture, else initials. */
const faceOf = (face: { name: string; app: string | null }, apps: Apps) => ({
  name: face.name,
  provider: face.app ? (providerNames.names as Record<string, string>)[face.app] ?? null : null,
  picture: face.app ? apps[face.app]?.picture ?? null : null,
});

/** Reads the person's notifications and brings the center in line with them. */
export async function readAgain(): Promise<void> {
  const { items, apps = {} } = await readJson<{ items: StoredNotification[]; apps?: Apps }>(API);
  const center = ensureNotificationHost();
  const now = new Set(items.map(item => item.id));
  for (const id of shown) if (!now.has(id)) center.forget(id);
  for (const item of [...items].reverse()) {
    center.emit(item.title, {
      id: item.id, kind: item.kind, at: Date.parse(item.at), read: item.read, kept: true, timeout: item.actions.some(action => action.post) ? 0 : NOTIFICATION_TIMEOUT,
      running: item.running, working: Boolean(item.working), ...(item.about ? { about: item.about } : {}),
      ...(item.face ? { face: faceOf(item.face, apps) } : {}),
      toast: !first && !item.read && !shown.has(item.id),
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.chips?.length ? { chips: item.chips } : {}),
      actions: item.actions.map(action => actionOf(item.id, action)),
      onRead: read => tellStore(item.id, read),
    });
  }
  shown = now;
  first = false;
}

/** Starts keeping the center in line with the person's notifications; answers the function that stops it. */
export function keepPersonNotifications(): () => void {
  const read = () => readAgain().catch(() => {});
  // The first read answers from the list this device kept when there is one, so the bell and Notifications draw at
  // once whatever the store's speed; when the store answers it differently, the list is read again (invariant 7).
  void readWithKeptAnswers(readAgain).catch(() => {});
  const replaced = onKeptAnswerReplaced(path => { if (path === API) void read(); });
  const shownAgain = () => { if (document.visibilityState === 'visible') void read(); };
  document.addEventListener('visibilitychange', shownAgain);
  const stop = onStoreChange(read);
  return () => { stop(); replaced(); document.removeEventListener('visibilitychange', shownAgain); };
}

/** Follows the work the person's notifications say is `about` one thing (a press that asked an AI for a job): calls
 *  `done` once, when a notification about it says the work is no longer going on, or when the ones there were are gone
 *  (the job was dropped). Answers the function that stops following. */
export function followWork(about: string, done: () => void): () => void {
  const center = ensureNotificationHost();
  let seen = false;
  let stop = () => {};
  const look = () => {
    const records = center.history().filter(record => record.about === about);
    if (records.length) seen = true;
    if (!(records.some(record => !record.running) || (seen && !records.length))) return;
    stop();
    done();
  };
  stop = center.subscribe(look);
  look();
  return () => stop();
}
