import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import { readAccountPortalBrowserSession } from '../../account-session/do-work/read-browser-session-state';
import { currentPresenterBrowserSessionId } from '../../../../shared-code/packages/account-session/do-work/browser-session-access-key';
import { readAccountSession, type AccountSessionProjection } from '../../account-session/read-data/read-session';
import type { AccessScopedSurfaceInput } from '../../../../shared-code/packages/access-scoped-content/show/AccessScopedContent';
import { readScreenAfterSignInCheckRecord } from '../read-data/read-screen-after-sign-in-check-records';
import {
  resolveAnonEntryPlan,
  DEFAULT_ANON_ENTRY_PLAN_SET,
  DEFAULT_SIGNED_IN_SHELL,
  type AnonRoute,
} from '../read-data/resolve-entry-surface';
import { ComponentMaterialSurface } from '../../../../arrange-screens-in-panes/show/ComponentMaterialSurface';
import { CompanionMounts } from '../../../../arrange-screens-in-panes/show/CompanionMounts';
import {
  entryFlowCompletionKey,
  matchesEntryFlowReturnAction,
  readEntryFlow,
  readEntryFlowSurface,
} from '../read-data/entry-flow';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  consumeReturningLoginCallback,
  readReturningLoginCallbackQuery,
  returningLoginConfirmationCopy,
  scrubReturningLoginQuery,
} from '../read-data/returning-login-callback';

export type ScreenAfterSignInCheckProps = {
  signedScreenReadyRecords?: unknown;
  surfaceInput?: AccessScopedSurfaceInput & { callback_only?: boolean };
  entryFlow?: unknown;
};

// Reactive SPA route (hash + path) for useSyncExternalStore. The anon entry surface is a pure
// function of the route; resolveAnonEntryPlan keys off the path AND hash (so the sales page's
// `#checkout` unlock CTA selects the checkout surface). The component must re-render when the
// URL hash/path changes — subscribing to hashchange + popstate makes the resolved surface track
// the URL (forward/back included).
//
// getSnapshot MUST return a stable primitive (useSyncExternalStore compares with Object.is) —
// returning a fresh AnonRoute object each call would loop forever. Encode pathname + hash as one
// string separated by '\n', which cannot appear in a real pathname or hash.
const ROUTE_KEY_SEP = '\n';

function subscribeRoute(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('hashchange', onStoreChange);
  window.addEventListener('popstate', onStoreChange);
  return () => {
    window.removeEventListener('hashchange', onStoreChange);
    window.removeEventListener('popstate', onStoreChange);
  };
}

function routeSnapshotKey(): string {
  if (typeof window === 'undefined') return `/${ROUTE_KEY_SEP}`;
  return `${window.location.pathname || '/'}${ROUTE_KEY_SEP}${window.location.hash || ''}`;
}

function serverRouteSnapshotKey(): string {
  return `/${ROUTE_KEY_SEP}`;
}

function anonRouteFromKey(key: string): AnonRoute {
  // Host is stable for the life of the document (it only changes on a full
  // navigation, which reloads this module), so read it fresh here rather than
  // encoding it into the (path+hash) snapshot key. Lets host-scoped route rules
  // (e.g. the `app.` subdomain home to login) resolve.
  const host = typeof window === 'undefined' ? '' : (window.location.hostname || '');
  const i = key.indexOf(ROUTE_KEY_SEP);
  return i < 0
    ? { pathname: key, hash: '', host }
    : { pathname: key.slice(0, i), hash: key.slice(i + 1), host };
}


// D6 LAST-MILE: the emailed sign-in link's return action renders HERE, in the app document,
// on ANY origin the link was minted for. One line of copy, the Open the selected app action, and one
// custom-scheme auto-attempt. The carousel can never appear for account_login=complete because
// this branch returns before any anonymous surface mounts.
type ReturningLoginViewState = 'pending' | 'complete' | 'failed';

export function ReturningLoginConfirmationCard({ state, appName, authCompleteHref }: { state: ReturningLoginViewState; appName: string; authCompleteHref: string | null }) {
  const copy = returningLoginConfirmationCopy(appName);
  const ok = state === 'complete';
  const pending = state === 'pending';
  const [schemeTried, setSchemeTried] = React.useState(false);
  React.useEffect(() => {
    if (!ok || !authCompleteHref || schemeTried) return;
    setSchemeTried(true);
    const timer = setTimeout(() => {
      try {
        window.location.assign(authCompleteHref);
      } catch { /* unregistered scheme: the visible action remains */ }
    }, 450);
    return () => clearTimeout(timer);
  }, [authCompleteHref, ok, schemeTried]);
  return (
    <section
      data-returning-login-confirmation={state}
      data-package="screen-after-sign-in-check"
      style={{
        position: 'fixed',
        inset: 0,
        overflowY: 'auto',
        display: 'grid',
        placeItems: 'center',
        padding: '32px 20px',
        background: '#f5f3ee',
        color: '#111',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        textAlign: 'center',
        zIndex: 2147483000,
      }}
    >
      <div style={{ maxWidth: 680 }}>
        {ok ? <p style={{ margin: '0 0 14px', color: '#5f5b54', fontSize: 15 }}>{copy.eyebrow}</p> : null}
        <h1
          id="handoff-title"
          style={{ margin: 0, fontSize: 'clamp(42px, 8vw, 76px)', fontWeight: 600, letterSpacing: '-0.055em', lineHeight: 0.98 }}
        >
          {pending ? 'Finishing sign-in…' : ok ? copy.title : copy.failureTitle}
        </h1>
        {pending ? (
          <p role="status" style={{ maxWidth: 500, margin: '24px auto 0', fontSize: 20, lineHeight: 1.5, color: '#504d47' }}>
            This usually takes a moment.
          </p>
        ) : ok ? (
          <p style={{ maxWidth: 500, margin: '24px auto 0', fontSize: 20, lineHeight: 1.5, color: '#504d47' }}>
            {copy.body}
          </p>
        ) : null}
        {!pending ? (
          <a
            href={ok && authCompleteHref ? authCompleteHref : '/'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 56,
              marginTop: 34,
              padding: '0 28px',
              borderRadius: 999,
              background: '#111',
              color: '#fff',
              textDecoration: 'none',
              fontSize: 17,
              fontWeight: 600,
            }}
          >
            {ok ? copy.action : copy.failureAction}
          </a>
        ) : null}
        {ok ? (
          <p style={{ margin: '18px auto 0', color: '#706c65', fontSize: 14 }}>
            If {appName} does not open automatically, use the button above.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function ScreenAfterSignInCheck({ surfaceInput, entryFlow }: ScreenAfterSignInCheckProps = {}) {
  const callbackOnly = surfaceInput?.callback_only === true;
  const records = useBitfieldData('screen-after-sign-in-check-records');
  const flow = React.useMemo(() => readEntryFlow(entryFlow), [entryFlow]);
  const selectedPreAuthRecord = useBitfieldData({
    input: 'entry-flow-surface-by-address-label',
    params: { addressLabel: flow?.preAuthSurfaceRef ?? '' },
  });
  const preAuthSurface = React.useMemo(
    () => readEntryFlowSurface(selectedPreAuthRecord),
    [selectedPreAuthRecord],
  );
  const screen = readScreenAfterSignInCheckRecord(records);
  const [session, setSession] = React.useState<Partial<AccountSessionProjection> | null | undefined>(undefined);
  const accountIdHash = readAccountSession(session).accountIdHash ?? null;
  const [preAuthComplete, setPreAuthComplete] = React.useState(false);
  const emittedSignedInEvent = React.useRef(false);
  // Reactive anon route — re-renders this component when the URL hash/path changes
  // (e.g. the sales page `#checkout` CTA) so the resolved surface tracks the URL.
  const anonRoute = anonRouteFromKey(
    React.useSyncExternalStore(subscribeRoute, routeSnapshotKey, serverRouteSnapshotKey),
  );
  const [returningLoginState, setReturningLoginState] = React.useState<'idle' | 'pending' | 'complete' | 'failed'>('idle');
  const returningLoginQuery = React.useMemo(
    () => readReturningLoginCallbackQuery(typeof window === 'undefined' ? '' : window.location.search),
    // Deliberately read once per mount: the proof is single-use and is scrubbed after consume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  React.useEffect(() => {
    if (!returningLoginQuery.isActive || returningLoginQuery.token == null) return;
    let cancelled = false;
    setReturningLoginState('pending');
    void consumeReturningLoginCallback({
      dispatch: (target, payload) => sendRequestToBitfieldTarget({ target, payload }).then((reply) => reply),
      token: returningLoginQuery.token,
      tabBrowserId: (() => {
        try {
          return currentPresenterBrowserSessionId();
        } catch {
          return null;
        }
      })(),
    }).then((result) => {
      if (cancelled) return;
      // The confirmation card exists to hand the person off to a separate app.
      // Where this deployment declares no app to hand off to, the person is
      // already where they wanted to be: signed in, in this document. Showing
      // them a card that says "Open Trillion" and auto-jumps to a custom scheme
      // takes a completed web sign-in and sends it somewhere they did not ask
      // to go, and on a machine without that app it goes nowhere at all.
      const handsOffToAnApp = typeof screen.auth_complete_href === 'string'
        && screen.auth_complete_href.trim().length > 0;
      if (result.ok) {
        scrubReturningLoginQuery(window.location.pathname || '/');
        if (!handsOffToAnApp && result.returnPath) {
          window.location.assign(result.returnPath);
          return;
        }
      }
      setReturningLoginState(result.ok ? (handsOffToAnApp ? 'complete' : 'idle') : 'failed');
      // Whatever this tab's own outcome, a completed app session must be visible to the
      // gate's normal refresh path immediately (this IS the callback tab's refresh).
      refreshRef.current?.();
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returningLoginQuery.isActive, returningLoginQuery.token]);

  const refreshRef = React.useRef<(() => void) | null>(null);

  // ⚠️ ONLY WHILE NOBODY IS SIGNED IN.
  //
  // Coming back to the tab re-reads the session, and that read re-pushes the
  // app's whole current snapshot, which repaints the screen. Someone signed in
  // and working therefore lost their screen every time they clicked another
  // window and came back, even a second later.
  //
  // The listener exists for ONE case: a sign-in finished in a different tab and
  // this one has to notice. Once this tab has a signed-in session there is
  // nothing left to notice, so it stops listening. The sign-in callback still
  // calls refresh directly, which is that path and does not go through here.
  const signedInAlready = readAccountSession(session).status === 'signed_in';

  React.useEffect(() => {
    if (callbackOnly) return;
    let cancelled = false;
    const refresh = () => {
      void readAccountPortalBrowserSession().then((nextSession) => {
        if (!cancelled) setSession(nextSession);
      });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refreshRef.current = refresh;
    refresh();
    if (signedInAlready) return () => { cancelled = true; refreshRef.current = null; };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      refreshRef.current = null;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [callbackOnly, signedInAlready]);

  React.useEffect(() => {
    if (callbackOnly) return;
    if (!flow || typeof window === 'undefined') return;
    const key = entryFlowCompletionKey(flow);
    setPreAuthComplete(window.localStorage.getItem(key) === 'true');
    const onFlowEvent = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail?.event_kind !== flow.completionEventKind) return;
      window.localStorage.setItem(key, 'true');
      setPreAuthComplete(true);
    };
    window.addEventListener('bitfield:walkthrough-event', onFlowEvent);
    return () => window.removeEventListener('bitfield:walkthrough-event', onFlowEvent);
  }, [callbackOnly, flow]);

  React.useEffect(() => {
    if (callbackOnly) return;
    if (!flow?.signedInEventKind || emittedSignedInEvent.current || typeof window === 'undefined') return;
    const projection = readAccountSession(session);
    if (projection.status !== 'signed_in') return;
    const emitWhenHostOwnsDocument = () => {
      if (emittedSignedInEvent.current) return;
      if (!document.documentElement.hasAttribute('data-guided-overlay-host-owner')) return;
      emittedSignedInEvent.current = true;
      window.dispatchEvent(new CustomEvent('bitfield:walkthrough-event', {
        detail: {
          event_kind: flow.signedInEventKind,
          status: 'signed_in',
          account_ref: projection.accountIdHash ?? 'signed-in-account',
          walkthrough_revision: flow.revision,
        },
      }));
    };
    window.addEventListener('bitfield:walkthrough-host-available', emitWhenHostOwnsDocument);
    emitWhenHostOwnsDocument();
    return () => window.removeEventListener('bitfield:walkthrough-host-available', emitWhenHostOwnsDocument);
  }, [callbackOnly, flow, session]);

  if (returningLoginState !== 'idle') {
    // The emailed link's return action owns this document until the customer leaves it.
    return <ReturningLoginConfirmationCard state={returningLoginState} appName={screen.app_name} authCompleteHref={screen.auth_complete_href} />;
  }

  if (callbackOnly) return null;

  if (session === undefined) {
    // Browser session still resolving — render nothing decision-bearing yet (we don't know
    // signed vs anon). Brief; readAccountPortalBrowserSession is a fast local read.
    return <section data-sign-in-screen data-package="screen-after-sign-in-check" data-session-check="loading" />;
  }

  const sessionProjection = readAccountSession(session);
  if (sessionProjection.status === 'signed_in') {
    const signedSurfaceInput = {
      ...(surfaceInput ?? {}),
      access_filter: 'account-grants',
      account_id_hash: accountIdHash,
    };
    // RECURSION GUARD (L063 structural fix). This gate is the app entry component. When a
    // member is signed in AND this gate is mounted as the ROOT scene, it must mount the full
    // shell (below). But the workspace surface catalog lists the member's content surfaces
    // (First Principles, Federer Masterclass, AI Coach, ...) pointing at THIS gate as their
    // material_target — so when the member opens one of those tabs, screen-arrangement mounts
    // this gate AGAIN, nested inside the shell. That is the ghosting/recursion:
    //   root gate -> shell -> screen-arrangement -> tab -> gate -> shell -> ... (two shells).
    // The signal that we are nested-as-tab-content (not the root) is a content-scoped
    // surfaceInput: screen-arrangement threads the tab's { access_item_id / content_ref } here,
    // whereas the root scene mounts the gate with no such content ref. So when a content ref is
    // present, render the granted CONTENT surface directly (access-scoped-content) and never
    // re-mount the shell. This makes the recursion structurally impossible regardless of what
    // any surface catalog points its material_target at.
    if (surfaceInput?.access_item_id || surfaceInput?.content_ref) {
      // The workspace tab threads the item's { access_item_id } but screen-arrangement does
      // NOT propagate the surface's `access_projection_address_label` to the tab. Derive the
      // per-item content projection address from the item's OWN id — an app-agnostic convention
      // (`access-projection::<access_item_id>`), zero Society/app-name in this shared package —
      // so access-scoped-content resolves the granted library for THIS item. (The deeper root
      // fix is screen-arrangement propagating the full surface_input to the tab; until then this
      // keyed-by-item-id derivation is generic and correct for any app.)
      const nestedSurfaceInput = {
        ...signedSurfaceInput,
        access_projection_address_label:
          signedSurfaceInput.access_projection_address_label ??
          (surfaceInput.access_item_id ? `access-projection::${surfaceInput.access_item_id}` : undefined),
      };
      return (
        <section
          data-customer-owned-screen
          data-package="screen-after-sign-in-check"
          data-session-check={screen.signed_status}
          data-nested-content="true"
          style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
        >
          <ComponentMaterialSurface
            packageEntry={{ packageName: 'access-scoped-content', entryName: 'access-scoped-content' }}
            materialTarget="component:access-scoped-content"
            surfaceInput={nestedSurfaceInput}
          />
        </section>
      );
    }
    // A real member gets the full navigable app chrome (screen-look + screen-arrangement +
    // sidebar), NOT a bare full-page single surface. The sidebar lists every placeable-surface
    // (Library, Swing Analysis, Your Stats, the courses, booking) so the member can move around
    // the whole product. Each chrome component is mounted BY ADDRESS through the blind
    // ComponentMaterialSurface (the same mechanism the root scene uses). The wrapper is a
    // full-viewport fixed layer so the sidebar rail + workspace + Look background dock against
    // the viewport exactly as they do when mounted as scene roots (fixed/absolute children need
    // a viewport-sized, transform-free containing block). The grant-scoped surfaceInput is
    // threaded to each so the Library resolves the member's own grants.
    return (
      <section
        data-customer-owned-screen
        data-package="screen-after-sign-in-check"
        data-session-check={screen.signed_status}
        style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}
      >
        {(flow?.signedInShell ?? DEFAULT_SIGNED_IN_SHELL).map((component) => (
          <ComponentMaterialSurface
            key={component.materialTarget}
            packageEntry={{ packageName: component.packageName, entryName: component.entryName }}
            materialTarget={component.materialTarget}
            surfaceInput={signedSurfaceInput}
          />
        ))}
      </section>
    );
  }

  if (flow && !preAuthComplete) {
    if (!preAuthSurface) {
      return <section data-anon-screen data-entry-flow="loading" data-package="screen-after-sign-in-check" />;
    }
    return (
      <section data-anon-screen data-entry-flow="pre-auth" data-package="screen-after-sign-in-check">
        <ComponentMaterialSurface
          packageEntry={preAuthSurface.packageEntry}
          materialTarget={preAuthSurface.materialTarget}
          surfaceInput={preAuthSurface.packageEntry.surfaceInput}
        />
      </section>
    );
  }

  if (flow) {
    const primary = matchesEntryFlowReturnAction(flow, typeof window === 'undefined' ? '' : window.location.search)
      ? flow.returnAction!.primary
      : flow.then;
    return (
      <section data-anon-screen data-entry-flow="account" data-package="screen-after-sign-in-check">
        <ComponentMaterialSurface packageEntry={primary} surfaceInput={primary.surfaceInput} />
      </section>
    );
  }

  // Anonymous reachability (P-ROUTE): cold traffic reaches the product, never a sign-up wall.
  // The surface is a pure function of the route, resolved from DATA. This renderer is a BLIND
  // mount of the resolved plan: the primary surface is mounted BY ADDRESS (ComponentMaterialSurface,
  // carrying its DATA surfaceInput), and headless companions (traffic beacons, the supabase
  // magic-link completion) co-mount for their on-mount effect. There is ZERO package name, ZERO
  // provider logic, and ZERO surface enum here — adding a route, surface, or companion is a DATA
  // change in resolve-entry-surface, never code here.
  const anonPlan = resolveAnonEntryPlan(anonRoute, DEFAULT_ANON_ENTRY_PLAN_SET);
  if (!anonPlan) return null; // a well-formed plan set ends with a wildcard, so this is unreachable
  return (
    <section data-anon-screen data-package="screen-after-sign-in-check" data-session-check={screen.unsigned_status}>
      <ComponentMaterialSurface packageEntry={anonPlan.primary} surfaceInput={anonPlan.primary.surfaceInput} />
      <CompanionMounts companions={anonPlan.companions} />
    </section>
  );
}
