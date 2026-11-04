import {
  cssEscape,
  resolveAnchorRect,
  type AnchorRef,
  type AnchorResolverRegistry,
  type Rect,
} from '../../ui/show/anchor-resolver/anchor-resolver';

export type TargetResolutionFailure =
  | 'invalid-target-ref'
  | 'invalid-selector'
  | 'no-resolver'
  | 'not-found'
  | 'not-visible';

export type WalkthroughTargetResolution =
  | { readonly status: 'resolved'; readonly ref: AnchorRef; readonly rect: Rect; readonly element: Element }
  | { readonly status: 'unresolved'; readonly ref: AnchorRef | null; readonly reason: TargetResolutionFailure };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function selectorForId(id: string): string {
  return `[id="${cssEscape(id)}"]`;
}

function selectorForDataAttribute(attribute: string, value: string): string | null {
  if (!/^data-[a-z0-9_-]+$/u.test(attribute)) return null;
  return `[${attribute}="${cssEscape(value)}"]`;
}

/**
 * Translate every supported walkthrough target spelling to the canonical open
 * AnchorRef contract. The legacy kind/selector form remains readable so an old
 * authored record does not silently lose its target, while all new DATA can use
 * from/query, id, data_attribute, or the stable target_key shorthand.
 */
export function normalizeWalkthroughTargetRef(value: unknown): AnchorRef | null {
  const input = record(value);
  if (!input) return null;

  const from = nonEmpty(input.from);
  const canonicalQuery = nonEmpty(input.query);
  if (from && (from === 'selector' ? !!canonicalQuery : from !== 'id' && from !== 'data-attribute' && from !== 'target-key')) {
    return {
      from,
      ...(canonicalQuery ? { query: canonicalQuery } : {}),
      ...(nonEmpty(input.family) ? { family: nonEmpty(input.family)! } : {}),
      ...(record(input.parts) ? { parts: input.parts as Record<string, string> } : {}),
    };
  }

  const selector = nonEmpty(input.selector);
  if ((input.kind === 'selector' || from === 'selector') && selector) {
    return { from: 'selector', query: selector };
  }

  const id = nonEmpty(input.id);
  if (id && (input.kind === 'id' || from === 'id' || !input.kind)) {
    return { from: 'selector', query: selectorForId(id) };
  }

  const targetKey = nonEmpty(input.target_key) ?? nonEmpty(input.targetKey);
  if (targetKey) {
    return {
      from: 'selector',
      query: `[data-guided-overlay-target="${cssEscape(targetKey)}"], [data-guided-target="${cssEscape(targetKey)}"]`,
    };
  }

  const data = record(input.data_attribute) ?? record(input.dataAttribute) ?? input;
  const attribute = nonEmpty(data.attribute) ?? nonEmpty(data.name);
  const attributeValue = nonEmpty(data.value);
  if (attribute && attributeValue && (input.kind === 'data-attribute' || from === 'data-attribute' || data !== input)) {
    const query = selectorForDataAttribute(attribute, attributeValue);
    return query ? { from: 'selector', query } : null;
  }

  return null;
}

/** Resolve one target and convert querySelector exceptions into an inspectable failure. */
export function resolveWalkthroughTarget(
  registry: AnchorResolverRegistry,
  value: unknown,
  root?: ParentNode,
): WalkthroughTargetResolution {
  const ref = normalizeWalkthroughTargetRef(value);
  if (!ref) return { status: 'unresolved', ref: null, reason: 'invalid-target-ref' };
  try {
    if (ref.from === 'selector' && ref.query && root) {
      const matches = Array.from(root.querySelectorAll(ref.query));
      if (matches.length === 0) return { status: 'unresolved', ref, reason: 'not-found' };
      const visible = matches.flatMap((element) => {
        if (!element.isConnected) return [];
        const rect = element.getBoundingClientRect();
        const style = element instanceof HTMLElement && typeof getComputedStyle === 'function'
          ? getComputedStyle(element)
          : null;
        if (rect.width <= 0 || rect.height <= 0 || style?.display === 'none' || style?.visibility === 'hidden') return [];
        return [{ element, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }];
      });
      if (visible.length === 0) return { status: 'unresolved', ref, reason: 'not-visible' };
      // The same control can show in more than one place (a screen's row in its own list and in New, a screen open in two
      // panes): the step points at the first one the person can see whole, else the first one shown.
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : Infinity;
      const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : Infinity;
      const inView = visible.find(({ rect }) => rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewportWidth && rect.y + rect.height <= viewportHeight);
      return { status: 'resolved', ref, ...(inView ?? visible[0]) };
    }
    const result = resolveAnchorRect(registry, ref, root);
    if (result.status === 'unresolved') return { ...result, ref };
    if (!result.element.isConnected) return { status: 'unresolved', ref, reason: 'not-found' };
    const style = result.element instanceof HTMLElement && typeof getComputedStyle === 'function'
      ? getComputedStyle(result.element)
      : null;
    if (result.rect.width <= 0 || result.rect.height <= 0 || style?.display === 'none' || style?.visibility === 'hidden') {
      return { status: 'unresolved', ref, reason: 'not-visible' };
    }
    return { ...result, ref };
  } catch {
    return { status: 'unresolved', ref, reason: 'invalid-selector' };
  }
}

export function targetRefSummary(value: unknown): string {
  const normalized = normalizeWalkthroughTargetRef(value);
  if (!normalized) return 'invalid target descriptor';
  if (normalized.from === 'selector') return normalized.query ?? 'selector without a query';
  return normalized.from;
}
