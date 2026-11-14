function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readPath(value, path) {
  let current = value;
  for (const segment of list(path)) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function recordMap(records) {
  const byRef = new Map();
  for (const row of list(records)) {
    if (!isRecord(row)) continue;
    const ref = text(row.ref ?? row.id);
    if (ref) byRef.set(ref, row);
  }
  return byRef;
}

function readRelationRefs(subject, descriptor) {
  const method = text(descriptor.method);
  if (method === 'field-ref-list') return list(readPath(subject, descriptor.related_refs_path)).filter((entry) => text(entry));
  if (method === 'field-ref') {
    const ref = text(readPath(subject, descriptor.related_ref_path));
    return ref ? [ref] : [];
  }
  if (method === 'all-related-records') return list(descriptor.related_refs).filter((entry) => text(entry));
  return [];
}

function rowValues(record, projection) {
  return list(projection.row_fields).map((field) => {
    const raw = readPath(record, field.path);
    const value = raw === undefined || raw === null || raw === '' ? field.fallback ?? '' : raw;
    return {
      id: text(field.id),
      label: text(field.label),
      value,
      text: String(value),
    };
  }).filter((field) => field.id);
}

function ruleFacts({ subjectRef, relatedRef, relatedRecord, descriptor, allRefs }) {
  const method = text(descriptor.method);
  const projectionField = text(descriptor.projection_field);
  const labels = isRecord(descriptor.labels) ? descriptor.labels : {};
  if (method === 'related-record-present') {
    return [{
      ruleId: descriptor.id,
      field: projectionField,
      ok: Boolean(relatedRecord),
      label: relatedRecord ? labels.pass ?? 'Record found' : labels.problem ?? 'Record missing',
    }];
  }
  if (method === 'owner-summary-present') {
    const ok = Boolean(isRecord(relatedRecord) && isRecord(relatedRecord.owner_summary));
    return [{
      ruleId: descriptor.id,
      field: projectionField,
      ok,
      label: ok ? labels.pass ?? 'Owner summary found' : labels.problem ?? 'Owner summary missing',
    }];
  }
  if (method === 'self-reference') {
    const ok = subjectRef !== relatedRef;
    return ok ? [] : [{
      ruleId: descriptor.id,
      field: projectionField,
      ok: false,
      label: labels.problem ?? 'A record points to itself',
    }];
  }
  if (method === 'duplicate-related-ref') {
    const ok = allRefs.filter((ref) => ref === relatedRef).length < 2;
    return ok ? [] : [{
      ruleId: descriptor.id,
      field: projectionField,
      ok: false,
      label: labels.problem ?? 'A related record is listed more than once',
    }];
  }
  return [];
}

export function foldRelationProjection(input = {}) {
  const descriptors = isRecord(input.descriptors) ? input.descriptors : {};
  const relations = list(input.relations ?? descriptors.relations);
  const rules = list(input.rules ?? descriptors.rules);
  const projection = isRecord(input.projection ?? descriptors.projection) ? input.projection ?? descriptors.projection : {};
  const byRef = recordMap(input.records);
  const rows = [];
  const problems = [];

  for (const relation of relations) {
    if (!isRecord(relation)) continue;
    const subjectRef = text(relation.subject_ref);
    const subject = byRef.get(subjectRef);
    if (!subject) {
      problems.push({
        relationId: relation.id,
        field: 'subject_presence',
        ref: subjectRef,
        label: 'Subject record missing',
      });
      continue;
    }
    const relatedRefs = readRelationRefs(subject, relation);
    for (const relatedRef of relatedRefs) {
      const relatedRecord = byRef.get(relatedRef);
      const facts = rules.flatMap((rule) => isRecord(rule)
        ? ruleFacts({ subjectRef, relatedRef, relatedRecord, descriptor: rule, allRefs: relatedRefs })
        : []);
      const failedFacts = facts.filter((fact) => !fact.ok);
      const row = {
        id: `${relation.id}:${subjectRef}->${relatedRef}`,
        relationId: relation.id,
        subjectRef,
        relatedRef,
        relationField: text(relation.projection_field),
        sectionLabel: isRecord(relation.labels) ? relation.labels.section ?? '' : '',
        values: relatedRecord ? rowValues(relatedRecord, projection) : [],
        facts,
        problems: failedFacts.map((fact) => ({
          ruleId: fact.ruleId,
          field: fact.field,
          ref: relatedRef,
          label: fact.label,
        })),
      };
      rows.push(row);
      problems.push(...row.problems.map((problem) => ({ ...problem, rowId: row.id })));
    }
  }

  return {
    kind: 'relation-projection-record',
    descriptorId: text(projection.id),
    generation: input.generation ?? 1,
    rowCount: rows.length,
    problemCount: problems.length,
    rows,
    problems,
  };
}

export function readProjectionRowValue(row, fieldId) {
  return list(row?.values).find((value) => value.id === fieldId)?.value;
}
