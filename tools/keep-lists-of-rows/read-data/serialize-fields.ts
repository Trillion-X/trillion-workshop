import type {
  VisualDatabaseFieldDescriptor,
  VisualDatabaseFieldDomain,
  VisualDatabaseFieldDomainValue,
} from './visual-database';

function serializeDomainValue(value: VisualDatabaseFieldDomainValue): unknown {
  return {
    id: value.id,
    label: value.label,
    order: value.order,
    ...(value.tone ? { tone: value.tone } : {}),
    ...(value.color ? { color: value.color } : {}),
    ...(value.pulse === true ? { pulse: true } : {}),
    ...(value.ref ? { ref: value.ref } : {}),
    ...((value.details?.length ?? 0) > 0 ? { details: value.details } : {}),
  };
}

function serializeFieldDomain(domain: NonNullable<VisualDatabaseFieldDomain>): unknown {
  const { values, ...source } = domain;
  return {
    ...source,
    ...(values ? { values: values.map(serializeDomainValue) } : {}),
  };
}

/** Serialize the field contract back to its data record shape. Inverse of
 * decodeVisualDatabaseFields for every field the decoder reads. */
function serializeFields(fields: readonly VisualDatabaseFieldDescriptor[]): unknown {
  return {
    kind: 'visual-database.fields',
    version: 2,
    descriptors: fields.map((field) => ({
      id: field.id,
      label: field.label,
      role: field.role,
      paths: field.paths,
      ...(field.writePath ? { writePath: field.writePath } : {}),
      ...(field.shape ? { shape: field.shape } : {}),
      ...(field.domain ? { domain: serializeFieldDomain(field.domain) } : {}),
      ...(field.sortable === false ? { sortable: false } : {}),
      ...(field.groupable === false ? { groupable: false } : {}),
      ...(field.filterable === false ? { filterable: false } : {}),
      ...(field.editable === false ? { editable: false } : {}),
      ...(field.emptyLabel ? { emptyLabel: field.emptyLabel } : {}),
      ...(field.visibleWhen ? { visibleWhen: field.visibleWhen } : {}),
      ...(field.defaultExpression ? { default_expression: field.defaultExpression } : {}),
      ...(field.evaluatorDescriptorRefs ? { evaluator_descriptor_refs: field.evaluatorDescriptorRefs } : {}),
      ...(field.surfaceAction ? { surface_action: field.surfaceAction } : {}),
    })),
  };
}

/** Only owner-declared descriptors are durable field-contract truth.
 * Discovered record keys are a read projection and must be excluded from BOTH
 * the submitted payload and its live-feed acknowledgement comparison. */
function persistableFields(
  fields: readonly VisualDatabaseFieldDescriptor[],
): readonly VisualDatabaseFieldDescriptor[] {
  return fields.filter((field) => field.source !== 'discovered');
}

export function serializePersistableVisualDatabaseFields(
  fields: readonly VisualDatabaseFieldDescriptor[],
): unknown {
  return serializeFields(persistableFields(fields));
}
