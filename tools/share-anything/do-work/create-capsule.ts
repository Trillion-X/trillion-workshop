// packages/public-scene-share/do-work/create-capsule.ts
//
// PURPOSE
// The `public-scene-share.create-capsule` orchestration: read the LIVE scene the
// user is sharing, extract its subresource metadata, and mint a content-addressed
// capsule into CAS — returning the capsule hash + its `/c/<hash>` content path.
// This is the do-work a share action invokes.
//
// PURE ORCHESTRATION (deps injected → unit-testable; live I/O stays at the
// boundary, mirroring mint-capsule.ts and the codebase's `createXxxLogStore`
// sender-injectable pattern):
//   - `readScene`  = read the materialized `scene` sink and decode it to the
//      projector scene tree. Live adapter (boundary): `sendRequestToBitfieldTarget(
//      buildEngineReadCurrentRequestFromLabels([{ partition, address:'scene', … }]))`
//      → `decodeEngineReadCurrentReply` → the scene-tree payload.
//   - `resolveComponentHash` = freeze each component's mutable SOURCE ADDRESS into
//      its immutable CONTENT hash (read the address's current bytes → hash) so the
//      capsule's artifacts are CAS-fetchable. Live adapter at the boundary.
//   - `storeBytes` = persist the capsule bytes to CAS. Live adapter: the generic
//      content-addressed write (`buildEngineWriteBatchRequestFromLabels`, the
//      `storeBytesToCas` pattern). LOCAL CAS today; an identical-bytes public HTTPS
//      origin once T3 stands one up — this module never blocks on the origin.
//   - `hashBytes`  = the runtime SSOT content hash (`makeHashCodeHexFromBytes`).
//
// FAIL-CLOSED: an incomplete or tier-invalid closure returns a structured failure
// and writes NOTHING (mint-capsule's invariant) — never a half-published capsule.
//
// L098: this orchestration knows the live projector scene FORMAT only through the
// DATA `LiveSceneMetaConfig` it threads into `liveSceneMeta`; the format-blind
// `capsule/` closure builder never learns it.

import { liveSceneComponentSources, type LiveSceneSourceConfig } from './extract-live-scene-meta';
import { resolveComponentMeta, type ComponentHashResolver } from './resolve-component-meta';
import { mintCapsule, type MintCapsuleResult } from './mint-capsule';
import type { RefFieldConfig } from '../capsule/scene-closure';
import type { CapsuleTier } from '../capsule/scene-capsule';

/** The live I/O the publisher needs, injected at the boundary (unit-mockable). */
export interface ScenePublisherDeps {
  /** Read the materialized scene the user is sharing, decoded to the projector tree. */
  readonly readScene: () => Promise<unknown>;
  /** Freeze a component's mutable source address into its immutable CAS content hash. */
  readonly resolveComponentHash: ComponentHashResolver;
  /** Persist the capsule bytes to CAS (local today, public origin once T3 exists). */
  readonly storeBytes: (bytes: Uint8Array, contentType: string) => Promise<void>;
  /** Runtime SSOT content hash over the capsule's canonical bytes. */
  readonly hashBytes: (bytes: Uint8Array) => string;
}

/** What to freeze into THIS capsule. All DATA — no instance-specific code. */
export interface PublishSceneOptions {
  /** Delivery tier — drives the tier-closure validator (PUBLIC ⇒ only-public subresources). */
  readonly tier: CapsuleTier;
  /** The resolved chrome map frozen into the capsule (subtractive ChromeVisibilityMap). */
  readonly frozenChrome: unknown;
  /** Where component byte SOURCES live on a scene node (defaults to the projector layout). */
  readonly sourceConfig?: LiveSceneSourceConfig;
  /** Tier policy: are the scene's components independently public on the CDN tier? */
  readonly publicReadable?: boolean;
  /** Which node fields name content-addressed refs (defaults to the projector layout). */
  readonly fields?: RefFieldConfig;
  /** Tier-public predicate override (defaults to mint-capsule's). */
  readonly tierIsPublic?: (tier: CapsuleTier) => boolean;
}

/**
 * Read the live scene, extract its subresource meta, and mint + content-address +
 * persist a capsule from it. Returns the capsule hash + `/c/<hash>` path on a
 * complete, tier-valid closure; a structured validation failure (writing nothing)
 * otherwise. Pure orchestration over the injected live I/O.
 */
export async function publishSceneCapsule(
  deps: ScenePublisherDeps,
  options: PublishSceneOptions,
): Promise<MintCapsuleResult> {
  const sceneTree = await deps.readScene();
  const sources = liveSceneComponentSources(sceneTree, options.sourceConfig);
  const meta = await resolveComponentMeta(sources, deps.resolveComponentHash, {
    publicReadable: options.publicReadable,
  });
  return mintCapsule({
    sceneTree,
    frozenChrome: options.frozenChrome,
    tier: options.tier,
    meta,
    fields: options.fields,
    tierIsPublic: options.tierIsPublic,
    hashBytes: deps.hashBytes,
    storeBytes: deps.storeBytes,
  });
}
