// packages/ui/show/coss/notification-panel.tsx
//
// PURPOSE
// The notification center's history as a screen body: mountNotificationPanel puts the full panel (its record views:
// filters, day groups, saved views) or its compact live feed into an element. It is its own file, apart from the
// toast front door (notifications.tsx), so a page that only shows toasts never carries the panel and its record views:
// the signed-in workspace fetches this file the first time Notifications or the bell's hover feed opens
// (src/workspace/screen-mounts.ts).
//
// NON-NEGOTIABLE INVARIANTS
// 1. The panel reads the same one center the toasts use (notifications.tsx ensureNotificationHost).
// 2. The panel gets its own host node and React root, unmounted outside the arrangement's commit.
// 3. A row that throws while drawing leaves the shared failed state with Try again, never a blank window.

import {createRoot} from 'react-dom/client';
import {ensureNotificationHost} from './notifications';
import {NotificationPanel} from '../notifications/NotificationPanel';
import type {RecordViewsOptions} from '../record-views/record-views';
import {ErrorBoundary} from '../error-boundary';
import {ScreenState} from '../screen-state/ScreenState';

/**
 * Put the notification center's panel into `element` (the body of a screen, or
 * a compact live feed for a hover preview). Returns the cleanup.
 */
export function mountNotificationPanel(element: HTMLElement, {compact = false, recordFilter}: {compact?: boolean; recordFilter?: Pick<RecordViewsOptions, 'ruleOperators' | 'loadFilterRecords'>} = {}): () => void {
  const center = ensureNotificationHost();
  // The panel gets its own host node: the screen element may be emptied by its
  // owner before this cleanup runs, and a root must never share its container
  // with nodes someone else removes.
  const host = document.createElement('div');
  host.className = 'notification-center-host';
  element.append(host);
  const root = createRoot(host);
  // Screens are mounted and removed from inside the arrangement's own React
  // commit, so this root renders and unmounts outside that pass.
  // A row that throws while drawing leaves the shared failed state with Try again, never a blank window: this root is
  // its own React tree, so nothing above it would catch the error.
  root.render(
    <ErrorBoundary zoneName="notifications" fallback={(_error, retry) => (
      <ScreenState state={{status: 'failed', title: 'Your notifications could not be shown', retry: {label: 'Try again', run: retry}}} />
    )}>
      <NotificationPanel center={center} compact={compact} recordFilter={recordFilter} />
    </ErrorBoundary>,
  );
  return () => queueMicrotask(() => { root.unmount(); host.remove(); });
}
