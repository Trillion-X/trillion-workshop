import type { StatusOverrides } from '../../ui/show/status-vocabulary';

export const STRIPE_STATUS_OVERRIDES: StatusOverrides = {
  ready: { label: 'Ready', tone: 'success', isTerminal: true, isError: false },
  needs_setup: { label: 'Needs setup', tone: 'warning', isTerminal: false, isError: false },
  preparing: { label: 'Preparing checkout...', tone: 'info', isTerminal: false, isError: false },
  started: { label: 'Checkout started', tone: 'info', isTerminal: false, isError: false },
  succeeded: { label: 'Checkout started', tone: 'success', isTerminal: true, isError: false },
  expired: { label: 'Session expired', tone: 'warning', isTerminal: true, isError: false },
  failed: {
    label: 'Could not prepare checkout. Nothing was charged.',
    tone: 'error',
    isTerminal: true,
    isError: true,
  },
  offline: { label: 'Offline', tone: 'neutral', isTerminal: false, isError: false },
};
