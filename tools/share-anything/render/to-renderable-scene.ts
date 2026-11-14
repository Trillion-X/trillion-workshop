// packages/public-scene-share/render/to-renderable-scene.ts
//
// PURPOSE
// Turn a decoded capsule (`CapsuleRenderInput`) into a scene tree the EXISTING
// generic scene painter renders WITHOUT any live engine — by rewriting each
// component to mount from its FROZEN content hash (a static CAS artifact) instead
// of its live address. This is the render-side counterpart to
// `../do-work/extract-live-scene-meta.ts` (which read the live address on the mint
// side); it re-injects the frozen hash so a no-account viewer renders the exact
// frozen bytes.
//
// WHY THIS LIVES IN render/ (NOT capsule/): it PARSES the scene tree — it knows the
// scene-node format (`component_id`, `things_to_put_on_screen`) and the painter
// format (`artifact.hash`, `source_bytes`). The `capsule/` core is BLIND to scene
// format (L098): it freezes/validates/decodes the closure but never parses
// `sceneSnapshot`. Scene+painter-format knowledge is the RENDER side's concern,
// mirroring how `do-work/` owns the live-scene format on the mint side.
//
// WHY THIS WORKS WITH ZERO PAINTER CHANGE: the shell painter already resolves a
// "thing to put on screen" two ways — LIVE (a `source_bytes` address it resolves
// via the engine) or STATIC (an immutable CAS-hash artifact it fetches from
// `/cas/<hash>`). It picks STATIC when there is no live `source_bytes`. So freezing
// = drop the live `source_bytes` + set the artifact hash; the same generic painter
// then mounts the component from CAS. The cross-origin sandbox (T5/D1) is SECURITY
// hardening for UNTRUSTED capsules, orthogonal to this render mechanism.
//
// BLIND (L090): never switches on node kind — it freezes wherever a component id
// resolves to a frozen artifact. PAINTER-CONTRACT AS DATA (L098): where the hash
// goes / which field is the live source is `RenderableSceneConfig`, matching the
// shell's THINGS_TO_PUT_ON_SCREEN_CONTRACT but never hardcoding shell internals.

import { refKey } from '../capsule/scene-capsule';
import type { CapsuleRenderInput } from '../capsule/read-capsule';

/** How a scene node names a component and where the painter reads a STATIC artifact
 *  hash. DATA — mirrors the shell's THINGS_TO_PUT_ON_SCREEN_CONTRACT. */
export interface RenderableSceneConfig {
  /** Node/prop field holding the component id (e.g. `'component_id'`). */
  readonly componentIdField: string;
  /** Prop/node field holding the on-screen things array (e.g. `'things_to_put_on_screen'`). */
  readonly thingsField: string;
  /** Path where the painter reads a static artifact hash (e.g. `['artifact','hash']`). */
  readonly artifactHashPath: readonly string[];
  /** The live-source field cleared so the painter takes the static path (e.g. `'source_bytes'`). */
  readonly liveSourceField: string;
}

export const DEFAULT_RENDERABLE_SCENE_CONFIG: RenderableSceneConfig = {
  componentIdField: 'component_id',
  thingsField: 'things_to_put_on_screen',
  artifactHashPath: ['artifact', 'hash'],
  liveSourceField: 'source_bytes',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!isObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

/** Freeze one "thing to put on screen": drop the live source, set the static hash. */
function freezeThing(thing: unknown, hash: string, config: RenderableSceneConfig): unknown {
  if (!isObject(thing)) return thing;
  const out: Record<string, unknown> = { ...thing };
  delete out[config.liveSourceField];
  setPath(out, config.artifactHashPath, hash);
  return out;
}

/**
 * Rewrite a decoded capsule's scene tree so every component mounts from its frozen
 * content hash (static CAS artifact). Returns a NEW tree (input untouched). Pure;
 * blind to node kind; recurses `children`.
 */
export function capsuleToRenderableScene(
  input: CapsuleRenderInput,
  config: RenderableSceneConfig = DEFAULT_RENDERABLE_SCENE_CONFIG,
): unknown {
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = { ...node };
    if (Array.isArray(node.children)) out.children = node.children.map(rewrite);

    const props = isObject(node.props) ? node.props : undefined;
    const componentId = node[config.componentIdField] ?? props?.[config.componentIdField];
    if (typeof componentId === 'string' && componentId) {
      const hash = input.artifactHashByRef.get(refKey({ kind: 'component', id: componentId }));
      if (hash) {
        const freezeThings = (things: unknown) =>
          Array.isArray(things) ? things.map((t) => freezeThing(t, hash, config)) : things;
        if (props && Array.isArray(props[config.thingsField])) {
          out.props = { ...props, [config.thingsField]: freezeThings(props[config.thingsField]) };
        } else if (Array.isArray(node[config.thingsField])) {
          out[config.thingsField] = freezeThings(node[config.thingsField]);
        }
      }
    }
    return out;
  };
  return rewrite(input.sceneTree);
}
