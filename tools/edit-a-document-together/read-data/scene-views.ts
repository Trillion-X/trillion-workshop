// packages/documents/read-data/scene-views.ts
//
// Read-side folds over authored content: inverse edge lookups and
// version note records. Pure functions, no storage of their own.

import {
  flattenProjectedRows,
  isRecord,
  type CompositionContent,
  type EdgeConnection,
} from './documents';

export type VersionNote = {
  kind: 'composition-version-note';
  payload_hash: string;
  saved_at: string;
  authored_thing_ref?: string;
};

export function backlinksForNode(content: CompositionContent, nodeId: string): EdgeConnection[] {
  return (content.edges ?? []).filter((edge) => edge.target_id === nodeId);
}

export function outgoingLinksForNode(content: CompositionContent, nodeId: string): EdgeConnection[] {
  return (content.edges ?? []).filter((edge) => edge.source_id === nodeId);
}

export function readVersionNotes(raw: unknown): VersionNote[] {
  return flattenProjectedRows(raw)
    .map((value) => {
      if (!isRecord(value) || value.kind !== 'composition-version-note') return null;
      const payloadHash = typeof value.payload_hash === 'string' ? value.payload_hash : null;
      const savedAt = typeof value.saved_at === 'string' ? value.saved_at : null;
      if (!payloadHash || !savedAt) return null;
      const note: VersionNote = {
        kind: 'composition-version-note',
        payload_hash: payloadHash,
        saved_at: savedAt,
      };
      if (typeof value.authored_thing_ref === 'string' && value.authored_thing_ref.length > 0) {
        note.authored_thing_ref = value.authored_thing_ref;
      }
      return note;
    })
    .filter((value): value is VersionNote => value !== null)
    .sort((left, right) => right.saved_at.localeCompare(left.saved_at));
}
