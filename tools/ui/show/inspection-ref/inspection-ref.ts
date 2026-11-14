// packages/ui/show/inspection-ref/inspection-ref.ts

import {
  NODE_REF_ATTR,
  parseNodeRef,
  serializeNodeRef,
  type NodeRef,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';
import {
  createBlindRegistry,
  type BlindRegistry,
} from '../blind-registry/blind-registry';

/** The DOM attribute a render target stamps to become inspectable. */
export const INSPECTION_REF_ATTR = 'data-inspection-ref';

/** An inspection ref IS a NodeRef — `family` is an open string owned by whoever stamps it. */
export type InspectionRef = NodeRef;

/** How an edit to a source travels back to its owner. Every field is data. */
export interface InspectionWriteDescriptor {
  /** Open write-kind key — dispatched by the host through a registry, never a switch. */
  readonly kind: string;
  /** For workflow-backed writes: the owner's definition id. */
  readonly definitionId?: string;
  /** Input skeleton; `$value` / `$record` / `$parts.<key>` placeholders are substituted at dispatch. */
  readonly inputTemplate?: Record<string, unknown>;
  /** For direct log writes: guard on the current payload. Defaults to true at dispatch. */
  readonly expectedCurrent?: boolean;
}

/** One data source behind a rendered target. `write` absent = read-only provenance. */
export interface InspectionSource {
  readonly recordAddress: string;
  readonly fieldPath?: readonly string[];
  readonly descriptorRef?: string;
  readonly write?: InspectionWriteDescriptor;
  readonly label?: string;
  /** Self-describing editor shape (opaque to `ui` — never enumerated here). The
   *  blind editor dispatcher threads it to the host-injected shape→editor
   *  capability registry so ONE editor mechanism serves every field of every
   *  shape (L069/L090). Absent = fall back to the built-in scalar/structured editor. */
  readonly shape?: string;
  /** How the inspector draws a plain value: a setting row of the shared inspector (TuningPanel `TuningSetting`
   *  without its key and label: widget, min, max, step, unit, prefix, options). Absent = drawn from the value
   *  itself (a colour code as a colour, a number as a number field, on/off as a switch, words as words). */
  readonly setting?: Readonly<Record<string, unknown>> & { readonly widget?: string };
}

/** Maps a ref (+ its element) to the data sources it stands for. Registered per `family`. */
export type InspectionResolver = (
  ref: InspectionRef,
  element: Element,
) => readonly InspectionSource[] | null;

/** A blind family→resolver registry. Unknown families are skipped by resolution, never errors. */
export function createInspectionResolverRegistry(): BlindRegistry<InspectionResolver> {
  return createBlindRegistry<InspectionResolver>();
}

/** The attribute map to spread onto a render target so it becomes inspectable. */
export function stampInspectionRef(ref: InspectionRef): Record<string, string> {
  return { [INSPECTION_REF_ATTR]: serializeNodeRef(ref) };
}

/** The attributes resolution walks. A NodeRef IS an inspection ref, so every
 *  element already stamped `data-node-ref` (canvas nodes, containers, tabs) is
 *  inspectable the moment its family gets a resolver — zero re-stamping. */
const RESOLUTION_ATTRS: readonly string[] = [INSPECTION_REF_ATTR, NODE_REF_ATTR];
const RESOLUTION_SELECTOR = RESOLUTION_ATTRS.map((attr) => `[${attr}]`).join(',');

/**
 * Resolve every data source behind `target`, nearest stamped element first.
 * Walks the element's own `closest()` chain — a portaled element resolves its
 * own stamp regardless of where it sits in the document. Elements whose family
 * has no registered resolver contribute nothing (and stop nothing).
 */
export function resolveInspection(
  target: Element,
  registry: BlindRegistry<InspectionResolver>,
): readonly InspectionSource[] {
  const sources: InspectionSource[] = [];
  let el: Element | null = target.closest(RESOLUTION_SELECTOR);
  while (el) {
    for (const attr of RESOLUTION_ATTRS) {
      const ref = parseNodeRef(el.getAttribute(attr));
      if (!ref) continue;
      const resolver = registry.get(ref.family);
      const found = resolver ? resolver(ref, el) : null;
      if (found) sources.push(...found);
    }
    el = el.parentElement?.closest(RESOLUTION_SELECTOR) ?? null;
  }
  return sources;
}

/**
 * Substitute `$value`, `$record`, and `$parts.<key>` placeholders in a write
 * descriptor's input template. Non-placeholder values pass through verbatim;
 * nested objects/arrays are walked. Pure — the caller owns dispatch.
 */
export function substituteWriteInput(
  template: Record<string, unknown> | undefined,
  context: { value: unknown; record: unknown; parts: Record<string, string> },
): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (node === '$value') return context.value;
      if (node === '$record') return context.record;
      if (node.startsWith('$parts.')) return context.parts[node.slice('$parts.'.length)];
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) out[key] = walk(value);
      return out;
    }
    return node;
  };
  return walk(template ?? {}) as Record<string, unknown>;
}
