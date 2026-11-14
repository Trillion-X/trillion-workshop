function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourcePayload(record) {
  return isObject(record?.payload) ? record.payload : record;
}

function valuesAtPath(value, path) {
  if (!Array.isArray(path) || path.length === 0) return [value];
  let frontier = [value];
  for (const segment of path) {
    const next = [];
    for (const item of frontier) {
      if (segment === "*") {
        if (Array.isArray(item)) next.push(...item);
      } else if (isObject(item) && Object.hasOwn(item, segment)) {
        next.push(item[segment]);
      }
    }
    frontier = next;
  }
  return frontier;
}

function firstValue(record, reader) {
  const paths = Array.isArray(reader.paths) ? reader.paths : [reader.path];
  for (const path of paths) {
    for (const value of valuesAtPath(record, path)) {
      if (value !== null && value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : value;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter((item) => item !== null && item !== undefined && item !== "");
  const normalized = normalizeText(value);
  return normalized === null || normalized === undefined || normalized === "" ? [] : [normalized];
}

function compare(left, op, right) {
  if (op === "exists") return left !== null && left !== undefined && left !== "";
  if (op === "not_equals") return left !== right;
  if (op === "equals") return left === right;
  if (op === "in") return Array.isArray(right) && right.includes(left);
  if (op === "not_in") return !Array.isArray(right) || !right.includes(left);
  return true;
}

function resolveOperand(record, operand, options) {
  if (isObject(operand) && operand.from === "option") return options?.[operand.name];
  if (isObject(operand) && (operand.path || operand.paths)) return firstValue(record, operand);
  return operand;
}

function predicateMatches(record, predicate, options) {
  if (!predicate) return true;
  if (Array.isArray(predicate.all)) return predicate.all.every((item) => predicateMatches(record, item, options));
  if (Array.isArray(predicate.any)) return predicate.any.some((item) => predicateMatches(record, item, options));
  const left = resolveOperand(record, predicate.left ?? { path: predicate.path }, options);
  const right = resolveOperand(record, predicate.right, options);
  if (predicate.op === "option_absent_or_equals_any") {
    if (right === null || right === undefined || right === "") return true;
    return normalizeList(left).includes(right) || left === right;
  }
  return compare(left, predicate.op, right);
}

function materializeField(record, reader) {
  const value = firstValue(record, reader);
  if (value === undefined) {
    if (reader.on_missing === "omit-row") return { omit: true };
    if (reader.on_missing === "empty-list") return { value: [] };
    if (Object.hasOwn(reader, "default")) return { value: reader.default };
    return { value: null };
  }
  if (reader.value === "list") return { value: normalizeList(value) };
  if (reader.value === "text") return { value: normalizeText(value) };
  return { value };
}

function labelFor(labels, field, value) {
  const fieldLabels = labels?.[field];
  if (!isObject(fieldLabels)) return value;
  return fieldLabels[String(value)] ?? value;
}

function readMappedInput(row, source) {
  if (isObject(source) && source.from === "row") return row[source.field];
  return source;
}

export function projectOwnerActionHandoffs(rows, handoffSpecs = []) {
  const actions = [];
  for (const row of rows) {
    for (const spec of handoffSpecs) {
      const input = {};
      for (const [key, source] of Object.entries(spec.input_map ?? {})) input[key] = readMappedInput(row.fields, source);
      actions.push({
        id: `${row.id}:${spec.id}`,
        owner_action_ref: spec.owner_action_ref,
        label: spec.label ?? spec.id,
        enabled: spec.enabled !== false,
        input,
        row_id: row.id
      });
    }
  }
  return actions;
}

function groupRows(rows, groups = []) {
  return groups.map((group) => {
    const buckets = new Map();
    for (const row of rows) {
      const key = row.fields[group.field] ?? group.default_key ?? "none";
      const label = labelFor(group.labels, group.field, key);
      if (!buckets.has(key)) buckets.set(key, { key, label, row_ids: [] });
      buckets.get(key).row_ids.push(row.id);
    }
    return { id: group.id, label: group.label ?? group.id, buckets: [...buckets.values()] };
  });
}

export function projectRecords(sourceRecords, lens, options = {}) {
  const rows = [];
  const diagnostics = [];
  for (const entry of Array.isArray(sourceRecords) ? sourceRecords : []) {
    const record = sourcePayload(entry);
    if (!isObject(record)) {
      diagnostics.push({ code: "skipped_non_object_record" });
      continue;
    }
    if (!predicateMatches(record, lens.include, options)) continue;
    const fields = {};
    let omit = false;
    for (const reader of lens.field_readers ?? []) {
      const projected = materializeField(record, reader);
      if (projected.omit) {
        omit = true;
        break;
      }
      fields[reader.output] = labelFor(lens.labels, reader.output, projected.value);
    }
    if (omit) {
      diagnostics.push({ code: "skipped_missing_required_field" });
      continue;
    }
    rows.push({
      id: String(fields[lens.row_id_field ?? "hidden_id"]),
      fields,
      proof: { source_kind: entry?.kind ?? entry?.type ?? "record" }
    });
  }
  const groups = groupRows(rows, lens.groups);
  const actions = projectOwnerActionHandoffs(rows, lens.action_handoffs);
  return {
    status: lens.status ?? "ready",
    revision: options.revision ?? null,
    rows,
    groups,
    actions,
    diagnostics: diagnostics.length > 0 ? { items: diagnostics } : undefined
  };
}
