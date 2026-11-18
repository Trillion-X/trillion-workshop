// package-set://bitfield-studio/packages/package-dependencies/read-data/read-relation-projection.ts
//
// This module only reads generic descriptor-shaped records handed in as values. Package words stay
// in JSON data and owner-fed records.

export interface PackageThing {
  payload?: unknown;
}

export interface DescriptorSet {
  relations: Record<string, unknown>[];
  rules: Record<string, unknown>[];
  projection?: Record<string, unknown>;
  ownerActionIntents: Record<string, unknown>[];
  processProofFolds: Record<string, unknown>[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

export function readPackageDependencyDescriptors(things: readonly PackageThing[]): DescriptorSet {
  const descriptors: DescriptorSet = {
    relations: [],
    rules: [],
    ownerActionIntents: [],
    processProofFolds: [],
  };

  for (const thing of things) {
    const payload = record(thing.payload);
    const kind = text(payload.kind);
    if (kind === 'relation-descriptor-record') descriptors.relations.push(payload);
    if (kind === 'rule-descriptor-record') descriptors.rules.push(payload);
    if (kind === 'projection-descriptor-record') descriptors.projection = payload;
    if (kind === 'owner-action-intent-descriptor-record') descriptors.ownerActionIntents.push(payload);
    if (kind === 'process-proof-fold-descriptor-record') descriptors.processProofFolds.push(payload);
  }

  return descriptors;
}
