// Vendored unchanged except for import paths from bitfield-packages/packages/interaction-program/read-data/select-configurations.mjs.
const SCOPE_FIELDS = Object.freeze([
  "pursuit_ref",
  "system_ref",
  "timescale_ref",
  "state_ref",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function uniqueStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map(nonEmptyString)
      .filter(Boolean),
  )].sort();
}

function scopeKey(scope) {
  if (!scope || typeof scope !== "object") return null;
  if (SCOPE_FIELDS.some((field) => !nonEmptyString(scope[field]))) return null;
  return SCOPE_FIELDS.map((field) => `${field}:${scope[field]}`).join("|");
}

function normalize(configuration) {
  const id = nonEmptyString(configuration?.id)
    ?? nonEmptyString(configuration?.configuration_ref);
  const configurationKind = nonEmptyString(configuration?.configuration_kind);
  const expectedValue = configuration?.expected_value;
  const normalizedScopeKey = scopeKey(configuration?.scope);
  if (!id) return { admitted: false, reason: "configuration_identity_missing", configuration };
  if (!configurationKind) return { admitted: false, reason: "configuration_kind_missing", configuration };
  if (!Number.isFinite(expectedValue) || expectedValue <= 0) {
    return { admitted: false, reason: "non_positive_expected_value", configuration };
  }
  if (!normalizedScopeKey) return { admitted: false, reason: "needle_mover_scope_missing", configuration };
  return {
    admitted: true,
    record: {
      ...configuration,
      id,
      configuration_kind: configurationKind,
      expected_value: expectedValue,
      scope: Object.fromEntries(SCOPE_FIELDS.map((field) => [field, configuration.scope[field]])),
      scope_key: normalizedScopeKey,
      required_resource_refs: uniqueStrings(configuration.required_resource_refs),
      collision_refs: uniqueStrings(configuration.collision_refs),
    },
  };
}

function compareConfigurations(left, right) {
  if (left.expected_value !== right.expected_value) return right.expected_value - left.expected_value;
  return left.id.localeCompare(right.id);
}

function sharesCollision(left, right) {
  const rightCollisions = new Set(right.collision_refs);
  return left.collision_refs.some((ref) => rightCollisions.has(ref));
}

export function selectConfigurations(request = {}) {
  const source = Array.isArray(request.configurations) ? request.configurations : [];
  const minimumDelta = Number.isFinite(request.minimum_distinguishable_delta)
    && request.minimum_distinguishable_delta >= 0
    ? request.minimum_distinguishable_delta
    : 0;
  const normalized = source.map(normalize);
  const rejected = normalized
    .filter((entry) => !entry.admitted)
    .map((entry) => ({
      id: entry.configuration?.id ?? null,
      reason: entry.reason,
    }));
  const byId = new Map();

  for (const record of normalized.filter((entry) => entry.admitted).map((entry) => entry.record)) {
    const existing = byId.get(record.id);
    if (!existing || compareConfigurations(record, existing) < 0) byId.set(record.id, record);
  }

  const candidates = [...byId.values()].sort(compareConfigurations);
  const indistinguishable = new Set();
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (!sharesCollision(left, right)) continue;
      if (Math.abs(left.expected_value - right.expected_value) <= minimumDelta) {
        indistinguishable.add(left.id);
        indistinguishable.add(right.id);
      }
    }
  }

  const selected = [];
  const occupiedCollisions = new Set();
  for (const candidate of candidates) {
    if (indistinguishable.has(candidate.id)) {
      rejected.push({ id: candidate.id, reason: "indistinguishable_expected_value" });
      continue;
    }
    const collision = candidate.collision_refs.find((ref) => occupiedCollisions.has(ref));
    if (collision) {
      rejected.push({ id: candidate.id, reason: "resource_collision", collision_ref: collision });
      continue;
    }
    selected.push(candidate);
    for (const ref of candidate.collision_refs) occupiedCollisions.add(ref);
  }

  selected.sort((left, right) => left.id.localeCompare(right.id));
  rejected.sort((left, right) => `${left.id ?? ""}|${left.reason}`.localeCompare(`${right.id ?? ""}|${right.reason}`));
  return {
    selected,
    rejected,
    configuration_requests: selected.map((configuration) => ({
      configuration_ref: configuration.id,
      configuration_kind: configuration.configuration_kind,
      scope: configuration.scope,
      required_resource_refs: configuration.required_resource_refs,
      state: "proposed",
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

export default selectConfigurations;
