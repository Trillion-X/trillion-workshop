'use client';

import React from 'react';

import { endAccountPortalWebSession } from '../do-work/end-browser-session';
import { readAccountPortalBrowserSession } from '../do-work/read-browser-session-state';
import { requestAccountPortalLoginLink } from '../do-work/request-login-link';
import {
  readLocalFirstRunProvenance,
  removeLocalFirstRunProvenance,
  type LocalFirstRunProvenanceMarker,
} from '../do-work/remove-local-first-run-provenance';
import {
  readAccountSession,
  type AccountSessionProjection,
} from '../read-data/read-session';
import { LoginPanel } from './LoginPanel';

export interface AccountSessionSurfaceClientProps {
  session?: Partial<AccountSessionProjection> | null;
}

export function AccountSessionSurfaceClient({
  session = null,
}: AccountSessionSurfaceClientProps) {
  const [sessionProjection, setSessionProjection] =
    React.useState<Partial<AccountSessionProjection> | null | undefined>(session ?? undefined);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionPending, setActionPending] = React.useState(false);
  const [localMarker, setLocalMarker] = React.useState<LocalFirstRunProvenanceMarker | null>(null);
  const [cleanupState, setCleanupState] =
    React.useState<'idle' | 'running' | 'success' | 'error'>('idle');

  const projection = sessionProjection === undefined ? undefined : readAccountSession(sessionProjection);
  const signedIn = projection?.status === 'signed_in';
  const scopedMarker = signedIn && localMarker?.account_scope === projection?.accountIdHash
    ? localMarker
    : null;

  const refreshLocalMarker = React.useCallback(() => {
    setLocalMarker(readLocalFirstRunProvenance());
  }, []);

  React.useEffect(() => {
    refreshLocalMarker();
    const refreshOnStorage = () => refreshLocalMarker();
    window.addEventListener('storage', refreshOnStorage);
    window.addEventListener('focus', refreshOnStorage);
    return () => {
      window.removeEventListener('storage', refreshOnStorage);
      window.removeEventListener('focus', refreshOnStorage);
    };
  }, [refreshLocalMarker]);

  const refreshSession = React.useCallback(async () => {
    const nextSession = await readAccountPortalBrowserSession();
    setSessionProjection(nextSession);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void readAccountPortalBrowserSession().then((nextSession) => {
      if (!cancelled) setSessionProjection(nextSession);
    });
    const refreshOnFocus = () => { if (!cancelled) void refreshSession(); };
    const refreshWhenVisible = () => {
      if (!cancelled && document.visibilityState === 'visible') void refreshSession();
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshSession]);

  // Preserve the exact session-authority lease boundary without introducing a poller.
  React.useEffect(() => {
    const expiresAt = projection?.sessionExpiresAtMilliseconds;
    if (!signedIn || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(() => { void refreshSession(); }, Math.max(0, expiresAt - Date.now() + 25));
    return () => window.clearTimeout(timer);
  }, [projection?.sessionExpiresAtMilliseconds, refreshSession, signedIn]);

  async function endSession() {
    setActionPending(true);
    setActionError(null);
    try {
      await endAccountPortalWebSession();
      window.location.assign('/');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[account-session] session end failed:', raw);
      setActionError('We couldn\'t end your session. Please try refreshing the page.');
      setActionPending(false);
    }
  }

  async function requestLoginLink(email: string) {
    setActionPending(true);
    setActionError(null);
    try {
      await requestAccountPortalLoginLink(email, '/account');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[account-session] login link request failed:', raw);
      setActionError('We couldn\'t send the sign-in link. Please try again or contact support.');
    } finally {
      setActionPending(false);
    }
  }

  async function removeLocalFirstRunSummary() {
    if (!signedIn || !scopedMarker || cleanupState === 'running') return;
    setCleanupState('running');
    try {
      const receipt = removeLocalFirstRunProvenance({
        schema: 'account-session.remove-local-first-run-provenance-request/owner-scoped',
        kind: 'remove-local-first-run-provenance-request',
        account_session_receipt: {
          status: 'signed_in',
          accountIdHash: projection?.accountIdHash ?? '',
        },
        anonymous_scope: 'local-operator-or-browser',
        adoption_marker_content_hash: scopedMarker.marker_content_hash,
      });
      if (receipt.account_unchanged !== true) throw new Error('account-unchanged-readback-missing');
      setLocalMarker(readLocalFirstRunProvenance());
      setCleanupState('success');
    } catch (error) {
      console.error('[account-session] local first-run cleanup failed:', error);
      setCleanupState('error');
    }
  }

  return (
    <LoginPanel
      actionError={actionError}
      actionPending={actionPending}
      session={projection}
      localFirstRunAdoptionId={scopedMarker?.adoption_id ?? null}
      localFirstRunJourneyId={scopedMarker?.journey_id ?? null}
      showLocalFirstRunCleanup={signedIn}
      localFirstRunCleanupState={cleanupState}
      onRemoveLocalFirstRunSummary={removeLocalFirstRunSummary}
      onEndSession={endSession}
      onRequestLoginLink={requestLoginLink}
    />
  );
}
