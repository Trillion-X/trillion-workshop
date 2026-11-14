// packages/ui/show/placeable-surface-intent/viewer-access-refs.tsx
//
// Generic, browser-local presentation eligibility for placeable-surface
// catalogs. Opaque refs narrow what a viewer is offered; Product Access grants
// and Hosted Public App closure remain buyer-authorization authorities.

import React from 'react';
import { useBitfieldData } from '#workspace-records';
import { ErrorBoundary } from '../error-boundary';
import { ViewerAccessRefsContext } from './viewer-access-refs-context';
export { ViewerAccessRefsContext } from './viewer-access-refs-context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toRefArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
    .map((ref) => ref.trim());
}

/**
 * Decode optional viewer-held refs. `undefined` is no presentation context
 * (Studio owner: unrestricted); explicit `[]` hides gated rows. This is
 * defense-in-depth presentation eligibility, not buyer purchase authorization.
 */
export function readViewerAccessRefs(raw: unknown): readonly string[] | undefined {
  const direct = toRefArray(raw);
  if (direct) return direct;
  if (!isRecord(raw)) return undefined;
  for (const key of ['refs', 'access_refs', 'accessRefs', 'granted_access_refs', 'grantedAccessRefs', 'payload']) {
    const nested = key === 'payload' ? readViewerAccessRefs(raw[key]) : toRefArray(raw[key]);
    if (nested) return nested;
  }
  return undefined;
}

type ViewerAccessRefsResolution = {
  status: 'reading'
} | {
  status: 'ready'
  refs: readonly string[] | undefined
}

function ViewerAccessRefsFromData({ onReady }: { onReady: (refs: readonly string[] | undefined) => void }): React.ReactElement | null {
  const raw = useBitfieldData('viewer-access-refs');
  const refs = React.useMemo(() => readViewerAccessRefs(raw), [raw]);
  React.useEffect(() => {
    onReady(refs)
  }, [onReady, refs]);
  return null;
}

function ViewerAccessRefsFallback({ onReady }: { onReady: (refs: readonly string[] | undefined) => void }): React.ReactElement | null {
  React.useEffect(() => {
    onReady(undefined)
  }, [onReady]);
  return null;
}

/**
 * An omitted package input throws from `useBitfieldData`; the boundary restores
 * undefined Studio-owner eligibility. An admitted `[]` remains explicit and
 * hides gated rows. This provider does not authorize buyer access.
 */
export function ViewerAccessRefsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement | null {
  const [resolution, setResolution] = React.useState<ViewerAccessRefsResolution>({ status: 'reading' });
  const onReady = React.useCallback((refs: readonly string[] | undefined) => {
    setResolution((current) => (
      current.status === 'ready' && current.refs === refs ? current : { status: 'ready', refs }
    ))
  }, []);

  return (
    <>
      <ErrorBoundary
        zoneName="viewer access refs"
        fallback={() => <ViewerAccessRefsFallback onReady={onReady} />}
      >
        <ViewerAccessRefsFromData onReady={onReady} />
      </ErrorBoundary>
      {resolution.status === 'ready' ? (
        <ViewerAccessRefsContext.Provider value={resolution.refs}>{children}</ViewerAccessRefsContext.Provider>
      ) : null}
    </>
  );
}
