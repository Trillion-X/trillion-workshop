// packages/ui/show/step-content-renderer/step-content-renderer.ts
//
// PURPOSE
// The blind content-renderer registry for the guided-overlay walkthrough engine
// (N5 / mechanism M5). A walkthrough step carries a self-describing content
// descriptor `{ content_kind, payload }`; this registry maps the raw `content_kind`
// string to a renderer by LOOKUP, never by `switch`/`if (kind === ...)`. The
// engine never inspects `payload` — only the registered renderer owns its shape.
//
// THE L069 PROPERTY (validated by the plan's convergence gate F1/F2/F6)
// Adding a new content kind (`text`, `media`, `quiz`, `outcome`, or anything
// invented in 2099) is ONE `register(kind, renderer)` call + ZERO change to this
// file. There is no closed union, no enumerated kind list, no branch on kind.
// The registry is generic over the renderer type `R`, so it is framework-agnostic
// (R may be a React component, a render function, or a native mounter) — the
// mechanism is identical.
//
// L083 SAFE DEFAULT: an unknown `content_kind` resolves to the registered
// `fallback` renderer (never throws, never blanks) — a -1000 IQ DATA author who
// names a kind nobody registered still gets a sane render, not a crash.

import { createBlindRegistry } from '../blind-registry/blind-registry';

/** A step's content as it appears in walkthrough DATA. `payload` is renderer-owned. */
export interface StepContentDescriptor {
  /** Raw open discriminator (L090). Never an enum in code. */
  readonly content_kind: string;
  /** Opaque to the registry — only the resolved renderer understands it. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * A blind registry of renderers keyed by raw `content_kind`. This is a thin,
 * domain-named facade over the shared `blind-registry` primitive (L069/L100) —
 * `kinds()` is the registry's `keys()`.
 */
export interface StepContentRegistry<R> {
  /** Bind a renderer to a content kind. Re-registering replaces (last wins). */
  register(kind: string, renderer: R): void;
  /** The renderer for `kind`, or the fallback if none is registered. Pure lookup. */
  resolve(kind: string): R;
  /** Whether a renderer is explicitly registered for `kind` (fallback excluded). */
  has(kind: string): boolean;
  /** All explicitly registered kinds (for diagnostics/conformance — not for branching). */
  kinds(): string[];
}

/**
 * Create a blind content-renderer registry. `fallback` is returned by `resolve`
 * for any unregistered kind (L083). Delegates to the shared blind-registry — the
 * content registry adds only the domain name (`kind`/`kinds`), not a second Map.
 */
export function createStepContentRegistry<R>(fallback: R): StepContentRegistry<R> {
  const reg = createBlindRegistry<R>({ fallback });
  return {
    register: (kind, renderer) => reg.register(kind, renderer),
    resolve: (kind) => reg.resolve(kind),
    has: (kind) => reg.has(kind),
    kinds: () => reg.keys(),
  };
}

/**
 * Register many renderers at once (DATA-shaped: a map of kind→renderer). Returns
 * the same registry for chaining. Useful for a consumer's default renderer set.
 */
export function registerStepContentRenderers<R>(
  registry: StepContentRegistry<R>,
  renderers: Readonly<Record<string, R>>,
): StepContentRegistry<R> {
  for (const [kind, renderer] of Object.entries(renderers)) registry.register(kind, renderer);
  return registry;
}
