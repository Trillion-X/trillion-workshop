import { foldRecordProjection } from './read-record-projection.mjs';

export function createProjectionState(records = []) {
  const byId = new Map();
  for (const record of records) {
    const id = record?.record_id ?? record?.id;
    if (typeof id === 'string' && id) byId.set(id, record);
  }
  return { byId, cursor: '' };
}

export function applyProjectionChanges(state, changes) {
  const next = {
    byId: new Map(state?.byId ?? []),
    cursor: state?.cursor ?? '',
  };
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || typeof change !== 'object') continue;
    if (change.op === 'delete' && typeof change.recordId === 'string') {
      next.byId.delete(change.recordId);
    }
    if (change.op === 'upsert' && change.record && typeof change.record === 'object') {
      const id = change.record.record_id ?? change.record.id;
      if (typeof id === 'string' && id) next.byId.set(id, change.record);
    }
    if (typeof change.cursor === 'string') next.cursor = change.cursor;
  }
  return next;
}

export function snapshotMaintainedProjection({ state, descriptor, related = [], methods = {} }) {
  const records = Array.from((state?.byId ?? new Map()).values());
  return foldRecordProjection({
    descriptor,
    records,
    related,
    methods,
    cursor: state?.cursor ?? '',
  });
}
