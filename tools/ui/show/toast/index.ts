// packages/ui/show/toast/index.ts
//
// PURPOSE
// The React hook shape older surfaces use (`useToastContext().showSuccess`),
// answered by the ONE shared notification center in
// show/notifications/notification-center.ts. There is no second toast state
// machine: every call here emits into the same stack and history that
// Expansion's notify() uses.
//
// NON-NEGOTIABLE INVARIANTS
// 1. No local toast state. Reads and writes go to the document's center.
// 2. ToastProvider only guarantees the shared host is mounted; nesting it or
//    mounting it on many surfaces still yields one stack.

import React, {type ReactNode} from 'react';
import {ensureNotificationHost, notificationCenter} from '../coss/notifications';
import type {NotificationRecord} from '../notifications/notification-center';
import type {ToastPosition} from '../coss/ui/toast';

export interface UseToastReturn {
  toasts: NotificationRecord[];
  addToast: (options: {message: string; kind?: string; duration?: number | null}) => string;
  showError: (message: string, duration?: number | null) => string;
  showSuccess: (message: string, duration?: number) => string;
  showWarning: (message: string, duration?: number) => string;
  showInfo: (message: string, duration?: number) => string;
  dismissToast: (id: string) => void;
  clearAll: () => void;
}

const timeoutOf = (duration?: number | null) => (duration === null ? 0 : duration);

function subscribeVisible(onChange: () => void) {
  return notificationCenter().subscribe(onChange);
}

/** Toast actions for React surfaces, backed by the shared notification center. */
export function useToastContext(): UseToastReturn {
  const center = notificationCenter();
  const toasts = React.useSyncExternalStore(subscribeVisible, () => visibleSnapshot(center));
  return React.useMemo(() => {
    const addToast: UseToastReturn['addToast'] = ({message, kind = 'info', duration}) =>
      ensureNotificationHost().emit(message, {kind, timeout: timeoutOf(duration)}).id;
    return {
      toasts,
      addToast,
      showError: (message, duration) => addToast({message, kind: 'error', duration}),
      showSuccess: (message, duration) => addToast({message, kind: 'success', duration}),
      showWarning: (message, duration) => addToast({message, kind: 'warning', duration}),
      showInfo: (message, duration) => addToast({message, kind: 'info', duration}),
      dismissToast: (id) => center.hide(id),
      clearAll: () => center.clearTransient(),
    };
  }, [center, toasts]);
}

// useSyncExternalStore needs a stable snapshot between changes.
let lastVisible: NotificationRecord[] = [];
let lastKey = '';
function visibleSnapshot(center: ReturnType<typeof notificationCenter>): NotificationRecord[] {
  const visible = center.visible();
  const key = visible.map((record) => `${record.id}:${record.revision}`).join('|');
  if (key !== lastKey) { lastKey = key; lastVisible = visible; }
  return lastVisible;
}

export interface ToastProviderProps {
  children?: ReactNode;
  /** Where the shared stack sits if this provider is the first to mount it. */
  position?: ToastPosition;
}

/** Guarantees the shared notification host exists; renders its children unchanged. */
export function ToastProvider({children, position}: ToastProviderProps) {
  React.useEffect(() => { ensureNotificationHost({position}); }, [position]);
  return React.createElement(React.Fragment, null, children);
}
