// packages/ui/show/coss/notifications.tsx
//
// PURPOSE
// The imperative front door to the shared notification center for apps that
// are not React trees (Expansion's plain scripts, other agents' code):
//
//   const handle = notify('Archived 3 recordings', {kind: 'archive',
//     actions: [{label: 'Undo', onAction: () => restore(ids)}]});
//   handle.update({progress: {value: 0.4, label: '4 of 10 files'}});
//   handle.finish({title: '10 files imported', kind: 'done'});
//
// The first call mounts one host into <body> for the stacked toasts; every
// later call reuses it. History is shown by mountNotificationPanel
// (notification-panel.tsx, its own file so a page carrying only toasts never
// carries the panel), the body of an ordinary screen that surface DATA places
// (a floating window or a tab), and
// the unread count is published on the `notifications:unread` badge channel so
// any navigation row whose DATA names that channel shows it.
//
// NON-NEGOTIABLE INVARIANTS
// 1. One center per document, shared through globalThis, so two bundles in one
//    page (shared controls, conversation) still show one stack and one history.
// 2. clearNotifications() hides settled cards only; a running transfer stays.
// 3. Coss renders; Base UI owns expiry, hover/focus pause and announcements.

import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import type {ToastPosition} from './ui/toast';
import {createNotificationCenter, type NotificationCenter, type NotificationHandle, type NotificationInput} from '../notifications/notification-center';
import {publishSurfaceBadge} from '../surface-badges/surface-badges';
import {LAYER_ORDER} from '../layer-order/layer-order';
import {onShowChange} from '../show-rules/show-of';

/** The badge channel the notification center publishes its unread count on. */
export const NOTIFICATION_UNREAD_BADGE = 'notifications:unread';

const GLOBAL_KEY = '__bitfieldNotificationCenter';
type Shared = {center: NotificationCenter; mounted: boolean};

function shared(): Shared {
  const scope = globalThis as unknown as Record<string, Shared | undefined>;
  const existing = scope[GLOBAL_KEY];
  if (existing) return existing;
  const center = createNotificationCenter();
  const publishUnread = () => {
    const unread = center.unreadCount();
    publishSurfaceBadge(NOTIFICATION_UNREAD_BADGE, unread ? {text: unread > 99 ? '99+' : String(unread), kind: 'notification'} : null);
  };
  center.subscribe(publishUnread);
  onShowChange(publishUnread);
  publishUnread();
  return (scope[GLOBAL_KEY] = {center, mounted: false});
}

/** The document's one notification center. */
export function notificationCenter(): NotificationCenter {
  return shared().center;
}

/**
 * Mount the toast stack once. Safe to call repeatedly. The
 * first caller's position wins, because a document has one stack.
 * The stack's code loads with this first call, not with the page that imports
 * notify: the center keeps every notification meanwhile, and the stack shows
 * the visible ones when it mounts.
 */
export function ensureNotificationHost({position = 'bottom-right'}: {position?: ToastPosition} = {}): NotificationCenter {
  const state = shared();
  if (state.mounted || typeof document === 'undefined') return state.center;
  state.mounted = true;
  const host = document.createElement('div');
  host.dataset.sharedNotifications = '';
  host.className = 'coss-ui';
  // Toasts sit above the stage and picture-in-picture, below dialogs and open menus (layer-order).
  host.style.setProperty('--layer-notification', String(LAYER_ORDER.notification));
  document.body.append(host);
  void import('./ui/toast').then(({ToastProvider}) => flushSync(() => createRoot(host).render(
    <ToastProvider center={state.center} position={position} limit={4} portalProps={{container: host}} />,
  )), () => {
    // The stack could not be fetched: the notifications stay in the center, and the next one asks again.
    host.remove();
    state.mounted = false;
  });
  return state.center;
}

/** Hide settled notifications (for example before a dialog opens). */
export function clearNotifications(): void {
  shared().center.clearTransient();
}

/** Show a notification. Returns a handle to update, finish or dismiss it. */
export function notify(title: string, options: NotificationInput = {}): NotificationHandle {
  return ensureNotificationHost().emit(String(title), options);
}
