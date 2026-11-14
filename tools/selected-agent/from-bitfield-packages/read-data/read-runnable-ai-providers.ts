type ProviderFactRow = {
  subject_id?: unknown;
  property_id?: unknown;
  value?: unknown;
};

type PolicyCondition = {
  property_id?: unknown;
  equals?: unknown;
  in?: unknown;
  contains_all?: unknown;
};

type RoutingPolicy = {
  kind?: unknown;
  eligibility?: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesCondition(
  provider: Readonly<Record<string, unknown>>,
  rawCondition: unknown,
): boolean {
  const condition = record(rawCondition) as PolicyCondition | null;
  const propertyId = string(condition?.property_id);
  if (!condition || !propertyId) return false;
  const value = provider[propertyId];
  if (Object.hasOwn(condition, 'equals')) return same(value, condition.equals);
  if (Array.isArray(condition.in)) return condition.in.some((candidate) => same(value, candidate));
  if (Array.isArray(condition.contains_all)) {
    return Array.isArray(value) && condition.contains_all.every((candidate) => value.includes(candidate));
  }
  return false;
}

/**
 * Return every identity that names an AI provider currently eligible under the
 * one open routing-policy row. The evaluator knows no vendor, transport,
 * locality, account, or machine path; new providers become runnable through
 * facts alone.
 */
export function readRunnableAiProviderRefs(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  const grouped = new Map<string, Record<string, unknown>>();
  for (const entry of value as ProviderFactRow[]) {
    const raw = (record(entry)?.payload ?? entry) as ProviderFactRow;
    const subjectId = string(raw?.subject_id);
    const propertyId = string(raw?.property_id);
    if (!subjectId || !propertyId) continue;
    const fields = grouped.get(subjectId) ?? { subject_id: subjectId };
    const encoded = raw.value ?? (raw as Record<string, unknown>).value_json;
    if (typeof encoded === 'string' && (raw as Record<string, unknown>).value_json !== undefined) {
      try { fields[propertyId] = JSON.parse(encoded); } catch { fields[propertyId] = encoded; }
    } else {
      fields[propertyId] = encoded;
    }
    grouped.set(subjectId, fields);
  }

  const policies = [...grouped.values()]
    .map((fields) => record(fields['prop:provider_routing:policy']) as RoutingPolicy | null)
    .filter((policy): policy is RoutingPolicy => policy !== null);
  if (policies.length !== 1 || policies[0].kind !== 'ai-provider-routing-policy'
    || !Array.isArray(policies[0].eligibility)) return new Set();

  const refs = new Set<string>();
  for (const provider of grouped.values()) {
    const vendor = string(provider['prop:provider:vendor']);
    if (!vendor || !policies[0].eligibility.every((condition) => matchesCondition(provider, condition))) continue;
    const subjectId = String(provider.subject_id);
    refs.add(subjectId);
    refs.add(vendor);
    refs.add(`provider:${vendor}`);
    refs.add(`ai_provider:${vendor}`);
  }
  return refs;
}

/** Keep only model rows whose provider is currently runnable. */
export function filterRunnableAiModelDescriptors(
  descriptors: unknown,
  providerRefs: ReadonlySet<string>,
): unknown[] {
  if (!Array.isArray(descriptors) || providerRefs.size === 0) return [];
  return descriptors.filter((entry) => {
    const row = record(record(entry)?.payload) ?? record(entry);
    return row?.kind === 'ai-model-descriptor'
      && row.status === 'available'
      && typeof row.provider_ref === 'string'
      && providerRefs.has(row.provider_ref);
  });
}
