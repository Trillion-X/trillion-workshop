import type { Ref } from './inline-tokens';
import type { ReferenceResolution } from './page-references';

export type ReferenceOwnerCheck = (request: {
  target: string;
  payload: { operation: 'check-current-entity'; entity_id: string; entity_type: string };
}, signal?: AbortSignal) => Promise<{ payload: Uint8Array }>;

export const referenceKey = (reference: Pick<Ref, 'kind' | 'value'>): string =>
  JSON.stringify([reference.kind, reference.value]);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only the caller's declared read-only resolver may check a reference. Token
 * contents never choose a target, operation, partition, or record address. */
export async function checkPageReferences(
  references: readonly Ref[], sources: readonly unknown[], check: ReferenceOwnerCheck,
  signal?: AbortSignal,
  onResult?: (key: string, resolution: 'resolved' | 'missing') => void,
): Promise<Map<string, ReferenceResolution>> {
  const results = new Map<string, ReferenceResolution>();
  let requested = 0;
  for (const reference of references) {
    if (signal?.aborted) break;
    const key = referenceKey(reference);
    if (results.has(key)) continue;
    results.set(key, 'unchecked');
    const matches = sources.filter(source => record(source) && source.kind === reference.kind);
    // Ambiguous declarations are not permission to pick an arbitrary owner.
    if (matches.length !== 1 || !record(matches[0])) continue;
    const resolver = matches[0].reference_resolver;
    if (!record(resolver) || resolver.target !== 'slot::eeaf'
      || resolver.operation !== 'check-current-entity'
      || typeof resolver.entity_type !== 'string' || !resolver.entity_type.trim()
      || new TextEncoder().encode(resolver.entity_type).length > 4096
      || !reference.value.trim() || new TextEncoder().encode(reference.value).length > 4096
      || requested >= 64) continue;
    requested++;
    try {
      const reply = await check({ target: resolver.target, payload: {
        operation: 'check-current-entity', entity_id: reference.value, entity_type: resolver.entity_type,
      } }, signal);
      if (signal?.aborted) break;
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.payload));
      if (record(value) && value.entity_id === reference.value && value.entity_type === resolver.entity_type
        && typeof value.found === 'boolean') {
        const resolution = value.found ? 'resolved' : 'missing';
        results.set(key, resolution);
        onResult?.(key, resolution);
      }
    } catch {
      // Denied, unavailable, and malformed reads are not absence evidence.
    }
  }
  return results;
}
