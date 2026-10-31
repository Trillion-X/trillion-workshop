// tools/turn-frames-into-slides/read-data/node-ref.ts
//
// A NodeRef is the one universal addressed handle for any interactable object
// in a surface — a tab, a container, a tab-group, a surface, a canvas, and
// tomorrow a drawing / layout / board-item. It is the SAME address type the
// Visual Layer Stack and the Drop-Intent Router already use, so rendering,
// dropping, decorating, reordering, and acting all speak one address.
//
// `family` is a Society string published by whoever owns the node — the generic
// core never enumerates it (no NodeKind union, no switch(kind)). New kinds
// publish new family strings; everything generic keeps working.

import type { AddressRef } from './visual-layer-types.ts';

export type NodeRef = AddressRef;

/** The DOM attribute every interactable object stamps so the generic layer can find it. */
export const NODE_REF_ATTR = 'data-node-ref';

/**
 * Serialize a NodeRef to a stable string (sorted parts → deterministic), safe
 * for a DOM attribute and for use as a map key.
 */
export function serializeNodeRef(ref: NodeRef): string {
  const parts = ref.parts ?? {};
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(parts).sort()) sorted[key] = parts[key];
  return JSON.stringify({ family: ref.family, parts: sorted });
}

/** Parse a serialized NodeRef back into the address, or null if malformed. */
export function parseNodeRef(value: string | null | undefined): NodeRef | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { family?: unknown }).family === 'string'
    ) {
      const family = (parsed as { family: string }).family;
      const rawParts = (parsed as { parts?: unknown }).parts;
      const parts: Record<string, string> = {};
      if (rawParts && typeof rawParts === 'object') {
        for (const [key, val] of Object.entries(rawParts as Record<string, unknown>)) {
          if (typeof val === 'string') parts[key] = val;
        }
      }
      return { family, parts };
    }
  } catch {
    /* malformed → null */
  }
  return null;
}

/** Two NodeRefs address the same node iff their serializations match. */
export function sameNodeRef(a: NodeRef | null, b: NodeRef | null): boolean {
  if (!a || !b) return a === b;
  return serializeNodeRef(a) === serializeNodeRef(b);
}

/**
 * Walk up from an event target to the nearest stamped node. This is what
 * anchors a context menu to the real addressed element instead of guessing
 * viewport coordinates.
 */
export function closestNodeRef(target: EventTarget | null): { ref: NodeRef; element: HTMLElement } | null {
  let el = target instanceof HTMLElement ? target : null;
  const host = el?.closest(`[${NODE_REF_ATTR}]`);
  if (host instanceof HTMLElement) {
    const ref = parseNodeRef(host.getAttribute(NODE_REF_ATTR));
    if (ref) return { ref, element: host };
  }
  // eslint-disable-next-line no-console
  if (typeof console !== 'undefined') console.debug('[node-ref] no data-node-ref ancestor for target');
  return null;
}
