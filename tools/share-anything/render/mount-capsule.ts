// packages/public-scene-share/render/mount-capsule.ts
//
// PURPOSE
// The public capsule VIEWER's orchestration core: given a capsule content hash,
// fetch the capsule bytes, decode them, rewrite the scene so each component mounts
// from its frozen content hash, and hand the result to a painter. This is the pure,
// injection-based heart of the viewer document (`capsule-view.html`) — the actual
// HTML wires the real I/O (`fetch('/cas/<hash>')`) and the real scene painter
// (`createBrowserThingToPutOnScreenRunner` / `putSceneNodeOnScreen`) into `deps`.
//
// WHY INJECTION (no painter import here): the cross-origin public viewer BUNDLES the
// painter; the local owner-preview imports the shell painter; a unit test injects a
// recorder. This module must work for all three, so the painter is a `deps.mountScene`
// callback, never an import. That also decouples this code from WHERE the painter
// source lives (it is mid-extraction to a Runtime Kit leaf) — the viewer logic is
// permanent regardless.
//
// BLIND (L090): never inspects scene/capsule internals beyond the decode+rewrite the
// proven `read-capsule` / `to-renderable-scene` pieces already do. FAIL-CLOSED: any
// fetch/decode failure returns a structured reason; the viewer renders an error, not
// a blank or a half-scene.

import { readCapsuleBytes } from '../capsule/read-capsule';
import {
  capsuleToRenderableScene,
  DEFAULT_RENDERABLE_SCENE_CONFIG,
  type RenderableSceneConfig,
} from './to-renderable-scene';

/** Everything the viewer logic needs from the outside world — all injected. */
export interface CapsuleViewerDeps {
  /** Fetch the raw capsule bytes for a content hash (the `/cas/<hash>` or `/c/<hash>` GET). */
  readonly fetchCapsuleBytes: (hash: string) => Promise<Uint8Array>;
  /** Mount the rewritten scene tree into the page — the painter, injected. */
  readonly mountScene: (sceneTree: unknown) => Promise<void> | void;
}

export type MountCapsuleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Fetch → decode → rewrite-to-static → mount. Pure over injected I/O + painter.
 * Returns a structured failure (never throws) so the viewer shows an error state.
 */
export async function mountCapsuleFromHash(
  hash: string,
  deps: CapsuleViewerDeps,
  config: RenderableSceneConfig = DEFAULT_RENDERABLE_SCENE_CONFIG,
): Promise<MountCapsuleResult> {
  if (typeof hash !== 'string' || hash === '') {
    return { ok: false, reason: 'no capsule hash supplied' };
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.fetchCapsuleBytes(hash);
  } catch (error) {
    return { ok: false, reason: `capsule fetch failed: ${(error as Error).message}` };
  }
  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, reason: `capsule ${hash} returned no bytes` };
  }

  const decoded = readCapsuleBytes(bytes);
  if (!decoded.ok) {
    return { ok: false, reason: `capsule decode failed: ${decoded.reason}` };
  }

  const renderable = capsuleToRenderableScene(decoded.input, config);

  try {
    await deps.mountScene(renderable);
  } catch (error) {
    return { ok: false, reason: `scene mount failed: ${(error as Error).message}` };
  }
  return { ok: true };
}

/**
 * Read the capsule hash from a viewer URL. The hash is the `c` query param
 * (`?c=<hash>`) or the last path segment of `/c/<hash>` — DATA, the URL shape is
 * config, the logic never hardcodes a host.
 */
export function capsuleHashFromUrl(url: URL, queryKey = 'c'): string | null {
  const fromQuery = url.searchParams.get(queryKey);
  if (fromQuery) return fromQuery;
  const segments = url.pathname.split('/').filter(Boolean);
  // `/c/<hash>` (or `/s/<id>`) — the last non-empty segment after a single-letter route.
  if (segments.length >= 2) return decodeURIComponent(segments[segments.length - 1]);
  return null;
}
