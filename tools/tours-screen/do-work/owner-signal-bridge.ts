import { dispatchStepPerform, type StepPerform } from './dispatch-step-perform.ts';
import type { OwnerSignalBridge } from '../show/WalkthroughSurface.tsx';

export interface OwnerSignalTarget extends StepPerform {
  /** Optional generic projection from an owner reply to the fact being gated. */
  readonly read_path?: readonly string[];
}

export type OwnerSignalTargetMap = Readonly<Record<string, OwnerSignalTarget>>;

export type OwnerSignalContextParamSource =
  | { readonly $source: 'local_storage'; readonly key: string }
  | { readonly $source: 'scope_ref' };

interface BridgeDependencies {
  readonly resolveContextParam?: (source: OwnerSignalContextParamSource, context: {
    readonly definitionId: string;
    readonly stepId: string;
    readonly scopeRef?: string;
  }) => string | null;
  readonly dispatch?: (perform: StepPerform) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function localStorageParam(source: OwnerSignalContextParamSource): string | null {
  if (source.$source !== 'local_storage' || typeof source.key !== 'string' || !source.key.trim()) return null;
  try {
    const value = globalThis.localStorage?.getItem(source.key);
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function defaultResolveContextParam(
  source: OwnerSignalContextParamSource,
  context: { readonly scopeRef?: string },
): string | null {
  if (source.$source === 'scope_ref') return typeof context.scopeRef === 'string' && context.scopeRef ? context.scopeRef : null;
  return localStorageParam(source);
}

function resolveParams(
  value: unknown,
  context: Parameters<NonNullable<BridgeDependencies['resolveContextParam']>>[1],
  resolve: NonNullable<BridgeDependencies['resolveContextParam']>,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const resolved: Record<string, unknown> = Object.create(null);
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.$source !== 'string') {
      resolved[key] = raw;
      continue;
    }
    const source = raw as unknown as OwnerSignalContextParamSource;
    const param = resolve(source, context);
    if (param === null) return null;
    resolved[key] = param;
  }
  return resolved;
}

function decodeReply(value: unknown): unknown {
  let decoded = value;
  if (isRecord(decoded) && ArrayBuffer.isView(decoded.payload)) decoded = decoded.payload;
  if (!ArrayBuffer.isView(decoded)) return decoded;
  try {
    const text = new TextDecoder().decode(decoded as ArrayBufferView);
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function projectReply(value: unknown, path: readonly string[] | undefined): unknown {
  if (!path?.length) return value;
  let current = value;
  for (const part of path) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  return current ?? null;
}

export function ownerSignalTargetMap(value: unknown): OwnerSignalTargetMap | null {
  if (!isRecord(value)) return null;
  const targets: Record<string, OwnerSignalTarget> = Object.create(null);
  for (const [ref, descriptor] of Object.entries(value)) {
    if (!ref || !isRecord(descriptor)) continue;
    if (typeof descriptor.target !== 'string' || !descriptor.target) continue;
    if (typeof descriptor.operation !== 'string' || !descriptor.operation) continue;
    targets[ref] = descriptor as OwnerSignalTarget;
  }
  return Object.keys(targets).length ? targets : null;
}

export function buildOwnerSignalBridge(
  targets: OwnerSignalTargetMap,
  dependencies: BridgeDependencies = {},
): OwnerSignalBridge {
  const resolve = dependencies.resolveContextParam ?? defaultResolveContextParam;
  const dispatch = dependencies.dispatch ?? dispatchStepPerform;
  return async (refs, context) => {
    const entries = await Promise.all(refs.map(async (ref) => {
      const descriptor = Object.hasOwn(targets, ref) ? targets[ref] : undefined;
      if (!descriptor) return [ref, null] as const;
      const params = resolveParams(descriptor.params ?? {}, context, resolve);
      if (!params) return [ref, null] as const;
      try {
        return [ref, projectReply(decodeReply(await dispatch({ ...descriptor, params })), descriptor.read_path)] as const;
      } catch {
        return [ref, null] as const;
      }
    }));
    return Object.fromEntries(entries);
  };
}
