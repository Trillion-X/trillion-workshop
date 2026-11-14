import type { ExecutionReceipt, ProviderObjectRef } from './capability-records';

export function readProviderObjectRefsView(receipts: readonly ExecutionReceipt[]): ProviderObjectRef[] {
  const refs = new Map<string, ProviderObjectRef>();
  for (const receipt of receipts) {
    for (const ref of receipt.provider_object_refs) refs.set(`${ref.object_type}:${ref.ref}`, ref);
  }
  return [...refs.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}
