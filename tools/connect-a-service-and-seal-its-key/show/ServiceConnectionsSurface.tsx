// packages/service-connections/show/ServiceConnectionsSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Service connections catalog surface. Reference anatomy (Mobbin): Langdock
// integrations (search + responsive tile grid + section headers) + monday.com
// integrations center (category rail) + Zapier add-connection (search-first
// open catalog) + Revolut "Don't see yours?" add-your-own row. Tiles flow in
// a responsive auto-fill grid — the column count follows container width, so
// an unbounded catalog stays scannable. The catalog is never a fixed list:
// any typed name and the standing add-your-own row connect through the
// synthesized generic config.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Reads connection records + service configs from package data; routes
//    connect/disconnect intents to service-connections do-work files
// 2. Search is the primary entry; category pills + sort are secondary
// 3. Connect success reflects IMMEDIATELY and REACTIVELY: writing the
//    connection facts fires the on-change trigger, which re-runs
//    publish-service-connections; the subscribed value address advances and
//    this surface re-renders the tile as Connected. No optimistic overlay —
//    the rendered grid IS the live canonical truth, plus a success toast.
// 4. Empty states carry an icon and a next action, never a bare sentence
// 5. Zero storage mechanics in visible copy
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  Button,
  Card,
  Container,
  DisplayMark,
  Dropdown,
  EmptyPlaceholder,
  Icon,
  Input,
  SegmentedControl,
  SelectablePillBar,
  Text,
  type ProviderIconRegistryRow,
  useToastContext,
} from '@/packages/ui';
import { Cable, Plug, Plus, Search } from 'lucide-react';
import {
  deriveConnectionInstanceId,
  deriveCustomServiceVendor,
  readServiceConnectionOptions,
  resolveServiceAuthConfig,
  type ServiceConnectionTarget,
  type ServiceAuthorizationMethod,
  type ServiceCredentialSubmission,
} from '@/packages/service-connections/read-data/read-service-connection-options';
import {
  readServiceConnectionReadinessView,
  type ServiceConnectionReadinessView,
} from '@/packages/service-connections/read-data/read-service-connection-readiness-view';
import { connectService } from '@/packages/service-connections/do-work/connect-service';
import { beginAcquisition } from '@/packages/service-connections/do-work/begin-acquisition';
import {
  beginSessionAcquisition,
  isSessionAcquire,
} from '@/packages/service-connections/do-work/begin-session-acquisition';
import {
  sealSessionAcquisition,
} from '@/packages/service-connections/do-work/seal-session-acquisition';
import {
  beginShellRedirectAcquisition,
  completeShellRedirectAcquisition,
  isShellRedirectAcquire,
  stripShellRedirectQuery,
} from '@/packages/service-connections/do-work/shell-redirect-acquisition';
import { readEntryContextFromLocation } from '@/packages/ui';
import {
  createAcquireChallengeFold,
  readAcquireChallengeFeed,
  readAcquireEventStreamAddress,
  type AcquireChallenge,
  type AcquireFeedView,
} from '@/packages/service-connections/read-data/read-acquire-challenge-events';
import { disconnectService } from '@/packages/service-connections/do-work/disconnect-service';
import { renameServiceConnection } from '@/packages/service-connections/do-work/rename-service-connection';
import {
  revealServiceConnectionCredentials,
  type RevealedServiceCredentialField,
} from '@/packages/service-connections/do-work/reveal-service-connection-credential';
import { decodeConnectionRows } from '@/packages/service-connections/read-data/read-service-connections';
import { ServiceConnectionCard } from '@/packages/service-connections/show/ServiceConnectionCard';
import { ServiceConnectionDialog, type ServiceAcquireOutcome } from '@/packages/service-connections/show/ServiceConnectionDialog';
import type { ConnectedAccountView } from '@/packages/service-connections/show/ConnectedAccountsSection';

// ---------------------------------------------------------------------------
// SORTS — data-driven comparator table; adding a sort = one entry
// ---------------------------------------------------------------------------

const SORT_ITEMS = [
  { value: 'a-z', label: 'A to Z' },
  { value: 'z-a', label: 'Z to A' },
  { value: 'category', label: 'By category' },
  { value: 'recent', label: 'Recently connected' },
] as const;

type SortId = (typeof SORT_ITEMS)[number]['value'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function chosenProviderRef(value: unknown): string | null {
  const providerRef = asRecord(value)?.provider_ref;
  return typeof providerRef === 'string' && providerRef.trim() ? providerRef.trim() : null;
}

const SORT_COMPARATORS: Record<
  SortId,
  (a: ServiceConnectionReadinessView, b: ServiceConnectionReadinessView) => number
> = {
  'a-z': (a, b) => a.serviceName.localeCompare(b.serviceName),
  'z-a': (a, b) => b.serviceName.localeCompare(a.serviceName),
  category: (a, b) =>
    (a.category || 'zzz').localeCompare(b.category || 'zzz') || a.serviceName.localeCompare(b.serviceName),
  recent: (a, b) =>
    (b.connectedAt ?? '').localeCompare(a.connectedAt ?? '') || a.serviceName.localeCompare(b.serviceName),
};

function matchesQuery(connection: ServiceConnectionReadinessView, query: string): boolean {
  if (!query) return true;
  const haystack =
    `${connection.serviceName} ${connection.serviceVendor} ${connection.purpose} ${connection.category}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((token) => haystack.includes(token));
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export interface ServiceConnectionsSurfaceProps {
  /** When a caller opens this catalog focused on one channel (e.g. chat's
   *  People-rail "+" for iMessage), the catalog opens pre-filtered to it by
   *  seeding the existing search. The query matches serviceVendor, so the
   *  vendor id is sufficient. Empty = the full catalog (default). */
  initialQuery?: string;
  /** Optional caller-selected category scope. The normal settings surface omits
   * this and shows the complete catalog; focused journeys such as choosing an
   * AI pass the category as DATA instead of rendering a second catalog. */
  initialCategories?: readonly string[];
  /** Open presentation mode supplied by the caller. The onboarding journey uses
   * this to show live discovery state instead of dropping the person into the
   * full settings catalog. Unknown values keep the normal catalog. */
  presentation?: string;
  /** Explicit caller intent to make current discovery progress visible. */
  showDiscoveryProgress?: boolean;
  /** Workflow action that owns provider-choice persistence. */
  providerChoiceActionRef?: string;
}

export function ServiceConnectionsSurface({
  initialQuery,
  initialCategories = [],
  presentation,
  showDiscoveryProgress = false,
  providerChoiceActionRef,
}: ServiceConnectionsSurfaceProps = {}) {
  const serviceConnectionsEntry = useBitfieldData();
  // Catalog tiles come LIVE from the SCOPED `sc-catalog-feed`
  // (record_from_matching_records over payload.kind === service-connection-descriptor),
  // NOT the shared `published-records` aggregate. The aggregate re-materializes the
  // ENTIRE studio's ~11.6MB/5916-record log (task/action/exhaust the catalog never
  // renders) on the single engine thread, so subscribing to it made this tab blank
  // for seconds while every unrelated surface's read queued behind it (L126). The
  // scoped feed delivers only the ~30 descriptor rows — instant render. Adding a
  // provider is still a live log write that appears instantly (the feed re-projects).
  const catalogFeedEntry = useBitfieldData('sc-catalog-feed');
  // Brand marks use their own bounded, kind-scoped feed. The surface passes
  // raw self-describing registry rows to the shared ProviderMark renderer and
  // never branches on provider identity.
  const providerIconRegistryFeedEntry = useBitfieldData('provider-icon-registry-feed');
  const chosenProviderEntry = useBitfieldData('chosen-ai-provider');
  const { showSuccess, showError } = useToastContext();
  const serviceConnectionConfigs = readServiceConnectionOptions(catalogFeedEntry);
  const providerIconRegistry = Array.isArray(providerIconRegistryFeedEntry)
    ? providerIconRegistryFeedEntry as ProviderIconRegistryRow[]
    : [];

  const [query, setQuery] = useState(initialQuery ?? '');
  const [selectedCategories, setSelectedCategories] = useState<readonly string[]>(initialCategories);
  const [stateFilter, setStateFilter] = useState('all');
  const [sort, setSort] = useState<SortId>('a-z');
  const [activeVendor, setActiveVendor] = useState<string | null>(null);
  const [customServiceName, setCustomServiceName] = useState<string | null>(null);
  const [choosingProvider, setChoosingProvider] = useState<string | null>(null);
  // Session-backed acquire (WhatsApp pairing / QR / device code): the running
  // acquire session's event-feed address. Non-null while a live connect session
  // is in flight; the feed subscription below turns its stdout into the
  // dialog's liveChallenge (Codex-converged design — plan §9).
  const [acquireFeedAddress, setAcquireFeedAddress] = useState<string | null>(null);
  // The last acquire FAILURE message, persisted in surface state. The failure
  // effect drops the live feed on error (so the stale code clears), which also
  // makes the transient `acquireFeedView.error` vanish next render — so the
  // human-facing cause is captured HERE and handed to the dialog, which then
  // leaves its "Starting…" state and offers a retry (Q3). Cleared on a fresh
  // launch and on close.
  const [acquireError, setAcquireError] = useState<string | null>(null);
  // Seal context captured AT LAUNCH (the dialog may close before the session
  // completes): which acquire descriptor + connection target the running
  // session belongs to, so the completion effect below can write the facts
  // without depending on still-open dialog state.
  const acquireSealContext = useRef<{
    acquire: Record<string, unknown>;
    connection: ServiceConnectionTarget;
  } | null>(null);
  // One-shot guard: a feed keeps its completion line forever — seal exactly
  // once per session feed address.
  const sealedFeedAddress = useRef<string | null>(null);

  // The feed is a PURE PROJECTION of the subscribed canonical facts. When a
  // connection's facts change, the reactive on-change trigger re-runs
  // publish-service-connections, the subscribed `service-connections` value
  // address advances, and useBitfieldData re-renders this surface — instantly,
  // with NO optimistic overlay and NO mount-time reconcile. The render IS the
  // live truth; there is no second source of truth to keep in sync.
  const serviceConnections = useMemo(
    () =>
      readServiceConnectionReadinessView(
        serviceConnectionsEntry,
        serviceConnectionConfigs,
      ),
    [serviceConnectionsEntry, serviceConnectionConfigs],
  );

  // Live acquire feed: subscribe the in-flight connect session's event feed
  // (same input mechanism the terminal uses) and fold its stdout through the
  // pure challenge lens. No session in flight -> empty subscription, null
  // challenge. When the feed reports finished, the subscription is dropped so
  // a stale code can never linger (the lens also clears on completion lines).
  const acquireFeedsEntry = useBitfieldData({
    input: 'liveProcessSessionEventFeeds',
    params: { eventAddresses: acquireFeedAddress ? [acquireFeedAddress] : [] },
  });
  // V2 feed contract: the feed address may serve a constant-size HEAD whose
  // event_stream_address names the per-event delta stream. Discover it and
  // subscribe alongside; V1 payloads carry events inline (null stream address).
  const acquireStreamAddress = useMemo(() => {
    if (!acquireFeedAddress || !Array.isArray(acquireFeedsEntry)) return null;
    const feed = (acquireFeedsEntry as Array<{ address?: string; data?: Uint8Array }>)
      .find((entry) => entry?.address === acquireFeedAddress);
    if (!feed?.data) return null;
    return readAcquireEventStreamAddress(feed.data);
  }, [acquireFeedAddress, acquireFeedsEntry]);
  const acquireStreamsEntry = useBitfieldData({
    input: 'liveProcessSessionEventFeeds',
    params: { eventAddresses: acquireStreamAddress ? [acquireStreamAddress] : [] },
  });
  // One stateful fold per acquire session: V3 deltas accumulate stdout across
  // updates (a full feed re-runs through a fresh fold each render, so V1
  // behavior is unchanged — the fold sees the whole history every time).
  const acquireFoldRef = useRef<{ address: string; fold: (p: Uint8Array) => AcquireFeedView } | null>(null);
  const acquireFeedView = useMemo(() => {
    if (!acquireFeedAddress || !Array.isArray(acquireFeedsEntry)) return null;
    const feed = (acquireFeedsEntry as Array<{ address?: string; data?: Uint8Array }>)
      .find((entry) => entry?.address === acquireFeedAddress);
    if (!feed?.data) return null;
    if (!acquireStreamAddress) {
      // V1 full feed — the one-shot lens over the whole inline history.
      return readAcquireChallengeFeed(feed.data);
    }
    // V2 — fold the delta stream statefully, keyed by this session's feed.
    if (acquireFoldRef.current?.address !== acquireFeedAddress) {
      acquireFoldRef.current = { address: acquireFeedAddress, fold: createAcquireChallengeFold() };
    }
    const streamPayload = Array.isArray(acquireStreamsEntry)
      ? (acquireStreamsEntry as Array<{ address?: string; data?: Uint8Array }>)
          .find((entry) => entry?.address === acquireStreamAddress)?.data
      : undefined;
    // Fold the latest delta (output bytes) BEFORE the head (state
    // transitions): the head's event cursor is the stream's LAST number, so
    // folding it first would advance past — and silently drop — an output
    // delta that hasn't been folded yet. Replayed events are skipped inside
    // the fold, so re-folding either payload is harmless.
    const fold = acquireFoldRef.current.fold;
    if (streamPayload) fold(streamPayload);
    return fold(feed.data);
  }, [acquireFeedAddress, acquireFeedsEntry, acquireStreamAddress, acquireStreamsEntry]);
  const liveChallenge: AcquireChallenge | null = acquireFeedView?.challenge ?? null;

  // SHELL-RECEIVED REDIRECT → SEAL: a provider that sent the browser back to
  // this origin with `?code=` lands here on mount. The stored attempt (written
  // before leaving) proves this browser started it; the exchange runs inside
  // the workflow; the facts write flips the tile through the reactive feed.
  // No dialog state is needed on return, so this runs once, on mount, and
  // strips the query so a reload cannot replay it. Selected by DATA presence
  // (a stored attempt), never by vendor.
  const shellRedirectHandled = useRef(false);
  useEffect(() => {
    if (shellRedirectHandled.current || typeof window === 'undefined') return;
    shellRedirectHandled.current = true;
    const query = readEntryContextFromLocation(window.location).query ?? {};
    if (!query.code && !query.error) return;
    const existingIds = new Set(
      serviceConnections.filter((row) => row.status === 'connected').map((row) => row.id),
    );
    void (async () => {
      try {
        const completion = await completeShellRedirectAcquisition({ query, existingConnectionIds: existingIds });
        stripShellRedirectQuery();
        if (completion) showSuccess(`${completion.accountLabel} connected.`);
      } catch (error) {
        stripShellRedirectQuery();
        const raw = error instanceof Error ? error.message : String(error);
        console.error('[service-connections] shell redirect failed:', raw);
        showError(raw);
      }
    })();
  // Mount-only by design: the query is consumed once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // COMPLETION → SEAL: when the running acquire session reports finished with
  // a completion line, fold it through the descriptor's declared outcome paths
  // and write the connection facts (fail closed: an unpaired exit writes
  // nothing). The fact write fires the reactive publish trigger — the tile
  // flips to Connected with no optimistic overlay (invariant 3). One-shot per
  // feed address; the subscription is dropped after sealing.
  useEffect(() => {
    if (!acquireFeedView?.finished) return;
    if (!acquireFeedAddress || sealedFeedAddress.current === acquireFeedAddress) return;
    const context = acquireSealContext.current;
    if (!context) return;
    // Some authorization checks are intentionally non-interactive: the DATA
    // runs a status command in process-session and declares the exact outcome
    // a clean exit proves. This keeps local CLI authorization generic without
    // parsing provider-specific stdout or reading credential files.
    const completion = acquireFeedView.completion
      ?? (acquireFeedView.exitCode === 0
        ? asRecord(context.acquire.cleanExitCompletion)
        : null);
    if (!completion) return;
    sealedFeedAddress.current = acquireFeedAddress;
    void (async () => {
      try {
        const accountLabel = await sealSessionAcquisition({
          acquire: context.acquire,
          completion,
          connection: context.connection,
          existingConnectionIds: serviceConnections
            .filter((row) => row.status === 'connected')
            .map((row) => row.id),
        });
        if (accountLabel) {
          showSuccess(`${accountLabel} connected.`);
          // Pairing sealed — close the dialog so it doesn't linger showing the
          // challenge. Called via the stable useState setters (NOT closeDialog,
          // which is declared later in render order — referencing it in this
          // effect's deps would hit the render-time TDZ trap).
          setActiveVendor(null);
          setCustomServiceName(null);
        } else {
          showError('The connect session ended without pairing. Try again.');
        }
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error); console.error("[service-connections] failed:", raw); showError('Could not finish connecting.');
      } finally {
        setAcquireFeedAddress(null);
        acquireSealContext.current = null;
      }
    })();
  }, [acquireFeedView, acquireFeedAddress, serviceConnections, showSuccess, showError]);

  // FAILURE → RELEASE (Q3): when the running acquire session reports finished
  // with an error (an error line, or a non-zero exit with no completion), the
  // interactive step failed. Surface the cause and DROP the live subscription
  // so the dialog leaves the challenge state and returns to a retry-able field
  // view — a failed pairing must always be escapable, never a frozen stale
  // code. Guarded one-shot per feed address (shared with the seal guard so the
  // two terminal effects never both fire for one session).
  useEffect(() => {
    if (!acquireFeedView?.finished || !acquireFeedView.error) return;
    if (!acquireFeedAddress || sealedFeedAddress.current === acquireFeedAddress) return;
    sealedFeedAddress.current = acquireFeedAddress;
    // Persist the cause in surface state FIRST: dropping the feed below makes
    // the transient acquireFeedView.error vanish next render, so the dialog
    // needs the message from here to leave "Starting…" and offer a retry.
    setAcquireError(acquireFeedView.error);
    showError(acquireFeedView.error);
    setAcquireFeedAddress(null);
    acquireSealContext.current = null;
  }, [acquireFeedView, acquireFeedAddress, showError]);

  // FINISHED-WITHOUT-OUTCOME → RELEASE (Q3, category close): a session can end
  // (`finished`) carrying NEITHER a completion NOR an error — e.g. a clean exit
  // that never paired and never reported why. The real connector shells always
  // emit `summary` (seal) or fail non-zero (error), so this is the defensive
  // tail; without it such a session would leave the feed subscribed and the
  // dialog frozen on "Starting…". L063: ANY finished session must release the
  // dialog. Same one-shot guard so it never double-fires with seal/error.
  useEffect(() => {
    if (!acquireFeedView?.finished) return;
    if (acquireFeedView.completion || acquireFeedView.error) return; // handled above
    if (!acquireFeedAddress || sealedFeedAddress.current === acquireFeedAddress) return;
    sealedFeedAddress.current = acquireFeedAddress;
    setAcquireError('The connect session ended without pairing. Please try again.');
    setAcquireFeedAddress(null);
    acquireSealContext.current = null;
  }, [acquireFeedView, acquireFeedAddress]);

  // Category pills derive from the data — a new category in the records is a
  // new pill with zero code changes.
  const categoryItems = useMemo(() => {
    const labels = [...new Set(serviceConnections.map((row) => row.category).filter(Boolean))].sort();
    return labels.map((label) => ({ id: label, label }));
  }, [serviceConnections]);

  const providerChoice = presentation === 'provider-choice';
  const onboardingAuthorization = presentation === 'onboarding-authorization';
  const selectedProviderRef = chosenProviderRef(chosenProviderEntry);
  const visibleConnections = useMemo(() => {
    const categorySet = new Set(selectedCategories);
    return serviceConnections
      .filter((connection) => {
        if (onboardingAuthorization && connection.serviceVendor !== selectedProviderRef) return false;
        const isConnected = connection.status === 'connected';
        if (stateFilter === 'connected' && !isConnected) return false;
        if (stateFilter === 'not-connected' && isConnected) return false;
        if (categorySet.size > 0 && !categorySet.has(connection.category)) return false;
        return matchesQuery(connection, query.trim());
      })
      .sort(SORT_COMPARATORS[sort]);
  }, [serviceConnections, selectedCategories, stateFilter, query, sort, onboardingAuthorization, selectedProviderRef]);

  const connectedRows = providerChoice
    ? []
    : visibleConnections.filter((connection) => connection.status === 'connected');
  const availableRows = providerChoice
    ? visibleConnections
    : visibleConnections.filter((connection) => connection.status !== 'connected');
  const onboardingDiscovery = presentation === 'onboarding-discovery' && showDiscoveryProgress;
  const allConnectedRows = serviceConnections.filter((connection) => connection.status === 'connected');
  const attentionRows = serviceConnections.filter((connection) =>
    connection.status === 'error' || connection.status === 'pending',
  );

  // The any-service path: a typed name with no exact match is connectable
  // through the synthesized generic config.
  const trimmedQuery = query.trim();
  const hasExactMatch = serviceConnections.some(
    (connection) => connection.serviceName.toLowerCase() === trimmedQuery.toLowerCase(),
  );
  const customVendor = customServiceName ? deriveCustomServiceVendor(customServiceName) : null;

  const activeConnection = activeVendor
    ? serviceConnections.find((connection) => connection.serviceVendor === activeVendor) ?? null
    : null;
  const dialogVendor = customVendor ?? activeConnection?.serviceVendor ?? null;
  const dialogName = customServiceName ?? activeConnection?.serviceName ?? null;
  const dialogConfig = dialogVendor
    ? resolveServiceAuthConfig(serviceConnectionConfigs, dialogVendor, dialogName ?? dialogVendor)
    : null;

  // The dialog's dynamic connected-accounts list: every REAL connected
  // instance of the open service, from the SAME live readiness view the grid
  // renders — no extra subscription, no second decode (L126/SSOT). Reactivity
  // is free: a rename/disconnect fact-write re-projects the feed, this memo
  // recomputes, and the open dialog's list updates in place.
  const dialogExistingAccounts = useMemo((): ConnectedAccountView[] => {
    if (!dialogVendor) return [];
    return serviceConnections
      // Connected instances AND failed ones ("error") — a failed account is a
      // real instance the owner needs to see and fix, not a catalog tile. The
      // never-connected catalog rows ('disconnected') stay out: they are offers,
      // not accounts (L117 — only real instances render).
      .filter(
        (row) =>
          row.serviceVendor === dialogVendor
          && (row.status === 'connected' || row.status === 'error'),
      )
      .map((row) => ({
        id: row.id,
        accountLabel: row.accountLabel,
        connectedAt: row.connectedAt,
        status: row.status,
      }));
  }, [dialogVendor, serviceConnections]);

  // Per-instance rename: writes ONLY the accountLabel fact through the same
  // owner write-door as connect/disconnect; the reactive feed re-projects and
  // both the grid tile and the open dialog's list update — no optimistic state.
  const handleRenameAccount = useCallback(async (connectionId: string, accountLabel: string) => {
    await renameServiceConnection(connectionId, accountLabel);
    showSuccess('Account label saved.');
  }, [showSuccess]);

  // Per-instance disconnect: scoped to ONE instance id — the vendor's other
  // accounts are untouched (disconnectService already writes instance-scoped
  // stopped facts).
  const handleDisconnectAccount = useCallback(async (connectionId: string) => {
    const connection = serviceConnections.find((row) => row.id === connectionId);
    await disconnectService({
      connectionId,
      stoppedEffects: connection?.stateEffects?.stopped,
      conversationSourceTemplates: connection?.conversationSourceTemplates,
    });
    showSuccess('Account disconnected.');
  }, [serviceConnections, showSuccess]);

  // Owner-gated reveal: look up the instance's credential refs from the RAW
  // connection rows (refs are decode-layer vocabulary — the readiness view is
  // deliberately ref-free (L098), so the ref lookup happens HERE, at the
  // boundary, and only the resolved plaintext fields cross into the UI).
  // Read-only vault path: mint a one-time handle + resolve — never a write,
  // never through a workflow action (the sealing invariant is untouched).
  const handleRevealAccountCredentials = useCallback(
    async (connectionId: string): Promise<RevealedServiceCredentialField[]> => {
      const rawRow = decodeConnectionRows(serviceConnectionsEntry)
        .find((row) => row.id === connectionId);
      if (!rawRow) throw new Error('This account is no longer in the live feed.');
      return revealServiceConnectionCredentials(rawRow.credentialHandleRefs);
    },
    [serviceConnectionsEntry],
  );

  const closeDialog = useCallback(() => {
    setActiveVendor(null);
    setCustomServiceName(null);
    // Closing the dialog is an explicit ABORT of any in-flight acquire (Q3).
    // Drop the live-session subscription and clear the seal context so a
    // hung/failed connect can NEVER trap the surface: a truly stuck process
    // emits no completion/error line, so `finished` stays false and the stale
    // challenge would otherwise persist across a reopen with Continue disabled.
    // The user reopening the dialog starts a clean attempt; the orphaned
    // process self-terminates on its idle timeout. The happy path still seals —
    // the completion effect fires while the dialog is open, before any close.
    setAcquireFeedAddress(null);
    acquireSealContext.current = null;
    sealedFeedAddress.current = null;
    setAcquireError(null);
  }, []);

  const handleConnect = useCallback((serviceVendor: string) => {
    setCustomServiceName(null);
    setActiveVendor(serviceVendor);
  }, []);

  const handleChooseProvider = useCallback(async (connection: ServiceConnectionReadinessView) => {
    if (!providerChoiceActionRef || choosingProvider) return;
    setChoosingProvider(connection.serviceVendor);
    try {
      await sendRequestToBitfieldTarget({
        target: 'slot::workflow',
        payload: {
          operation: 'execute_definition',
          definition_id: providerChoiceActionRef,
          include_steps: false,
          include_output: true,
          input: { provider_ref: connection.serviceVendor },
        },
      });
      showSuccess(`${connection.serviceName} selected.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[service-connections] provider choice failed:', raw);
      showError('Could not save that choice. Try again.');
      setChoosingProvider(null);
    }
  }, [choosingProvider, providerChoiceActionRef, showError, showSuccess]);

  const handleConnectCustom = useCallback((serviceName: string) => {
    setActiveVendor(null);
    setCustomServiceName(serviceName);
  }, []);

  const handleDisconnect = useCallback(async (connection: ServiceConnectionReadinessView) => {
    try {
      // disconnectService writes the stopped facts; the on-change trigger
      // re-projects the feed and the subscribed value re-renders this surface.
      await disconnectService({
        connectionId: connection.id,
        stoppedEffects: connection.stateEffects?.stopped,
        conversationSourceTemplates: connection.conversationSourceTemplates,
      });
      showSuccess(`${connection.serviceName} disconnected.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error); console.error("[service-connections] failed:", raw); showError('Could not disconnect. Try again.');
    }
  }, [showSuccess, showError]);

  const handleAuthenticate = useCallback(async (credential: ServiceCredentialSubmission) => {
    // Identity = instance. Re-connecting a disconnected row reuses ITS id;
    // adding an account to an already-connected vendor mints a fresh
    // instance id (first account keeps the historical singleton id).
    // "Existing" means already-CONNECTED instances — not the catalog's available
    // tiles, whose id (service_connection:<vendor>) would collide with the
    // first minted instance id.
    const existingIds = new Set(
      serviceConnections.filter((row) => row.status === 'connected').map((row) => row.id),
    );
    const reuseId = activeConnection && activeConnection.status !== 'connected'
      ? activeConnection.id
      : deriveConnectionInstanceId(credential.serviceVendor, credential.serviceName, existingIds);
    // The write target is ref-free: connectService reads only identity + scopes
    // + environments. Re-connecting a disconnected row reuses ITS id; a fresh
    // account mints a new instance id. A ServiceConnectionReadinessView is a
    // superset of ServiceConnectionTarget, so the reconnect branch assigns
    // directly.
    const connection: ServiceConnectionTarget =
      activeConnection && activeConnection.status !== 'connected'
        ? activeConnection
        : {
            id: reuseId,
            serviceName: credential.serviceName,
            serviceVendor: credential.serviceVendor,
            scopes: [],
          };

    // Honest connect: the record's declared check runs inside connectService —
    // a rejected key throws (the dialog shows the cause) and NOTHING flips.
    // The package-owned HTTP check runs before connection facts are written.
    const resolvedConfig = resolveServiceAuthConfig(
      serviceConnectionConfigs,
      credential.serviceVendor,
      credential.serviceName,
    );
    const authorizationMethod = resolvedConfig.authorizationMethods?.find(
      (method) => method.id === credential.authorizationMethodId,
    );
    const outcome = await connectService({
      connection: {
        ...connection,
        ...(resolvedConfig.stateEffects ? { stateEffects: resolvedConfig.stateEffects } : {}),
        ...(resolvedConfig.conversationSourceTemplates?.length
          ? { conversationSourceTemplates: resolvedConfig.conversationSourceTemplates }
          : {}),
      },
      credential,
      verifyRequest: authorizationMethod?.verifyRequest ?? resolvedConfig.verifyRequest,
    });
    // The reactive feed re-projects from the facts connectService wrote — this
    // tile flips to Connected ONLY when a real usable state was written, never
    // optimistically. Three honest outcomes:
    //   verified            -> the service accepted the key (Connected).
    //   savedUnverified     -> a secret was stored but nothing proved it works;
    //                          the tile stays NOT connected until a live check.
    //   neither             -> no secret to check; saved and usable.
    showSuccess(
      outcome.verified
        ? `${credential.serviceName} connected — the service accepted your key.`
        : outcome.savedUnverified
          ? `${credential.serviceName} saved, but not connected yet — it needs a live sign-in to verify your details before it can be used.`
          : `${credential.serviceName} saved.`,
    );
  }, [activeConnection, serviceConnectionConfigs, showSuccess]);

  // Interactive-acquire path (the `acquire` facet): dispatch the acquisition
  // process via the workflow slot, then flip the tile. The dialog renders the
  // "Continue with …" affordance; this handler never sees a token (the process
  // seals it in credentials-vault and returns only the account label).
  const handleAcquire = useCallback(async (
    fields: Record<string, string> = {},
    authorizationMethod?: ServiceAuthorizationMethod,
  ): Promise<ServiceAcquireOutcome> => {
    const selectedAcquire = authorizationMethod?.acquire ?? dialogConfig?.acquire;
    if (!dialogConfig || !selectedAcquire || !dialogVendor) {
      throw new Error('This service is not set up for one-click connect.');
    }
    // SHELL-RECEIVED REDIRECT (redirect.transport: "shell", DATA presence): this
    // window IS the browser the provider will send the user back to. Remember
    // the attempt, leave for the provider's consent page, and let the mount
    // effect above finish the connection when the redirect returns. No child
    // process, no loopback listener, no container.
    if (isShellRedirectAcquire(selectedAcquire)) {
      await beginShellRedirectAcquisition({
        acquire: selectedAcquire,
        connection: {
          id: `service_connection:${dialogVendor}`,
          serviceName: dialogName ?? dialogConfig.name,
          serviceVendor: dialogVendor,
          scopes: dialogConfig.defaultScopes ?? [],
          ...(dialogConfig.stateEffects ? { stateEffects: dialogConfig.stateEffects } : {}),
          ...(dialogConfig.conversationSourceTemplates?.length
            ? { conversationSourceTemplates: dialogConfig.conversationSourceTemplates }
            : {}),
        },
        origin: window.location.origin,
      });
      return {}; // the page is navigating away; nothing to show
    }
    // SESSION-BACKED acquire (acquire.session: true — DATA presence, no vendor
    // branch): launch the process as a live session and subscribe its event
    // feed; the challenge (pairing code / QR) streams into the dialog via
    // liveChallenge while the process waits for the user. The connection facts
    // are written by the completion path when the session reports paired; the
    // reactive feed flips the tile — same no-optimistic-flip contract as below.
    // `fields` carries the dialog's pre-launch NON-secret inputs (a pairing
    // phone) for argv `{field}` substitution.
    if (isSessionAcquire(selectedAcquire)) {
      const start = await beginSessionAcquisition(
        selectedAcquire as unknown as Record<string, unknown>,
        fields,
      );
      // Capture the seal context BEFORE exposing the feed — the completion
      // effect reads it even if the dialog closes while the session runs.
      acquireSealContext.current = {
        acquire: selectedAcquire as unknown as Record<string, unknown>,
        connection: {
          id: `service_connection:${dialogVendor}`,
          serviceName: dialogName ?? dialogConfig.name,
          serviceVendor: dialogVendor,
          scopes: dialogConfig.defaultScopes ?? [],
          ...(dialogConfig.stateEffects ? { stateEffects: dialogConfig.stateEffects } : {}),
          ...(dialogConfig.conversationSourceTemplates?.length
            ? { conversationSourceTemplates: dialogConfig.conversationSourceTemplates }
            : {}),
        },
      };
      sealedFeedAddress.current = null;
      setAcquireError(null); // a fresh attempt clears any prior failure message
      setAcquireFeedAddress(start.eventFeedAddress);
      return {}; // no account label yet — the challenge card takes over
    }
    // "Existing" means already-CONNECTED instances — not the catalog's available
    // tiles, whose id (service_connection:<vendor>) would collide with the
    // first minted instance id.
    const existingIds = new Set(
      serviceConnections.filter((row) => row.status === 'connected').map((row) => row.id),
    );
    // beginAcquisition derives the real instance id from the obtained account
    // label (multi-account); the id here is a placeholder it overrides.
    const connection: ServiceConnectionTarget = {
      id: `service_connection:${dialogVendor}`,
      serviceName: dialogName ?? dialogConfig.name,
      serviceVendor: dialogVendor,
      scopes: dialogConfig.defaultScopes ?? [],
      ...(dialogConfig.stateEffects ? { stateEffects: dialogConfig.stateEffects } : {}),
      ...(dialogConfig.conversationSourceTemplates?.length
        ? { conversationSourceTemplates: dialogConfig.conversationSourceTemplates }
        : {}),
      ...(dialogConfig.environments?.length ? { environments: dialogConfig.environments } : {}),
    };
    const outcome = await beginAcquisition({
      connection,
      acquire: selectedAcquire,
      existingConnectionIds: existingIds,
      environments: dialogConfig.environments,
    });
    // The acquisition process sealed the credential in the vault and wrote the
    // connection facts; the on-change trigger re-projects the feed and the
    // subscribed value re-renders this tile as Connected — no optimistic flip.
    showSuccess(`${outcome.account_label} connected.`);
    return { accountLabel: outcome.account_label };
  }, [dialogConfig, dialogVendor, dialogName, serviceConnections, showSuccess]);

  const renderTile = (connection: ServiceConnectionReadinessView) => (
    <ServiceConnectionCard
      key={connection.id}
      serviceName={connection.serviceName}
      serviceVendor={connection.serviceVendor}
      purpose={connection.purpose}
      accountLabel={connection.accountLabel}
      providerIconRegistry={providerIconRegistry}
      isConnected={!providerChoice && connection.status === 'connected'}
      isError={!providerChoice && connection.status === 'error'}
      onConnect={() => providerChoice
        ? void handleChooseProvider(connection)
        : handleConnect(connection.serviceVendor)}
      actionLabel={providerChoice ? (choosingProvider === connection.serviceVendor ? 'Choosing…' : 'Choose') : undefined}
      actionDisabled={providerChoice && choosingProvider !== null}
      onDisconnect={() => void handleDisconnect(connection)}
      onAddAccount={() => handleConnect(connection.serviceVendor)}
    />
  );

  if (onboardingDiscovery) {
    const hasCurrentReadback = serviceConnections.length > 0;
    return (
      <Container
        layout="vertical"
        gap="lg"
        padding="lg"
        data-service-connections-presentation="onboarding-discovery"
        aria-live="polite"
      >
        <Container layout="vertical" gap="xs" padding="none">
          <Text variant="heading-lg">Your assistant is learning how your work fits together.</Text>
          {/*
            Never name the machine. This same screen runs in a browser on a
            phone, a Windows laptop, and a Mac, and "this Mac" was on screen for
            every one of them. Saying what is being looked at, rather than where
            it happens to live, is true everywhere and needs no branch.
          */}
          <Text variant="body" color="muted">
            It is checking the tools and sources you can reach. You can continue while this runs.
          </Text>
        </Container>

        <Container layout="grid" gridCols="auto-fill-xs" gap="sm" padding="none">
          <Card padding="md">
            <Container layout="vertical" gap="xs" padding="none">
              <Text variant="label" color="muted">Checking now</Text>
              <Text variant="heading-lg">{hasCurrentReadback ? serviceConnections.length : '…'}</Text>
              <Text variant="body-sm" color="muted">
                {hasCurrentReadback ? 'available tools and sources' : 'Looking for available tools and sources'}
              </Text>
            </Container>
          </Card>
          <Card padding="md">
            <Container layout="vertical" gap="xs" padding="none">
              <Text variant="label" color="muted">Ready</Text>
              <Text variant="heading-lg">{allConnectedRows.length}</Text>
              <Text variant="body-sm" color="muted">connections ready to use now</Text>
            </Container>
          </Card>
          <Card padding="md">
            <Container layout="vertical" gap="xs" padding="none">
              <Text variant="label" color="muted">Needs you</Text>
              <Text variant="heading-lg">{attentionRows.length}</Text>
              <Text variant="body-sm" color="muted">outside sign-ins or connection fixes</Text>
            </Container>
          </Card>
        </Container>

        {allConnectedRows.length > 0 ? (
          <Container layout="vertical" gap="sm" padding="none">
            <Text variant="heading-xs">Connected and ready</Text>
            <Container layout="grid" gridCols="auto-fill-xs" gap="sm" padding="none">
              {allConnectedRows.map(renderTile)}
            </Container>
          </Container>
        ) : (
          <Card padding="md">
            <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
              <Icon icon={Search} size="sm" color="muted" />
              <Container layout="vertical" gap="xs" padding="none">
                <Text variant="body" weight="semibold">Looking for tools and services you can reach</Text>
                <Text variant="body-sm" color="muted">
                  When an outside service requires its own sign-in, that exact step will open here.
                </Text>
              </Container>
            </Container>
          </Card>
        )}

        {attentionRows.length > 0 ? (
          <Container layout="vertical" gap="sm" padding="none">
            <Text variant="heading-xs">Finish these outside sign-ins</Text>
            <Container layout="grid" gridCols="auto-fill-xs" gap="sm" padding="none">
              {attentionRows.map(renderTile)}
            </Container>
          </Container>
        ) : null}
      </Container>
    );
  }

  if (onboardingAuthorization && !selectedProviderRef) {
    return (
      <Card variant="nested" padding="lg" data-service-connections-presentation="onboarding-authorization">
        <EmptyPlaceholder
          icon={Cable}
          message="Choose an AI before authorizing it."
        />
      </Card>
    );
  }

  return (
    <Container
      layout="vertical"
      gap="md"
      padding="none"
      data-service-connections-presentation={presentation}
    >
      {/* Header row: title left, search + sort right (Langdock anatomy) */}
      <Container layout="horizontal" gap="md" alignItems="center" justifyContent="space-between" padding="none">
        <Text variant="heading-xs">Connections</Text>
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <Input
            icon={<Icon icon={Search} size="xs" color="muted" />}
            placeholder="Search or type any service…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <SegmentedControl
            items={[
              { id: 'all', label: 'All' },
              { id: 'connected', label: 'Connected' },
              { id: 'not-connected', label: 'Not connected' },
            ]}
            value={stateFilter}
            ariaLabel="Filter by connection state"
            onValueChange={setStateFilter}
          />
          <Dropdown
            items={[...SORT_ITEMS]}
            value={sort}
            onValueChange={(value) => setSort(value as SortId)}
            size="md"
            aria-label="Sort services"
          />
        </Container>
      </Container>

      {/* Category pills — derived from data, multi-select */}
      <SelectablePillBar
        items={categoryItems}
        selectedIds={selectedCategories}
        allLabel="All"
        ariaLabel="Filter by category"
        onSelectAll={() => setSelectedCategories([])}
        onToggle={(id) =>
          setSelectedCategories((current) =>
            current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
          )
        }
      />

      {/* Connected tiles float to the top */}
      {connectedRows.length > 0 && (
        <Container layout="vertical" gap="xs" padding="none">
          <Text variant="label" color="muted">Connected</Text>
          <Container layout="grid" gridCols="auto-fill-xs" gap="sm" padding="none">
            {connectedRows.map(renderTile)}
          </Container>
        </Container>
      )}

      {availableRows.length > 0 && (
        <Container layout="vertical" gap="xs" padding="none">
          {connectedRows.length > 0 && (
            <Text variant="label" color="muted">Available</Text>
          )}
          <Container layout="grid" gridCols="auto-fill-xs" gap="sm" padding="none">
            {availableRows.map(renderTile)}
          </Container>
        </Container>
      )}

      {/* Search empty state → the typed name becomes a connectable service */}
      {trimmedQuery.length > 1 && !hasExactMatch && visibleConnections.length === 0 && (
        <Card variant="nested" padding="lg">
          <Container layout="vertical" gap="sm" alignItems="center" padding="none">
            <DisplayMark spec={{ name: trimmedQuery, shape: 'rounded' }} size="lg" />
            <Text variant="body" weight="medium">{trimmedQuery}</Text>
            <Text variant="body-xs" color="muted">
              Not in the catalog yet — connect it anyway with its key, token, or webhook URL.
            </Text>
            <Button variant="primary" size="sm" onClick={() => handleConnectCustom(trimmedQuery)}>
              <Icon icon={Plus} size="xs" />
              Connect {trimmedQuery}
            </Button>
          </Container>
        </Card>
      )}

      {/* Category/filter empty state: icon + the obvious next action */}
      {visibleConnections.length === 0 && (trimmedQuery.length <= 1 || hasExactMatch) && (
        <Card variant="nested" padding="lg">
          <Container layout="vertical" gap="sm" alignItems="center" padding="none">
            <EmptyPlaceholder
              icon={Cable}
              message="Nothing connected yet. Connect your first tool and your packages can start working with it."
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setSelectedCategories([]);
                setQuery('');
              }}
            >
              Browse all services
            </Button>
          </Container>
        </Card>
      )}

      {/* Standing add-your-own row (Revolut "Don't see yours?" anatomy) —
          ALWAYS present, the open-catalog promise made visible */}
      <Card variant="nested" padding="none">
        <Container layout="horizontal" alignItems="center" gap="sm" padding="sm">
          <Icon icon={Plug} size="sm" color="muted" />
          <Container layout="vertical" gap="none" padding="none" flex={1} minWidth="0">
            <Text variant="body" weight="medium">Don’t see your tool?</Text>
            <Text variant="body-xs" color="muted" truncate>
              Connect any service with an API key, token, or webhook URL.
            </Text>
          </Container>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleConnectCustom(trimmedQuery || 'My service')}
          >
            <Icon icon={Plus} size="xs" />
            Add a service
          </Button>
        </Container>
      </Card>

      {dialogConfig && dialogName && (
        <ServiceConnectionDialog
          open
          serviceName={dialogName}
          serviceVendor={dialogVendor}
          providerIconRegistry={providerIconRegistry}
          allowNameEntry={Boolean(customVendor) || activeConnection?.status === 'connected'}
          authConfig={dialogConfig}
          onClose={closeDialog}
          onAuthenticate={handleAuthenticate}
          onAcquire={handleAcquire}
          liveChallenge={liveChallenge}
          acquireError={acquireError}
          existingAccounts={dialogExistingAccounts}
          onRenameAccount={handleRenameAccount}
          onDisconnectAccount={handleDisconnectAccount}
          onRevealAccountCredentials={handleRevealAccountCredentials}
        />
      )}
    </Container>
  );
}
