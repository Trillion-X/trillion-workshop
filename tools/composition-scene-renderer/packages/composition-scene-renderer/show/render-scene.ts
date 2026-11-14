import type {
  CompositionSnapshot,
  SceneNode,
  VisibleEdgeRoute,
} from '@/packages/documents/read-data/documents';
import {
  componentLabel,
  mountComponent as defaultMountComponent,
  type ComponentMountState,
  type CompositionComponentMountContext,
  type CompositionComponentMountResult,
  type MountCompositionComponent,
  type OwnerSurfaceMountRegistry,
} from '@/packages/composition-scene-renderer/show/mount-component';
import {
  resolveSourceRenderDescriptor,
  type RenderDescriptor,
  type SourceItemData,
} from '@/packages/screen-look/read-data/resolve-render-descriptor';

export type RenderSceneOptions = {
  readonly mountComponent?: MountCompositionComponent;
  /** Production assembly path for DATA-selected owner surface registrations. */
  readonly ownerSurfaceRegistry?: OwnerSurfaceMountRegistry;
  readonly renderDescriptors?: Record<string, RenderDescriptor>;
  readonly signal?: AbortSignal;
  readonly hidden?: boolean;
  readonly reducedMotion?: boolean;
};

export interface SceneRenderHandle {
  readonly root: HTMLElement;
  readonly state: ComponentMountState | 'hidden';
  dispose(): void;
  setHidden(hidden: boolean): void;
}

type MountedComponent = Required<Pick<CompositionComponentMountResult, 'dispose'>>
  & Pick<CompositionComponentMountResult, 'suspend' | 'resume'>;

/**
 * Projects a composition snapshot into one DOM root. Every render owns the
 * mounted component lifecycles it starts, so replacement, hiding, cancellation,
 * and unmount cannot leave timers or listeners behind.
 */
type RootOwnership = {
  release(): void;
};

const ROOT_OWNERSHIP = Symbol('composition-scene-root-ownership');

/**
 * One root admits one live scene render. A second `renderScene` into an
 * occupied root releases the previous handle's mounted owner surfaces first,
 * so a replaced scene cannot leave its listeners or timers running.
 */
function acquireRoot(root: HTMLElement): RootOwnership {
  const owner = (root as HTMLElement & { [ROOT_OWNERSHIP]?: RootOwnership })[ROOT_OWNERSHIP];
  owner?.release();
  const ownership: RootOwnership = { release: () => {} };
  Object.defineProperty(root, ROOT_OWNERSHIP, {
    value: ownership,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return ownership;
}

export function renderScene(
  root: HTMLElement,
  snapshot: CompositionSnapshot,
  options: RenderSceneOptions = {},
): SceneRenderHandle {
  const ownership = acquireRoot(root);
  let disposed = false;
  let hidden = options.hidden === true;
  let state: SceneRenderHandle['state'] = hidden ? 'hidden' : 'ready';
  let mounted: MountedComponent[] = [];
  let controller: AbortController | null = null;
  let detachExternalAbort: (() => void) | null = null;

  const releaseMounted = () => {
    for (const mount of mounted.splice(0).reverse()) mount.dispose();
  };

  const disposeActive = () => {
    detachExternalAbort?.();
    detachExternalAbort = null;
    const activeController = controller;
    controller = null;
    activeController?.abort();
    releaseMounted();
  };

  const render = () => {
    disposeActive();
    root.replaceChildren();
    if (disposed) return;

    const sceneRoot = document.createElement('div');
    sceneRoot.setAttribute('data-composition-scene', 'true');
    sceneRoot.style.position = 'relative';
    sceneRoot.style.width = '100%';
    sceneRoot.style.minHeight = '100vh';
    sceneRoot.style.overflow = 'hidden';
    sceneRoot.style.transformOrigin = '0 0';
    sceneRoot.style.transform = cameraTransform(snapshot);
    sceneRoot.dataset.compositionSceneState = hidden ? 'hidden' : 'ready';
    sceneRoot.hidden = hidden;
    root.appendChild(sceneRoot);
    if (hidden) {
      state = 'hidden';
      return;
    }

    controller = new AbortController();
    controller.signal.addEventListener('abort', releaseMounted, { once: true });
    if (options.signal) {
      const abort = () => controller?.abort();
      if (options.signal.aborted) abort();
      else {
        options.signal.addEventListener('abort', abort, { once: true });
        detachExternalAbort = () => options.signal?.removeEventListener('abort', abort);
      }
    }
    const context: CompositionComponentMountContext = {
      signal: controller.signal,
      hidden: false,
      reducedMotion: options.reducedMotion === true,
    };
    const mountedStates: ComponentMountState[] = [];
    if (snapshot.tree) sceneRoot.appendChild(renderNode(snapshot.tree, snapshot, options, context, mounted, mountedStates));
    if (snapshot.visible_edge_routes.length > 0) sceneRoot.appendChild(renderEdges(snapshot.visible_edge_routes));
    // An already-aborted external signal can cancel before a synchronous owner
    // mount returns its disposer. Release that late registration immediately.
    if (controller.signal.aborted) releaseMounted();
    state = mountedStates.find((candidate) => candidate !== 'ready') ?? 'ready';
  };

  const detachFromRoot = () => {
    // A newer render now owns this root. Release this scene's active work
    // first so its owner surfaces, listeners, and timers stop before the
    // replacement render mounts anything, then stop acting on the root.
    if (disposed) return;
    disposed = true;
    disposeActive();
    detachExternalAbort = null;
    controller = null;
    mounted = [];
  };
  ownership.release = detachFromRoot;

  const handle: SceneRenderHandle = {
    root,
    get state() {
      return state;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeActive();
      const current = (root as HTMLElement & { [ROOT_OWNERSHIP]?: RootOwnership })[ROOT_OWNERSHIP];
      if (current === ownership) {
        delete (root as Partial<Record<symbol, RootOwnership>>)[ROOT_OWNERSHIP];
        root.replaceChildren();
      }
    },
    setHidden(nextHidden) {
      if (disposed || hidden === nextHidden) return;
      hidden = nextHidden;
      render();
    },
  };
  render();
  return handle;
}

function renderNode(
  node: SceneNode,
  snapshot: CompositionSnapshot,
  options: RenderSceneOptions,
  context: CompositionComponentMountContext,
  mounted: MountedComponent[],
  mountedStates: ComponentMountState[],
): HTMLElement {
  const element = document.createElement(node.kind === 'Text' ? 'span' : 'div');
  element.setAttribute('data-node-id', node.id);
  element.style.position = 'absolute';
  const frame = snapshot.frames[node.id]?.rect;
  if (frame) {
    element.style.left = `${frame.x}px`;
    element.style.top = `${frame.y}px`;
    element.style.width = `${frame.w}px`;
    element.style.height = `${frame.h}px`;
  }
  if (context.hidden || node.visible === false) {
    element.hidden = true;
    return element;
  }

  if (node.kind === 'Text') {
    element.textContent = textValue(node);
  } else if (node.kind === 'Component') {
    let result: CompositionComponentMountResult | boolean | void;
    try {
      result = (options.mountComponent ?? options.ownerSurfaceRegistry?.mountComponent ?? defaultMountComponent)(element, node, context);
    } catch {
      result = { state: 'error' };
    }
    const normalized = normalizeMount(result);
    mountedStates.push(normalized.state);
    if (normalized.mount) mounted.push(normalized.mount);
    if (normalized.state !== 'ready') {
      element.dataset.compositionMountState = normalized.state;
      if (!element.textContent) element.textContent = componentLabel(node);
    }
  } else if (node.kind === 'Container' && isSourceInsertionContainer(node)) {
    // T6 WIRING: Render Container with source insertion (native source look via render-descriptor)
    // T9: Descriptor lookup from live options.renderDescriptors (bootstrapped by slot harness)
    const sourceData = getSourceInsertionData(node);
    const renderDescriptor = getSourceInsertionDescriptor(node, options.renderDescriptors);
    const html = resolveSourceRenderDescriptor(renderDescriptor, sourceData, null);
    element.innerHTML = html;
  } else {
    for (const child of node.children ?? []) {
      element.appendChild(renderNode(child, snapshot, options, context, mounted, mountedStates));
    }
  }
  return element;
}

function normalizeMount(result: CompositionComponentMountResult | boolean | void): {
  readonly state: ComponentMountState;
  readonly mount: MountedComponent | null;
} {
  if (result === false) return { state: 'unknown', mount: null };
  if (result === true || result === undefined) return { state: 'ready', mount: null };
  return {
    state: result.state ?? 'ready',
    mount: result.dispose ? {
      dispose: result.dispose,
      ...(result.suspend ? { suspend: result.suspend } : {}),
      ...(result.resume ? { resume: result.resume } : {}),
    } : null,
  };
}

function renderEdges(routes: readonly VisibleEdgeRoute[]): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('data-composition-edges', 'true');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.style.inset = '0';
  svg.style.overflow = 'visible';
  for (const route of routes) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('data-edge-id', route.edge_id);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('d', routePath(route));
    svg.appendChild(path);
  }
  return svg;
}

function routePath(route: VisibleEdgeRoute): string {
  return route.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function cameraTransform(snapshot: CompositionSnapshot): string {
  const camera = snapshot.camera;
  return `translate(${camera.pan_x}px, ${camera.pan_y}px) scale(${camera.zoom})`;
}

function textValue(node: SceneNode): string {
  const value = node.props?.text;
  return typeof value === 'string' ? value : '';
}

/**
 * T6: Check if a Container node carries sourceInsertion (source item to render).
 * L090 — self-describing: presence of props.sourceInsertion is the discriminant.
 */
function isSourceInsertionContainer(node: SceneNode): boolean {
  if (node.kind !== 'Container') return false;
  const props = node.props as Record<string, unknown> | undefined;
  if (!props) return false;
  const sourceInsertion = props.sourceInsertion as Record<string, unknown> | undefined;
  return !!sourceInsertion;
}

/**
 * Extract sourceData (the atom) from a Container's sourceInsertion props.
 */
function getSourceInsertionData(node: SceneNode): SourceItemData | null {
  const props = node.props as Record<string, unknown> | undefined;
  if (!props) return null;
  const sourceInsertion = props.sourceInsertion as Record<string, unknown> | undefined;
  if (!sourceInsertion) return null;
  const sourceData = sourceInsertion.sourceData as SourceItemData | undefined;
  return sourceData || null;
}

/**
 * T9 WIRING: Extract renderDescriptorRef and fetch the real render-descriptor.
 *
 * The renderDescriptorRef is the subject_id of a render-descriptor record (e.g., "render:slack-thread-bubble").
 * The composition-scene-renderer slot harness bootstraps all render-descriptor records from the log
 * via find-current-items(property_id=prop:render-descriptor) and passes them as options.renderDescriptors
 * to renderScene(). This function looks up the descriptor from that cache.
 *
 * If not found or cache is empty, returns null to trigger the generic default renderer (L083 fail-open).
 * The generic renderer handles all source atoms; specific native looks are opt-in via DATA rows.
 *
 * Examples of render-descriptor DATA rows (from screen-look/things-to-store-and-run.json):
 *   - render:slack-thread-bubble (layout: bubble, colors from screen-look palette)
 *   - render:x-bookmark-card (layout: card)
 *   - render:pinterest-pin-grid (layout: grid, image-heavy)
 */
function getSourceInsertionDescriptor(
  node: SceneNode,
  renderDescriptors?: Record<string, RenderDescriptor>,
): RenderDescriptor | null {
  const props = node.props as Record<string, unknown> | undefined;
  if (!props) return null;
  const sourceInsertion = props.sourceInsertion as Record<string, unknown> | undefined;
  if (!sourceInsertion) return null;

  const renderDescriptorRef = sourceInsertion.renderDescriptorRef as string | undefined;
  if (!renderDescriptorRef) return null;

  // L090: Self-describing lookup — the renderDescriptorRef is the key.
  // The slot harness bootstrapped renderDescriptors from the log's render-descriptor records.
  // If the ref is not found, fall back to generic default (L083 fail-open).
  return renderDescriptors?.[renderDescriptorRef] ?? null;
}
