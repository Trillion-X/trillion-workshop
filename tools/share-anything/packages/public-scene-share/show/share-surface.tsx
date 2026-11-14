// packages/public-scene-share/show/share-surface.tsx
//
// The mountable Share SURFACE — the same-package keystone that makes the
// `ShareAffordance` button live. It composes the proven `create-capsule` target
// (live engine I/O) with the button, so opening this surface anywhere (a screen-
// arrangement "Share this view" action opens it BY ADDRESS, never imports it)
// gives the user a real, working Share control.
//
// Decoupling (L098/L106):
// • `create-capsule` is a same-package target — composing it here is legal; a
//   foreign surface opens THIS surface by address, so the share capability stays
//   owned by `public-scene-share`.
// • The reply adaptation (the target's machine reply → the presenter's
//   `CapsuleReply`) happens at this boundary; the presenter stays the one source
//   of human copy.
// • The mint builder is factored out (`buildShareMint`) so the live composition
//   verifies with a mocked engine I/O.

import React from 'react';
import { Container, SegmentedControl } from '@/packages/ui';
import { ShareAffordance } from '@/packages/public-scene-share/show/ShareAffordance';
import {
  isPubliclyReachableOrigin,
  type CapsuleReply,
  type ShareConfig,
} from '@/packages/public-scene-share/show/share-scene-presenter';
import {
  createCapsuleTarget,
  sdkEngineIo,
  type CapsuleEngineIo,
  type CreateCapsuleRequest,
} from '@/packages/public-scene-share/do-work/create-capsule-target';
import { listShareableRoots, type ShareableRoot } from '@/packages/public-scene-share/capsule/prune-scene';

// NOTE (2026-06-28, gauntlet): the surface intentionally has NO chrome-mode chooser.
// "Share just this view (a bare document, no sidebar)" is delivered GENERICALLY by the
// SCOPE picker below — pick the content root and the chrome roots are excluded from the
// capsule by EXCLUSION (prune-scene). A scene-level chrome toggle was removed: a single
// "bare" = `{ "": false }` map hides EVERY zone (incl. the content root, which also
// carries a chrome_zone), and a surface cannot generically build a correct per-zone
// "hide chrome, keep content" map without hardcoding which zone is chrome (instance-
// solve) or exposing internal zone vocabulary (L118). The precise per-zone `frozenChrome`
// primitive still exists on the create-capsule TARGET for programmatic consumers (e.g. a
// multi-content-root share) and can be passed to this surface as DATA (the `frozenChrome`
// prop) — but it is never offered as a generic UI toggle that the surface can't fulfill.

/** The "share the whole scene" sentinel — no `rootNodeId`, the capsule freezes the
 *  entire scene. Empty string so it round-trips through SegmentedControl values. */
const SCOPE_EVERYTHING = '';

/** Default scene sink address — mirrors the target's DEFAULT_SCENE_ADDRESS. */
const DEFAULT_SCENE_ADDRESS = 'scene';

const textDecoder = new TextDecoder();

/**
 * Display-only humanize of a scene-root id into a picker label: take the last
 * codec segment, turn separators into spaces, title-case. Pure + uniform — applied
 * to ANY id identically, so it bakes no Society vocabulary (a root invented
 * tomorrow gets a readable label for free; the value stays the raw id).
 */
function humanizeRootLabel(id: string): string {
  const tail = id.includes(':') ? id.slice(id.lastIndexOf(':') + 1) : id;
  const words = tail.replace(/[-_]+/g, ' ').trim();
  return words.replace(/\b\w/g, (c) => c.toUpperCase()) || id;
}

/**
 * Read the live scene once and list its top-level shareable roots (DATA-driven —
 * never a hardcoded id). Returns [] on any read/parse miss so the picker degrades
 * to "Everything only" rather than crashing the surface.
 */
async function fetchShareableRoots(
  io: CapsuleEngineIo,
  partitionLabel: string,
  sceneAddressLabel: string,
): Promise<ShareableRoot[]> {
  try {
    const current = await io.readCurrent(partitionLabel, sceneAddressLabel);
    if (!current.found || current.payload == null) return [];
    const sceneTree = JSON.parse(textDecoder.decode(current.payload));
    return listShareableRoots(sceneTree);
  } catch {
    return [];
  }
}

/**
 * Build the injected `onMint` for the Share button: invoke the live `create-capsule`
 * target and adapt its machine reply to the presenter's `CapsuleReply`. `io`
 * defaults to the live SDK engine I/O; verification passes a mock.
 */
export function buildShareMint(
  request: CreateCapsuleRequest,
  io?: CapsuleEngineIo,
): () => Promise<CapsuleReply> {
  return async () => {
    const reply = io ? await createCapsuleTarget(request, undefined, io) : await createCapsuleTarget(request);
    return reply.ok
      ? { ok: true, capsuleHash: reply.capsuleHash, contentPath: reply.contentPath }
      : { ok: false, reason: reply.failureReason };
  };
}

/** Resolve the share link origin: explicit DATA wins; else the current page origin. */
export function resolveShareOrigin(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return '';
}

export interface ShareSurfaceProps {
  /** The partition the live scene + component sources live in (the running app). */
  readonly partitionLabel: string;
  /** Override of the scene sink address (defaults to the projector `scene`). */
  readonly sceneAddressLabel?: string;
  /** Public origin for the minted link (defaults to the current page origin). */
  readonly publicShareOrigin?: string;
  /** Injected engine I/O for verification; live SDK I/O by default. */
  readonly io?: CapsuleEngineIo;
  /** Precise per-zone presentation chrome, supplied as DATA by a programmatic opener
   *  (NOT a generic UI toggle — see the note above). Absent = full view (verbatim). */
  readonly frozenChrome?: unknown;
}

/** The opened Share surface: a SCOPE chooser (what subtree to freeze) + a real Share
 *  button over the live mint. "Bare document" = pick the content root in the scope
 *  chooser (chrome roots excluded by exclusion). No chrome toggle (see note above). */
export function ShareSurface({ partitionLabel, sceneAddressLabel, publicShareOrigin, io, frozenChrome }: ShareSurfaceProps) {
  // The origin is resolved the same way regardless of source (explicit DATA from a
  // connected deploy-target's reported public URL, or the ambient page origin as a
  // last resort) — but EVERY resolved origin is then checked against the ONE generic
  // "is this actually public" test (L114/L116). No deploy target connected in a local
  // studio session means the ambient origin is loopback, so `isPubliclyReachable`
  // comes back false and the Share affordance honestly refuses to mint a fake link.
  const origin = resolveShareOrigin(publicShareOrigin);
  const config: ShareConfig = { publicShareOrigin: origin, isPubliclyReachable: isPubliclyReachableOrigin(origin) };
  const sceneAddress = sceneAddressLabel ?? DEFAULT_SCENE_ADDRESS;
  const mintIo = io ?? sdkEngineIo;

  // Scope picker: list the live scene's top-level roots (DATA-driven). "Everything"
  // (whole scene) is always offered; each root is an option to freeze JUST that view.
  const [roots, setRoots] = React.useState<ShareableRoot[]>([]);
  const [scope, setScope] = React.useState<string>(SCOPE_EVERYTHING);
  React.useEffect(() => {
    let live = true;
    void fetchShareableRoots(mintIo, partitionLabel, sceneAddress).then((found) => {
      if (live) setRoots(found);
    });
    return () => {
      live = false;
    };
  }, [mintIo, partitionLabel, sceneAddress]);

  const scopeItems = React.useMemo(
    () => [
      { id: SCOPE_EVERYTHING, label: 'Everything' },
      ...roots.map((r) => ({ id: r.id, label: humanizeRootLabel(r.id) })),
    ],
    [roots],
  );

  const onMint = React.useMemo(
    () =>
      buildShareMint(
        { partitionLabel, sceneAddressLabel, rootNodeId: scope || undefined, tier: 'public', frozenChrome },
        io,
      ),
    [partitionLabel, sceneAddressLabel, scope, frozenChrome, io],
  );
  return (
    <Container layout="vertical" gap="sm">
      {scopeItems.length > 1 ? (
        <SegmentedControl
          items={scopeItems}
          value={scope}
          ariaLabel="What to share"
          onValueChange={setScope}
        />
      ) : null}
      {/* Remount the affordance when the scope changes so a stale minted link can't
          linger for a different presentation (re-mint with the new choice). */}
      <ShareAffordance key={scope} config={config} onMint={onMint} />
    </Container>
  );
}
