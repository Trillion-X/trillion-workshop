import type { SceneNode } from '@/packages/documents/read-data/documents';
import { createBlindRegistry, type BlindRegistry } from '@/packages/ui/show/blind-registry/blind-registry';

export type ComponentMountState = 'ready' | 'loading' | 'missing' | 'unknown' | 'error';

export interface CompositionComponentMountContext {
  readonly signal: AbortSignal;
  readonly reducedMotion: boolean;
  readonly hidden: boolean;
}

export interface CompositionComponentMountResult {
  readonly state?: ComponentMountState;
  readonly dispose?: () => void;
  readonly suspend?: () => void;
  readonly resume?: () => void;
}

/** Component mounting stays a caller-provided owner seam. */
export type MountCompositionComponent = (
  target: HTMLElement,
  node: SceneNode,
  context: CompositionComponentMountContext,
) => CompositionComponentMountResult | boolean | void;

export interface OwnerSurfaceMountRequest extends CompositionComponentMountContext {
  readonly target: HTMLElement;
  readonly node: SceneNode;
  readonly contentRef: unknown;
  readonly surfaceInput?: Readonly<Record<string, unknown>>;
}

export type OwnerSurfaceMounter = (
  request: OwnerSurfaceMountRequest,
) => CompositionComponentMountResult | boolean | void;

export interface OwnerSurfaceMountRegistry {
  register(ref: string, mounter: OwnerSurfaceMounter): void;
  has(ref: string): boolean;
  refs(): string[];
  readonly mountComponent: MountCompositionComponent;
}

/**
 * Production registry for DATA-selected owner surfaces. It reuses the shared
 * blind-registry primitive, so adding a new owner reference is one registration
 * at composition assembly with no renderer branch or source edit.
 */
export function createOwnerSurfaceMountRegistry(): OwnerSurfaceMountRegistry {
  const registry: BlindRegistry<OwnerSurfaceMounter> = createBlindRegistry();
  return {
    register: (ref, mounter) => registry.register(ref, mounter),
    has: (ref) => registry.has(ref),
    refs: () => registry.keys(),
    mountComponent: createOwnerSurfaceMount((request) => {
      if (typeof request.contentRef !== 'string') return false;
      const mounter = registry.get(request.contentRef);
      return mounter ? mounter(request) : false;
    }),
  };
}

/**
 * Generic bridge from a Component node to its owning surface. `content_ref`
 * remains opaque, so the renderer does not acquire package or product branches.
 */
export function createOwnerSurfaceMount(mountSurface: OwnerSurfaceMounter): MountCompositionComponent {
  return (target, node, context) => {
    const contentRef = componentContentRef(node);
    if (contentRef === undefined || contentRef === null) {
      return renderMountState(target, 'missing', 'This content is not available right now.');
    }
    try {
      const result = mountSurface({
        target,
        node,
        contentRef,
        surfaceInput: componentSurfaceInput(node),
        ...context,
      });
      return result === false
        ? renderMountState(target, 'unknown', 'This content is not available right now.')
        : result;
    } catch {
      return renderMountState(target, 'error', 'This content could not be shown.');
    }
  };
}

/** Default component rendering is a readable fallback for generic snapshots. */
export function mountComponent(target: HTMLElement, node: SceneNode): CompositionComponentMountResult {
  target.textContent = componentLabel(node);
  return { state: 'ready' };
}

export function componentLabel(node: SceneNode): string {
  const props = node.props ?? {};
  const custom = isRecord(props.custom) ? props.custom : {};
  return stringValue(custom.label)
    ?? stringValue(props.label)
    ?? stringValue(props.component_id)
    ?? node.id;
}

function componentContentRef(node: SceneNode): unknown {
  const props = node.props ?? {};
  const custom = isRecord(props.custom) ? props.custom : {};
  return props.content_ref ?? custom.content_ref;
}

function componentSurfaceInput(node: SceneNode): Readonly<Record<string, unknown>> | undefined {
  const props = node.props ?? {};
  const custom = isRecord(props.custom) ? props.custom : {};
  const input = props.surface_input ?? custom.surface_input;
  return isRecord(input) ? input : undefined;
}

function renderMountState(
  target: HTMLElement,
  state: Exclude<ComponentMountState, 'ready' | 'loading'>,
  message: string,
): CompositionComponentMountResult {
  target.dataset.compositionMountState = state;
  target.textContent = message;
  return { state };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
