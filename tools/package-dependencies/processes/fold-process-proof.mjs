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

function proofField(proofRecord, field) {
  const value = readPath(proofRecord, field.path);
  return {
    id: text(field.id),
    label: text(field.label),
    value,
    text: value === undefined || value === null ? '' : String(value),
  };
}

export function foldProcessProof(input = {}) {
  const projection = isRecord(input.projection) ? input.projection : {};
  const descriptor = isRecord(input.descriptor) ? input.descriptor : {};
  const rows = list(projection.rows).map((row) => ({ ...row, proof: list(row.proof) }));
  const rowByRef = new Map(rows.map((row) => [row.relatedRef, row]));
  const skipped = [];
  const proofRecords = list(input.proof_records);

  for (const proofRecord of proofRecords) {
    if (!isRecord(proofRecord)) continue;
    const rowRef = text(readPath(proofRecord, descriptor.row_ref_path));
    const row = rowByRef.get(rowRef);
    if (!row) {
      skipped.push({
        ref: rowRef,
        reason: 'uncorrelated proof record',
      });
      continue;
    }
    row.proof = [
      ...row.proof,
      {
        correlationRef: text(readPath(proofRecord, descriptor.correlation_path)),
        occurredAt: text(readPath(proofRecord, descriptor.proof_time_path)),
        fields: list(descriptor.fields).filter(isRecord).map((field) => proofField(proofRecord, field)),
      },
    ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  return {
    ...projection,
    rows,
    proofFold: {
      descriptorId: descriptor.id,
      skipped,
      proofRecordCount: proofRecords.length,
    },
  };
}
