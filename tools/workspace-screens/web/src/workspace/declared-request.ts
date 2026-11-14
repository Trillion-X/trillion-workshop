// src/workspace/declared-request.ts
//
// PURPOSE
//   One request a saved screen declares (`screen.requests`: a module screen's or a parts screen's), sent the one way
//   every screen sends it. The shared request owner (parts/ui/show/isolated-module-surface/module-surface-requests.mjs)
//   checks the call against its declaration and builds the fixed request; a typed resource operation goes to the
//   addressed resource's owner, anything else to its fixed workspace route through the page's own reader (api.ts), which
//   in an AI app's view is itself carried by screen_read. The screen never names a path, a method or a credential.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A call the declarations do not allow is refused before anything is sent.
//   2. Only reads are tried again by themselves (moduleSurfaceRequestCanRetry); a write is sent once.

import { readJson } from './api';
import { moduleSurfaceRequest, moduleSurfaceRequestCanRetry } from '../../parts/ui/show/isolated-module-surface/module-surface-requests.mjs';
import { runAddressedResourceAction } from './resource-target';

/** Sends the request `name` that `requests` declares, with `input`, for a screen opened on `surfaceInput`. */
export function declaredCall(requests: Record<string, unknown> | undefined, surfaceInput: Record<string, unknown>, name: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const declarations = requests ?? {};
  const request = moduleSurfaceRequest(declarations, name, input, surfaceInput);
  if (typeof (declarations[name] as { resource_operation?: unknown })?.resource_operation === 'string') {
    return runAddressedResourceAction({ input: JSON.parse(String(request.init.body)) });
  }
  return readJson(request.path, request.init, moduleSurfaceRequestCanRetry(declarations[name]), { applyFocus: false });
}
