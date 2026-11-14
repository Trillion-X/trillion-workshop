import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  ServiceConnectionDialog,
  type ServiceConnectionDialogProps,
} from '@/packages/service-connections/show/ServiceConnectionDialog';

export type MountedServiceConnectionDialogOptions = Omit<
  ServiceConnectionDialogProps,
  'open'
>;

/** Mount the shared package dialog inside a host that does not run Runtime Kit. */
export function mountServiceConnectionDialog(
  host: HTMLElement,
  options: MountedServiceConnectionDialogOptions,
) {
  const root = createRoot(host);
  host.dataset.sharedRoot = 'true';
  host.classList.add('ui-workspace', 'coss-ui');
  flushSync(() => root.render(<ServiceConnectionDialog open {...options} />));
  return { dispose: () => root.unmount() };
}
