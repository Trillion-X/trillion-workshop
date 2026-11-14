import { readPath } from '../read-data/read-record-projection.mjs';

export function readProcessSessionProof(records, descriptor = {}) {
  const idPath = descriptor.idPath ?? ['payload', 'session_id'];
  const statusPath = descriptor.statusPath ?? ['payload', 'status'];
  const proofPath = descriptor.proofPath ?? ['payload', 'proof'];
  const source = Array.isArray(records) ? records : [];
  return source
    .map((record) => ({
      sessionId: readPath(record, idPath),
      status: readPath(record, statusPath),
      proof: readPath(record, proofPath),
      source: record,
    }))
    .filter((entry) => typeof entry.sessionId === 'string' && entry.sessionId.length > 0);
}
