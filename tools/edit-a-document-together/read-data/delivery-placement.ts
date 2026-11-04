import type { CompositionContent, SceneNode } from './documents';

// Opaque delivery identities are owner data on the inserted Component node.
// They survive collapse/reload with the authored document and make the owner,
// not the browser-local recipient, the idempotency authority.
export const COMPOSITION_DELIVERY_REF_PROP = 'delivery_ref';

export type ComponentDeliveryDisposition = 'already-durable' | 'retry-current' | 'insert';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function stampComponentDeliveryRef(node: SceneNode, deliveryRef: string): SceneNode {
  if (node.kind !== 'Component') return node;
  const props = isRecord(node.props) ? node.props : {};
  const custom = isRecord(props.custom) ? props.custom : {};
  return {
    ...node,
    props: {
      ...props,
      custom: { ...custom, [COMPOSITION_DELIVERY_REF_PROP]: deliveryRef },
    },
  };
}

export function treeContainsComponentDeliveryRef(node: SceneNode | null | undefined, deliveryRef: string): boolean {
  if (!node) return false;
  const custom = isRecord(node.props) && isRecord(node.props.custom) ? node.props.custom : null;
  if (node.kind === 'Component' && custom?.[COMPOSITION_DELIVERY_REF_PROP] === deliveryRef) return true;
  return (node.children ?? []).some((child) => treeContainsComponentDeliveryRef(child, deliveryRef));
}

export function contentContainsComponentDeliveryRef(content: CompositionContent | null | undefined, deliveryRef: string): boolean {
  return !!content?.children.some((child) => treeContainsComponentDeliveryRef(child, deliveryRef));
}

/**
 * The durable document wins over the transient engine tree. A marker only in
 * the latter is a failed-write retry, never permission to insert a duplicate.
 */
export function resolveComponentDeliveryDisposition(
  durableContent: CompositionContent | null | undefined,
  currentTree: SceneNode | null | undefined,
  deliveryRef: string,
): ComponentDeliveryDisposition {
  if (contentContainsComponentDeliveryRef(durableContent, deliveryRef)) return 'already-durable';
  return treeContainsComponentDeliveryRef(currentTree, deliveryRef) ? 'retry-current' : 'insert';
}
