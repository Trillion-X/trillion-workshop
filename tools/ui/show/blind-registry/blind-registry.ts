// packages/ui/show/blind-registry/blind-registry.ts
//
// PURPOSE
// The one generative primitive behind every "self-describing data key → handler"
// dispatch in the codebase (L069). A blind registry maps an OPEN string key to a
// handler by LOOKUP — never a `switch`/`if (key === ...)`. Adding a key is one
// `register()` call + zero change to any dispatcher. This is the shared core that
// the walkthrough content-renderer registry, the anchor ref-resolver registry,
// and the progress-style registry are all configurations of (and any future
// data-driven dispatch should reuse it instead of hand-rolling a Map).
//
// WHY ONE PRIMITIVE (L069 / L100)
// Three near-identical Maps with register/resolve/has had appeared (content,
// anchor, progress). Per L069 (find the primitive when 3+ share a shape) and
// L100 (genericization shrinks code), they collapse to this. Generic over the
// handler type `R`, so it is framework-agnostic — `R` may be a React component,
// a resolver function, or anything.

export interface BlindRegistry<R> {
  /** Bind a handler to a key. Re-registering replaces (last wins). */
  register(key: string, handler: R): void;
  /** Raw lookup — the handler for `key`, or `undefined` if unregistered. */
  get(key: string): R | undefined;
  /**
   * The handler for `key`, or the configured fallback. Throws only if no handler
   * is registered AND no fallback was configured (a programmer error, not a DATA
   * error — DATA authors should always have a fallback).
   */
  resolve(key: string): R;
  /** Whether a handler is explicitly registered for `key` (fallback excluded). */
  has(key: string): boolean;
  /** All explicitly registered keys (diagnostics/conformance — never for branching). */
  keys(): string[];
}

/**
 * Create a blind registry. Pass `{ fallback }` to make `resolve` total (unknown
 * key → fallback, L083); omit it when callers use `get` and handle `undefined`
 * themselves (e.g. the anchor resolver returns null for an unknown ref kind).
 */
export function createBlindRegistry<R>(options: { fallback?: R } = {}): BlindRegistry<R> {
  const map = new Map<string, R>();
  const hasFallback = 'fallback' in options;
  return {
    register(key, handler) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('blind-registry: key must be a non-empty string');
      }
      map.set(key, handler);
    },
    get(key) {
      return map.get(key);
    },
    resolve(key) {
      const found = map.get(key);
      if (found !== undefined) return found;
      if (hasFallback) return options.fallback as R;
      throw new Error(`blind-registry: no handler for "${key}" and no fallback configured`);
    },
    has(key) {
      return map.has(key);
    },
    keys() {
      return [...map.keys()];
    },
  };
}

/** Bulk-bind a DATA-shaped `{ key: handler }` map. Returns the registry for chaining. */
export function registerAll<R>(registry: BlindRegistry<R>, handlers: Readonly<Record<string, R>>): BlindRegistry<R> {
  for (const [key, handler] of Object.entries(handlers)) registry.register(key, handler);
  return registry;
}
