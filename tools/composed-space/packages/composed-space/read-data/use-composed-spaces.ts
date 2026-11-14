import { useEffect, useState } from 'react';
import { composeScopedSpaceProjection, type AdmittedSpaceScope, type NormalizedSpaceView } from './read-composed-spaces';

/** Receives only the caller-ready, server-scoped projection from owner boundaries. */
export function useComposedSpaces(projection: unknown, scope: AdmittedSpaceScope | null, refreshKey = 0) {
  const [spaces, setSpaces] = useState<NormalizedSpaceView[] | null>(null);
  useEffect(() => {
    setSpaces(scope ? composeScopedSpaceProjection(projection, scope) : []);
  }, [projection, scope, refreshKey]);
  return spaces;
}
