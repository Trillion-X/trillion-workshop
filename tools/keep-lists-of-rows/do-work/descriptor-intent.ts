//
// Owner-boundary adapter from the existing aggregate-shaped editor model to
// independently addressed descriptor operations. The aggregate is an editing
// projection only; this planner never writes it back as authority.

import {
  createDescriptorMutationDraft,
  descriptorIntegrityScopesForOperations,
  descriptorIntegrityGenerationKey,
  type DescriptorMutationDraft,
  type DescriptorOperation,
} from './descriptor-mutation';
import { isOrderKey, keyBetween } from './fractional-order';
import {
  splitLegacyVisualDatabaseAggregate,
  type VisualDatabaseLegacyAggregateKind,
} from './split-legacy-descriptor-aggregates';
import {
  descriptorKeyIdentity,
  type AddressedDescriptorSnapshot,
  type DescriptorKey,
  type DescriptorOwnerTarget,
} from '../read-data/addressed-descriptors';

type JsonObject = Record<string, unknown>;

interface DesiredDescriptor {
  key: DescriptorKey;
  value: unknown;
}

export type DescriptorIntentPlan =
  | {
      state: 'unchanged';
      draft: null;
      desired: readonly DesiredDescriptor[];
    }
  | {
      state: 'changed';
      draft: DescriptorMutationDraft;
      desired: readonly DesiredDescriptor[];
    }
  | {
      state: 'conflict';
      draft: null;
      desired: readonly DesiredDescriptor[];
      reason: 'referenced-descriptor-delete';
      blockedKey: DescriptorKey;
      referencingKeys: readonly DescriptorKey[];
    };

const FAMILIES_BY_AGGREGATE: Readonly<Record<
  VisualDatabaseLegacyAggregateKind,
  ReadonlySet<string>
>> = {
  fields: new Set(['field', 'field-domain-value']),
  views: new Set([
    'view',
    'view-filter',
    'view-projection-rule',
    'view-column',
    'view-property',
    'view-canvas-position',
    'palette-color',
  ]),
  'grid-properties': new Set(['grid-property']),
};

/** These projections intentionally reshape their stored member before it
 * reaches an editor. Only the named paths belong to that projection. Opaque
 * extension members remain owner truth and cannot be interpreted as deletes
 * merely because the editor never saw them. */
const PROJECTED_MEMBER_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  'view-column': new Set(['id', 'fieldId', 'field_id', 'order', 'width', 'hidden', 'style']),
  'view-property': new Set(['id', 'key', 'value', 'order']),
  'view-canvas-position': new Set([
    'id',
    'recordKey',
    'record_key',
    'x',
    'y',
    'order',
  ]),
};

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(right, key)
          && sameValue(left[key], right[key]),
      );
  }
  return false;
}

function preserveUnprojectedMemberData(
  family: string,
  current: unknown,
  desired: unknown,
): unknown {
  const projected = PROJECTED_MEMBER_KEYS[family];
  if (!projected || !isRecord(current) || !isRecord(desired)) return desired;
  const retained = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => !projected.has(key) && !Object.prototype.hasOwnProperty.call(desired, key),
    ),
  );
  return { ...retained, ...desired };
}

function valuesAtReferencePath(
  value: unknown,
  path: readonly string[],
  index = 0,
): readonly unknown[] {
  if (index === path.length) return [value];
  const segment = path[index];
  if (segment === '**') {
    const results = [...valuesAtReferencePath(value, path, index + 1)];
    if (Array.isArray(value)) {
      value.forEach((child) => results.push(...valuesAtReferencePath(child, path, index)));
    } else if (isRecord(value)) {
      Object.values(value).forEach(
        (child) => results.push(...valuesAtReferencePath(child, path, index)),
      );
    }
    return results;
  }
  if (segment === '*') {
    if (Array.isArray(value)) {
      return value.flatMap((child) => valuesAtReferencePath(child, path, index + 1));
    }
    if (isRecord(value)) {
      return Object.values(value).flatMap(
        (child) => valuesAtReferencePath(child, path, index + 1),
      );
    }
    return [];
  }
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, segment)) return [];
  return valuesAtReferencePath(value[segment], path, index + 1);
}

function descriptorReferences(
  target: DescriptorOwnerTarget,
  descriptor: DesiredDescriptor,
): readonly DescriptorKey[] {
  const references = new Map<string, DescriptorKey>();
  for (const rule of target.referenceRules ?? []) {
    if (rule.sourceFamilies && !rule.sourceFamilies.includes(descriptor.key.family)) continue;
    for (const candidate of valuesAtReferencePath(descriptor.value, rule.valuePath)) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      const reference = {
        family: rule.targetFamily.normalize('NFC').trim(),
        id: candidate.normalize('NFC').trim(),
      };
      if (!reference.family) continue;
      references.set(descriptorKeyIdentity(reference), reference);
    }
  }
  return [...references.values()];
}

function desiredFromSnapshot(snapshot: AddressedDescriptorSnapshot): DesiredDescriptor {
  return { key: snapshot.key, value: snapshot.payload.value };
}

function groupIdentity(key: DescriptorKey): string {
  return JSON.stringify({
    family: key.family,
    parent: key.parent ?? [],
  });
}

function orderedIdentity(snapshot: AddressedDescriptorSnapshot): string {
  return descriptorKeyIdentity(snapshot.key);
}

function orderOf(value: unknown): string | null {
  return isRecord(value) && isOrderKey(value.order) ? value.order : null;
}

function compareOrderKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function longestCommonSubsequence(
  current: readonly string[],
  desired: readonly string[],
): readonly string[] {
  const lengths = Array.from(
    { length: current.length + 1 },
    () => Array<number>(desired.length + 1).fill(0),
  );
  for (let left = current.length - 1; left >= 0; left -= 1) {
    for (let right = desired.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = current[left] === desired[right]
        ? 1 + lengths[left + 1][right + 1]
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }
  const result: string[] = [];
  let left = 0;
  let right = 0;
  while (left < current.length && right < desired.length) {
    if (current[left] === desired[right]) {
      result.push(current[left]);
      left += 1;
      right += 1;
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return result;
}

function reconcileOrderKeys(
  desired: readonly DesiredDescriptor[],
  current: readonly AddressedDescriptorSnapshot[],
): readonly DesiredDescriptor[] {
  const currentGroups = new Map<string, AddressedDescriptorSnapshot[]>();
  for (const snapshot of current) {
    if (orderOf(snapshot.payload.value) === null) continue;
    const group = groupIdentity(snapshot.key);
    const values = currentGroups.get(group);
    if (values) values.push(snapshot);
    else currentGroups.set(group, [snapshot]);
  }
  for (const values of currentGroups.values()) {
    values.sort((left, right) => {
      const byOrder = compareOrderKeys(
        orderOf(left.payload.value) ?? '',
        orderOf(right.payload.value) ?? '',
      );
      return byOrder !== 0
        ? byOrder
        : descriptorKeyIdentity(left.key).localeCompare(descriptorKeyIdentity(right.key));
    });
  }

  const desiredGroups = new Map<string, DesiredDescriptor[]>();
  for (const descriptor of desired) {
    if (orderOf(descriptor.value) === null) continue;
    const group = groupIdentity(descriptor.key);
    const values = desiredGroups.get(group);
    if (values) values.push(descriptor);
    else desiredGroups.set(group, [descriptor]);
  }

  const assignedOrders = new Map<string, string>();
  for (const [group, desiredGroup] of desiredGroups) {
    const currentGroup = currentGroups.get(group) ?? [];
    const currentOrders = new Map(
      currentGroup.map((snapshot) => [
        orderedIdentity(snapshot),
        orderOf(snapshot.payload.value) as string,
      ]),
    );
    const currentIds = currentGroup.map(orderedIdentity);
    const desiredIds = desiredGroup.map((descriptor) => descriptorKeyIdentity(descriptor.key));
    const preserved = new Set(longestCommonSubsequence(currentIds, desiredIds));

    let lower: string | null = null;
    for (let index = 0; index < desiredGroup.length; index += 1) {
      const descriptor = desiredGroup[index];
      const identity = descriptorKeyIdentity(descriptor.key);
      const preservedOrder = preserved.has(identity) ? currentOrders.get(identity) : undefined;
      if (preservedOrder) {
        assignedOrders.set(identity, preservedOrder);
        lower = preservedOrder;
        continue;
      }
      let upper: string | null = null;
      for (let next = index + 1; next < desiredGroup.length; next += 1) {
        const nextIdentity = descriptorKeyIdentity(desiredGroup[next].key);
        if (preserved.has(nextIdentity)) {
          upper = currentOrders.get(nextIdentity) ?? null;
          break;
        }
      }
      const allocated = keyBetween(lower, upper);
      assignedOrders.set(identity, allocated);
      lower = allocated;
    }
  }

  return desired.map((descriptor) => {
    const order = assignedOrders.get(descriptorKeyIdentity(descriptor.key));
    if (!order || !isRecord(descriptor.value)) return descriptor;
    return {
      key: descriptor.key,
      value: { ...descriptor.value, order },
    };
  });
}

function appendValueOperations(
  operations: DescriptorOperation[],
  key: DescriptorKey,
  before: unknown,
  after: unknown,
  path: readonly string[] = [],
): void {
  if (sameValue(before, after)) return;
  if (path.length === 0 && (!isRecord(before) || !isRecord(after))) {
    operations.push({ operation: 'delete', key, before });
    operations.push({ operation: 'create', key, value: after });
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const name of names) {
      const beforePresent = Object.prototype.hasOwnProperty.call(before, name);
      const afterPresent = Object.prototype.hasOwnProperty.call(after, name);
      const nextPath = [...path, name];
      if (beforePresent && afterPresent && sameValue(before[name], after[name])) {
        continue;
      }
      if (!afterPresent) {
        operations.push({
          operation: 'remove',
          key,
          path: nextPath,
          before: before[name],
        });
      } else if (!beforePresent) {
        operations.push({
          operation: 'set',
          key,
          path: nextPath,
          beforePresent: false,
          before: undefined,
          after: after[name],
        });
      } else if (name === 'order' && isOrderKey(before[name]) && isOrderKey(after[name])) {
        operations.push({
          operation: 'move',
          key,
          before: before[name],
          after: after[name],
        });
      } else {
        appendValueOperations(operations, key, before[name], after[name], nextPath);
      }
    }
    return;
  }
  operations.push({
    operation: 'set',
    key,
    path,
    before,
    after,
  });
}

export function planVisualDatabaseDescriptorIntent(input: {
  target: DescriptorOwnerTarget;
  kind: VisualDatabaseLegacyAggregateKind;
  current: readonly AddressedDescriptorSnapshot[];
  desiredPayload: unknown;
  draftId: string;
}): DescriptorIntentPlan {
  const families = FAMILIES_BY_AGGREGATE[input.kind];
  const current = input.current.filter((snapshot) => families.has(snapshot.key.family));
  const split = splitLegacyVisualDatabaseAggregate({
    kind: input.kind,
    addressLabel: `projection::${input.kind}`,
    payloadHash: new Uint8Array(),
    payload: input.desiredPayload,
  });
  const currentByIdentity = new Map(
    current.map((snapshot) => [descriptorKeyIdentity(snapshot.key), snapshot]),
  );
  const losslessDesired = split.descriptors.map((descriptor) => {
    const existing = currentByIdentity.get(descriptorKeyIdentity(descriptor.key));
    return {
      ...descriptor,
      value: preserveUnprojectedMemberData(
        descriptor.key.family,
        existing?.payload.value,
        descriptor.value,
      ),
    };
  });
  const desired = reconcileOrderKeys(losslessDesired, current);
  const desiredByIdentity = new Map(
    desired.map((descriptor) => [descriptorKeyIdentity(descriptor.key), descriptor]),
  );
  if (desiredByIdentity.size !== desired.length) {
    throw new Error(`Visual Database ${input.kind} projection contains duplicate descriptor keys.`);
  }

  const operations: DescriptorOperation[] = [];
  for (const descriptor of desired) {
    const existing = currentByIdentity.get(descriptorKeyIdentity(descriptor.key));
    if (!existing) {
      operations.push({
        operation: 'create',
        key: descriptor.key,
        value: descriptor.value,
      });
    } else {
      appendValueOperations(
        operations,
        descriptor.key,
        existing.payload.value,
        descriptor.value,
      );
    }
  }
  for (const snapshot of current) {
    if (!desiredByIdentity.has(descriptorKeyIdentity(snapshot.key))) {
      operations.push({
        operation: 'delete',
        key: snapshot.key,
        before: snapshot.payload.value,
      });
    }
  }

  if (operations.length === 0) {
    return { state: 'unchanged', draft: null, desired };
  }
  const touched = new Set(operations.map((operation) => descriptorKeyIdentity(operation.key)));
  const created = new Set(
    operations
      .filter((operation) => operation.operation === 'create')
      .map((operation) => descriptorKeyIdentity(operation.key)),
  );
  const deleted = new Map(
    operations
      .filter((operation) => operation.operation === 'delete')
      .map((operation) => [descriptorKeyIdentity(operation.key), operation.key]),
  );
  const desiredWholeGraph = [
    ...input.current
      .filter((snapshot) => !families.has(snapshot.key.family))
      .map(desiredFromSnapshot),
    ...desired,
  ];
  const knownFieldIdentities = new Set([
    ...input.current
      .filter((snapshot) => snapshot.key.family === 'field')
      .map((snapshot) => descriptorKeyIdentity(snapshot.key)),
    ...operations
      .filter((operation) => operation.operation === 'create' && operation.key.family === 'field')
      .map((operation) => descriptorKeyIdentity(operation.key)),
  ]);
  for (const [identity, blockedKey] of deleted) {
    const referencingKeys = desiredWholeGraph
      .filter((descriptor) => descriptorReferences(input.target, descriptor).some(
        (reference) => descriptorKeyIdentity(reference) === identity,
      ))
      .map((descriptor) => descriptor.key);
    if (referencingKeys.length > 0) {
      return {
        state: 'conflict',
        draft: null,
        desired,
        reason: 'referenced-descriptor-delete',
        blockedKey,
        referencingKeys,
      };
    }
  }
  const touchedCurrent = current.filter((snapshot) => touched.has(descriptorKeyIdentity(snapshot.key)));
  const touchedDesired = desired.filter((descriptor) => touched.has(descriptorKeyIdentity(descriptor.key)));
  const integrityScopes = [
    ...touchedCurrent.flatMap(
      (snapshot) => descriptorReferences(input.target, desiredFromSnapshot(snapshot)),
    ),
    ...touchedDesired.flatMap((descriptor) => descriptorReferences(input.target, descriptor)),
  ].filter((reference) => knownFieldIdentities.has(descriptorKeyIdentity(reference)));
  const requiredCurrentKeys = desiredWholeGraph
    .flatMap((descriptor) => descriptorReferences(input.target, descriptor))
    .filter((reference) => (
      knownFieldIdentities.has(descriptorKeyIdentity(reference))
      && !created.has(descriptorKeyIdentity(reference))
    ));
  const allIntegrityScopes = [
    ...descriptorIntegrityScopesForOperations(operations),
    ...integrityScopes,
  ];
  const integrityGenerationIdentities = new Set(
    allIntegrityScopes.map((scope) => descriptorKeyIdentity(descriptorIntegrityGenerationKey(scope))),
  );
  return {
    state: 'changed',
    draft: createDescriptorMutationDraft({
      draftId: input.draftId,
      operations,
      bases: input.current.filter((snapshot) => (
        touched.has(descriptorKeyIdentity(snapshot.key))
        || integrityGenerationIdentities.has(descriptorKeyIdentity(snapshot.key))
      )),
      integrityScopes,
      requiredCurrentKeys,
    }),
    desired,
  };
}
