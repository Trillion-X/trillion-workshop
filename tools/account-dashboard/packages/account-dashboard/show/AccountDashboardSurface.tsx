'use client';

import React from 'react';
import {
  consumeAccountDashboardUrlReturnActions,
  endAccountDashboardBrowserSession,
  readAccountDashboardSurfaceAccount,
  requestAccountDashboardLoginLink,
} from '../do-work/read-account-dashboard-surface-state';
import {
  type AccountStateProjection,
  readAccountState,
} from '../read-data/read-account-state';
import { AccountDashboard } from './AccountDashboard';

export function AccountDashboardSurface() {
  const [account, setAccount] =
    React.useState<Partial<AccountStateProjection> | null | undefined>(undefined);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionPending, setActionPending] = React.useState(false);
  const [linkSent, setLinkSent] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    async function loadAccount() {
      // A sign-in link landing (account_login=complete&token=...) must be
      // redeemed BEFORE the session read, or the dashboard renders the
      // signed-out gate and the emailed link appears to do nothing.
      const consumed = await consumeAccountDashboardUrlReturnActions();
      if (cancelled) return;
      if (consumed.error) setActionError(consumed.error);
      if (consumed.matched && !consumed.error) return;
      const nextAccount = await readAccountDashboardSurfaceAccount();
      if (!cancelled) setAccount(nextAccount);
    }
    void loadAccount();
    return () => {
      cancelled = true;
    };
  }, []);

  async function requestLoginLink(email: string) {
    setActionPending(true);
    setActionError(null);
    setLinkSent(false);
    try {
      await requestAccountDashboardLoginLink(email, '/account');
      setLinkSent(true);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[account-dashboard] login link request failed:', raw);
      setActionError('We couldn\'t send the sign-in link. Please try again or contact support.');
    } finally {
      setActionPending(false);
    }
  }

  async function endSession() {
    setActionPending(true);
    setActionError(null);
    try {
      await endAccountDashboardBrowserSession();
      setAccount(null);
      window.location.assign('/account');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[account-dashboard] session end failed:', raw);
      setActionError('We couldn\'t end your session. Please try refreshing the page.');
      setActionPending(false);
    }
  }

  return (
    <AccountDashboard
      account={account === undefined ? undefined : readAccountState(account)}
      actionError={actionError}
      actionPending={actionPending}
      linkSent={linkSent}
      onEndSession={endSession}
      onRequestLoginLink={requestLoginLink}
    />
  );
}
