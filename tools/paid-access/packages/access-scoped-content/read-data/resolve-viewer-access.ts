type JsonRecord = Record<string, unknown>;

export type ViewerAccessState =
  | { status: 'loading'; authenticated: false; heldAccessRefs: readonly string[] }
  | { status: 'ready'; authenticated: boolean; heldAccessRefs: readonly string[] }
  | { status: 'error'; authenticated: boolean; heldAccessRefs: readonly string[] };

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function decodeTargetValue(reply: unknown): unknown {
  const candidate = isRecord(reply) && 'payload' in reply ? reply.payload : reply;
  if (candidate instanceof Uint8Array || ArrayBuffer.isView(candidate)) {
    const bytes = candidate instanceof Uint8Array
      ? candidate
      : new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength);
    const body = new TextDecoder().decode(bytes).trim();
    return body ? JSON.parse(body) : {};
  }
  if (candidate instanceof ArrayBuffer) {
    const body = new TextDecoder().decode(new Uint8Array(candidate)).trim();
    return body ? JSON.parse(body) : {};
  }
  if (typeof candidate === 'string') {
    const body = candidate.trim();
    return body ? JSON.parse(body) : {};
  }
  return candidate;
}

/**
 * The one entitlement rule: a viewer holding `heldAccessRefs` may reach a thing
 * that requires `requiredAccessRefs` when it requires nothing, or when ANY one of
 * its refs is held. Every gate in the set decides through this function (this
 * surface below, the private-object lease in material-delivery), so the rule has
 * exactly one definition. Empty required is ungated; empty held against a
 * non-empty required is denied.
 */
export function holdsAnyRequiredAccessRef(
  heldAccessRefs: readonly string[],
  requiredAccessRefs: readonly string[],
): boolean {
  if (requiredAccessRefs.length === 0) return true;
  const held = new Set(heldAccessRefs);
  return requiredAccessRefs.some((accessRef) => held.has(accessRef));
}

export function itemAvailableForViewer(
  authoredAvailable: unknown,
  requiredAccessRefs: readonly string[],
  access: ViewerAccessState,
): boolean {
  // An ungated item is still subject to its authored `available`, so this case
  // is decided here and never handed to the rule, which would answer true.
  if (requiredAccessRefs.length === 0) return authoredAvailable === true;
  if (access.status !== 'ready') return false;
  return holdsAnyRequiredAccessRef(access.heldAccessRefs, requiredAccessRefs);
}
