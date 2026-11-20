// The use statistics of each tool a caller asks about: the counts this resource measured itself (local, from the runs
// it captured) and the shared counts across every account (when a complete summary is published).
// A shared count that cannot be read is unknown, never zero. Only a measured zero is zero: a tool with no captured
// runs reads 0 locally, and that local zero never becomes a measured zero across every account.
// Ported from the older Workshop copy's src/native-workshop-telemetry.mjs readWorkshopStatistics (b6ae0ebf81, lines 9-23).

export const SHARED_COUNT_FIELDS = ['runs', 'contract_passed', 'reported_met', 'reported_failed'];

// local(publicIds) -> { [publicId]: counts } (zero-filled for every id asked about)
// shared(publicIds) -> { [publicId]: counts with legacy_complete } or null per id; it may throw when unavailable
// publicIdOf(id) -> the public tool id a requested id reads (a private id bound to a public tool reads that tool)
export async function workshopStatistics({ ids, local, shared, publicIdOf = id => id }) {
  const publicIds = ids.map(publicIdOf);
  const counts = local(publicIds);
  let projected = null;
  let unavailable = false;
  try {
    projected = await shared(publicIds);
  } catch {
    unavailable = true;
  }
  return Object.fromEntries(ids.map(id => {
    const key = publicIdOf(id);
    const resource_local = { ...counts[key], basis: 'resource_local', coverage: 'captured_resource_projections' };
    const sample = projected?.[key] ?? null;
    const valid = sample !== null && SHARED_COUNT_FIELDS.every(field => Number.isFinite(sample[field]) && sample[field] >= 0);
    const shared_evidence = valid
      ? { state: sample.legacy_complete === true ? 'available' : 'partial', counts: sample }
      : { state: 'unknown', reason: unavailable ? 'projection_unavailable' : sample ? 'invalid_projection' : 'not_published', counts: null };
    return [id, valid ? { ...sample, basis: 'shared_projection', resource_local, shared_evidence } : { ...resource_local, resource_local, shared_evidence }];
  }));
}
