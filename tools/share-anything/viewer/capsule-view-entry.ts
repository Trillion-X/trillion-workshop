// packages/public-scene-share/viewer/capsule-view-entry.ts
//
// PURPOSE
// The public capsule viewer's DOM-bound controller — the function the viewer
// document (`capsule-view.html`) calls on load. It is the thin, painter-injected
// layer that sits directly above the pure `mountCapsuleFromHash` core:
//
//   URL  ──capsuleHashFromUrl──▶ hash
//   hash ──fetch('/cas/<hash>')─▶ bytes      (the /cas fetch adapter lives here)
//   (bytes, painter) ──mountCapsuleFromHash──▶ rendered scene  OR  structured reason
//   reason ──renderError──▶ a real error element in the page    (fail-closed, visible)
//
// WHY THIS IS A SEPARATE LAYER FROM mount-capsule.ts: `mountCapsuleFromHash` is
// pure over injected I/O + painter and has NO knowledge of URLs, `/cas`, or the DOM.
// This module binds those three real-world edges (location URL, the `/cas` HTTP
// shape, and a DOM mount root for the error state). Splitting them keeps the core
// testable without a DOM and lets this edge layer be swapped per host.
//
// PAINTER STILL INJECTED (`deps.mountScene`): the document's bundle supplies the
// real scene painter; this controller never imports it. That decouples the viewer
// from WHERE the painter source lives (it is mid-extraction to a Runtime Kit leaf)
// and keeps the cross-origin viewer (which bundles its own painter) and the local
// owner-preview (which imports the shell painter) on ONE code path.
//
// BLIND (L090) + FAIL-CLOSED: every failure renders a visible error element with a
// structured reason — never a blank page, never a half-scene.

import { mountCapsuleFromHash, capsuleHashFromUrl, type CapsuleViewerDeps } from '../render/mount-capsule';
import { type MountCapsuleResult } from '../render/mount-capsule';
import { DEFAULT_RENDERABLE_SCENE_CONFIG, type RenderableSceneConfig } from '../render/to-renderable-scene';

/** The minimal DOM surface this controller touches — a real `Document` satisfies it. */
export interface ViewerDocumentLike {
  getElementById(id: string): ViewerElementLike | null;
  createElement(tagName: string): ViewerElementLike;
}
export interface ViewerElementLike {
  textContent: string | null;
  className: string;
  replaceChildren(...nodes: ViewerElementLike[]): void;
  appendChild(node: ViewerElementLike): ViewerElementLike;
  setAttribute(name: string, value: string): void;
}

/** Everything the viewer needs from its host document. Painter + fetch are injected. */
export interface CapsuleViewerOptions {
  /** The viewer's own location URL — the capsule hash is read from it (`?c=` or `/c/<hash>`). */
  readonly url: URL;
  /** The host document (a browser `Document`, or any `ViewerDocumentLike` in a test). */
  readonly doc: ViewerDocumentLike;
  /** Mount the rewritten scene tree into the page — the real scene painter, injected. */
  readonly mountScene: (sceneTree: unknown) => Promise<void> | void;
  /** `fetch` implementation; defaults to the ambient global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Id of the element that holds the rendered scene / error state. Default `capsule-root`. */
  readonly rootId?: string;
  /** URL query key for the hash. Default `c` (DATA — the URL shape is config). */
  readonly queryKey?: string;
  /** CAS path prefix the hash is fetched from. Default `/cas/`. */
  readonly casPathPrefix?: string;
  /** Painter-contract config, forwarded to the scene rewrite. */
  readonly renderConfig?: RenderableSceneConfig;
}

/**
 * Run the viewer against a document + URL. Resolves to the same structured
 * `MountCapsuleResult` the core returns; on failure it has ALSO rendered a visible
 * error element into the root, so the page never silently blanks. Never throws for
 * a load/decode/mount failure — only for a genuine wiring bug (missing root element).
 */
export async function runCapsuleViewer(options: CapsuleViewerOptions): Promise<MountCapsuleResult> {
  const {
    url,
    doc,
    mountScene,
    fetchImpl = globalThis.fetch,
    rootId = 'capsule-root',
    queryKey = 'c',
    casPathPrefix = '/cas/',
    renderConfig = DEFAULT_RENDERABLE_SCENE_CONFIG,
  } = options;

  const root = doc.getElementById(rootId);
  if (!root) {
    // A missing mount root is a wiring bug in the document, not a capsule failure.
    throw new Error(`capsule viewer: no #${rootId} element in the document`);
  }

  const hash = capsuleHashFromUrl(url, queryKey);
  if (!hash) {
    return renderFailure(doc, root, 'no capsule specified in the link');
  }

  if (typeof fetchImpl !== 'function') {
    return renderFailure(doc, root, 'no fetch implementation available to load the capsule');
  }

  const deps: CapsuleViewerDeps = {
    fetchCapsuleBytes: async (h) => {
      const response = await fetchImpl(`${casPathPrefix}${encodeURIComponent(h)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    mountScene,
  };

  const result = await mountCapsuleFromHash(hash, deps, renderConfig);
  if (!result.ok) {
    return renderFailure(doc, root, result.reason);
  }
  return result;
}

/** Render a visible, structured error into the mount root and return the failure result. */
function renderFailure(
  doc: ViewerDocumentLike,
  root: ViewerElementLike,
  reason: string,
): MountCapsuleResult {
  const errorEl = doc.createElement('div');
  errorEl.className = 'capsule-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.textContent = `This shared scene could not be opened: ${reason}`;
  root.replaceChildren(errorEl);
  return { ok: false, reason };
}
