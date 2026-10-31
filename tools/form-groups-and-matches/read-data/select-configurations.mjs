// tools/form-groups-and-matches/read-data/select-configurations.mjs
//
// Choose which configurations go ahead: a configuration is anything that could move a scope forward (a person, a
// workflow, a tool, a place, a trigger; its kind is only a word the caller gives). Every configuration with a positive
// expected value and a complete scope may go ahead at the same time. Two compete only when they name the same
// collision ref (one room, one person's hour); then the higher value wins, and two whose values are within the minimum
// distinguishable delta of each other are both held back rather than picked between.
//
//   { configurations: [{ id | configuration_ref, configuration_kind, expected_value, scope: { <field>: text },
//                        required_resource_refs?, collision_refs? }],
//     scope_fields: ["<field>"], minimum_distinguishable_delta? }

const nonEmptyString = value => (typeof value === 'string' && value.length > 0 ? value : null);
const uniqueStrings = value => [...new Set((Array.isArray(value) ? value : []).map(nonEmptyString).filter(Boolean))].sort();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function scopeKey(scope, fields) {
  if (!object(scope) || fields.some(field => !nonEmptyString(scope[field]))) return null;
  return fields.map(field => `${field}:${scope[field]}`).join('|');
}

function normalize(configuration, fields) {
  const id = nonEmptyString(configuration?.id) ?? nonEmptyString(configuration?.configuration_ref);
  const configurationKind = nonEmptyString(configuration?.configuration_kind);
  const expectedValue = configuration?.expected_value;
  const key = scopeKey(configuration?.scope, fields);
  if (!id) return { admitted: false, reason: 'configuration_identity_missing', configuration };
  if (!configurationKind) return { admitted: false, reason: 'configuration_kind_missing', configuration };
  if (!Number.isFinite(expectedValue) || expectedValue <= 0) return { admitted: false, reason: 'non_positive_expected_value', configuration };
  if (!key) return { admitted: false, reason: 'scope_missing', configuration };
  return {
    admitted: true,
    record: {
      ...configuration,
      id,
      configuration_kind: configurationKind,
      expected_value: expectedValue,
      scope: Object.fromEntries(fields.map(field => [field, configuration.scope[field]])),
      scope_key: key,
      required_resource_refs: uniqueStrings(configuration.required_resource_refs),
      collision_refs: uniqueStrings(configuration.collision_refs),
    },
  };
}

const compare = (left, right) => (left.expected_value !== right.expected_value ? right.expected_value - left.expected_value : left.id.localeCompare(right.id));
const sharesCollision = (left, right) => left.collision_refs.some(ref => right.collision_refs.includes(ref));

export function selectConfigurations(request) {
  const fields = request?.scope_fields;
  if (!Array.isArray(fields) || fields.length === 0 || !fields.every(field => typeof field === 'string' && field.length > 0)) {
    throw new Error('scope_fields must name the scope every configuration is for, for example ["goal_ref", "horizon_ref"].');
  }
  const source = Array.isArray(request.configurations) ? request.configurations : [];
  const minimumDelta = Number.isFinite(request.minimum_distinguishable_delta) && request.minimum_distinguishable_delta >= 0 ? request.minimum_distinguishable_delta : 0;
  const normalized = source.map(configuration => normalize(configuration, fields));
  const rejected = normalized.filter(entry => !entry.admitted).map(entry => ({ id: entry.configuration?.id ?? null, reason: entry.reason }));
  const byId = new Map();
  for (const record of normalized.filter(entry => entry.admitted).map(entry => entry.record)) {
    const existing = byId.get(record.id);
    if (!existing || compare(record, existing) < 0) byId.set(record.id, record);
  }
  const candidates = [...byId.values()].sort(compare);
  const indistinguishable = new Set();
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (!sharesCollision(candidates[left], candidates[right])) continue;
      if (Math.abs(candidates[left].expected_value - candidates[right].expected_value) <= minimumDelta) {
        indistinguishable.add(candidates[left].id);
        indistinguishable.add(candidates[right].id);
      }
    }
  }
  const selected = [];
  const occupied = new Set();
  for (const candidate of candidates) {
    if (indistinguishable.has(candidate.id)) {
      rejected.push({ id: candidate.id, reason: 'indistinguishable_expected_value' });
      continue;
    }
    const collision = candidate.collision_refs.find(ref => occupied.has(ref));
    if (collision) {
      rejected.push({ id: candidate.id, reason: 'resource_collision', collision_ref: collision });
      continue;
    }
    selected.push(candidate);
    for (const ref of candidate.collision_refs) occupied.add(ref);
  }
  selected.sort((left, right) => left.id.localeCompare(right.id));
  rejected.sort((left, right) => `${left.id ?? ''}|${left.reason}`.localeCompare(`${right.id ?? ''}|${right.reason}`));
  return {
    selected,
    rejected,
    configuration_requests: selected.map(configuration => ({
      configuration_ref: configuration.id,
      configuration_kind: configuration.configuration_kind,
      scope: configuration.scope,
      required_resource_refs: configuration.required_resource_refs,
      state: 'proposed',
    })),
    instrumentation: {
      input_count: source.length,
      admitted_count: candidates.length,
      selected_count: selected.length,
      rejected_count: rejected.length,
      all_pairs_person_evaluation_count: 0,
    },
  };
}
