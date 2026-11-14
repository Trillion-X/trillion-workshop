// One-time deterministic descriptor migration. It changes field source policy,
// never stamps expressions into cells and never reclassifies cached values.

import type {
  VisualDatabaseFieldDescriptor,
  VisualDatabaseValueExpression,
} from '@/packages/visual-database/read-data/visual-database';

export interface FieldDerivationMigrationEvent {
  event: 'visual_database.derive_migrated';
  field_ref: string;
  prior_revision?: string;
  next_revision?: string;
}

export interface FieldDerivationMigrationResult {
  fields: readonly VisualDatabaseFieldDescriptor[];
  events: readonly FieldDerivationMigrationEvent[];
}

type JsonObject = Record<string, unknown>;

export interface RawFieldDerivationMigrationResult {
  payload: JsonObject;
  events: readonly FieldDerivationMigrationEvent[];
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Lossless stored-data migration. This is intentionally separate from the
 * caller-ready descriptor decoder: a decoder is allowed to translate spelling
 * for consumers, while a migration must retain every byte-shaped value it does
 * not own. The only mutation is moving a valid legacy `derive` member into the
 * canonical stored `default_expression` member.
 */
export function migrateRawFieldDerivations(
  payload: JsonObject,
  revisions: { prior?: string; next?: string } = {},
): RawFieldDerivationMigrationResult {
  const rawDescriptors = payload.descriptors;
  if (!Array.isArray(rawDescriptors)) return { payload, events: [] };
  const events: FieldDerivationMigrationEvent[] = [];
  let changed = false;
  const descriptors = rawDescriptors.map((rawDescriptor) => {
    if (!isRecord(rawDescriptor)
      || !isRecord(rawDescriptor.derive)
      || typeof rawDescriptor.derive.target !== 'string'
      || !rawDescriptor.derive.target.trim()
      || Object.prototype.hasOwnProperty.call(rawDescriptor, 'default_expression')
      || Object.prototype.hasOwnProperty.call(rawDescriptor, 'defaultExpression')) return rawDescriptor;
    const fieldRef = typeof rawDescriptor.id === 'string' && rawDescriptor.id.trim();
    if (!fieldRef) return rawDescriptor;
    const { derive, ...withoutLegacyDerive } = rawDescriptor;
    changed = true;
    events.push({
      event: 'visual_database.derive_migrated',
      field_ref: fieldRef,
      ...(revisions.prior ? { prior_revision: revisions.prior } : {}),
      ...(revisions.next ? { next_revision: revisions.next } : {}),
    });
    return { ...withoutLegacyDerive, default_expression: { derive } };
  });
  return changed ? { payload: { ...payload, descriptors }, events } : { payload, events };
}

function fieldDeriveAsDefault(field: VisualDatabaseFieldDescriptor): VisualDatabaseValueExpression {
  const derive = field.derive!;
  return {
    derive: {
      target: derive.target,
      request: derive.request,
      resultPath: derive.resultPath,
      dependencySelector: { contextFromFields: [...derive.contextFromFields] },
      cachePath: derive.cachePath,
      persist: derive.persist,
    },
  };
}

/** Existing explicit defaults win. A rerun makes no further mutation or event. */
export function migrateFieldDerivations(
  fields: readonly VisualDatabaseFieldDescriptor[],
  revisions: Readonly<Record<string, { prior?: string; next?: string }>> = {},
): FieldDerivationMigrationResult {
  const events: FieldDerivationMigrationEvent[] = [];
  const migrated = fields.map((field) => {
    if (!field.derive || field.defaultExpression) return field;
    const revision = revisions[field.id];
    events.push({
      event: 'visual_database.derive_migrated',
      field_ref: field.id,
      ...(revision?.prior ? { prior_revision: revision.prior } : {}),
      ...(revision?.next ? { next_revision: revision.next } : {}),
    });
    const { derive: _legacyDerive, ...withoutLegacyDerive } = field;
    return { ...withoutLegacyDerive, defaultExpression: fieldDeriveAsDefault(field) };
  });
  return { fields: migrated, events };
}
