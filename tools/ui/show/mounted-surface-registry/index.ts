/**
 * Process-local registry for the surfaces that are mounted in the current UI
 * realm. Publishers own their context and mutations; this registry only binds a
 * stable view reference to those owner callbacks so humans and agents address
 * the same live surface.
 */

export type MountedSurfaceContext = Readonly<{
  surface_ref: string;
  selection_refs: readonly string[];
  selection_revision: string;
  camera?: unknown;
  graph_observations?: unknown;
  document_ref?: string;
  document_hash?: string;
  scene_revision?: string;
  [key: string]: unknown;
}>;

export type MountedSurfaceSelectionRequest = Readonly<{
  expected_selection_revision: string;
  selection_refs: readonly string[];
}>;

export type MountedSurfaceController = Readonly<{
  readContext: () => MountedSurfaceContext;
  setSelection?: (request: MountedSurfaceSelectionRequest) => unknown | Promise<unknown>;
  applyPatch?: (request: unknown) => unknown | Promise<unknown>;
}>;

type Registration = Readonly<{
  generation: symbol;
  controller: MountedSurfaceController;
}>;

export class MountedSurfaceRegistry {
  readonly #views = new Map<string, Registration>();

  register(viewRef: string, controller: MountedSurfaceController): () => void {
    const normalizedViewRef = requiredText(viewRef, 'viewRef');
    if (!controller || typeof controller.readContext !== 'function') {
      throw new TypeError('controller.readContext is required');
    }
    const generation = Symbol(normalizedViewRef);
    this.#views.set(normalizedViewRef, { generation, controller });
    return () => {
      if (this.#views.get(normalizedViewRef)?.generation === generation) {
        this.#views.delete(normalizedViewRef);
      }
    };
  }

  has(viewRef: string): boolean {
    return this.#views.has(viewRef);
  }

  list(): readonly string[] {
    return [...this.#views.keys()].sort();
  }

  read(viewRef: string): MountedSurfaceContext {
    const registration = this.#required(viewRef);
    const context = registration.controller.readContext();
    validateContext(context);
    return context;
  }

  async setSelection(viewRef: string, request: MountedSurfaceSelectionRequest): Promise<unknown> {
    const controller = this.#required(viewRef).controller;
    if (typeof controller.setSelection !== 'function') {
      throw new Error(`mounted surface ${viewRef} does not expose selection mutation`);
    }
    validateSelectionRequest(request);
    return controller.setSelection(request);
  }

  async applyPatch(viewRef: string, request: unknown): Promise<unknown> {
    const controller = this.#required(viewRef).controller;
    if (typeof controller.applyPatch !== 'function') {
      throw new Error(`mounted surface ${viewRef} does not expose patch mutation`);
    }
    return controller.applyPatch(request);
  }

  #required(viewRef: string): Registration {
    const normalizedViewRef = requiredText(viewRef, 'viewRef');
    const registration = this.#views.get(normalizedViewRef);
    if (!registration) throw new Error(`mounted surface ${normalizedViewRef} is not active`);
    return registration;
  }
}

export const mountedSurfaceRegistry = new MountedSurfaceRegistry();

function validateContext(value: unknown): asserts value is MountedSurfaceContext {
  if (!isRecord(value)) throw new TypeError('mounted surface context must be a record');
  requiredText(value.surface_ref, 'context.surface_ref');
  requiredText(value.selection_revision, 'context.selection_revision');
  if (!Array.isArray(value.selection_refs) || value.selection_refs.some((ref) => typeof ref !== 'string' || ref.length === 0)) {
    throw new TypeError('context.selection_refs must be an array of non-empty strings');
  }
}

function validateSelectionRequest(value: unknown): asserts value is MountedSurfaceSelectionRequest {
  if (!isRecord(value)) throw new TypeError('selection request must be a record');
  requiredText(value.expected_selection_revision, 'expected_selection_revision');
  if (!Array.isArray(value.selection_refs) || value.selection_refs.some((ref) => typeof ref !== 'string' || ref.length === 0)) {
    throw new TypeError('selection_refs must be an array of non-empty strings');
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
