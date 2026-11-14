/** Browser-realm registry for local inputs that cannot be fetched by a remote target. */

export type LocalActionInputHandler = (request: Record<string, unknown>) => unknown | Promise<unknown>;

type Registration = { token: symbol; handler: LocalActionInputHandler };
type RegistryState = Map<string, Registration[]>;

const REGISTRY_KEY = '__BITFIELD_LOCAL_ACTION_INPUTS__';

function registry(): RegistryState {
  const host = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RegistryState };
  if (!(host[REGISTRY_KEY] instanceof Map)) host[REGISTRY_KEY] = new Map();
  return host[REGISTRY_KEY]!;
}

export function registerLocalActionInput(capability: string, handler: LocalActionInputHandler): () => void {
  const key = requiredText(capability, 'capability');
  if (typeof handler !== 'function') throw new TypeError('local action input handler is required');
  const token = Symbol(key);
  const registrations = registry().get(key) ?? [];
  registrations.push({ token, handler });
  registry().set(key, registrations);
  return () => {
    const current = registry().get(key) ?? [];
    const next = current.filter((registration) => registration.token !== token);
    if (next.length > 0) registry().set(key, next);
    else registry().delete(key);
  };
}

export async function invokeLocalActionInput(capability: string, request: Record<string, unknown>): Promise<unknown> {
  const key = requiredText(capability, 'capability');
  const handler = (registry().get(key) ?? []).at(-1)?.handler;
  if (!handler) throw new Error(`local action input capability is not mounted: ${key}`);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('local action input request must be a record');
  }
  return handler(request);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text`);
  return value.trim();
}
