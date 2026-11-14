export type AdmittedProjectionScope = {
  action_ref: string;
  actor_ref: string;
  decision_proof: string;
  revisions: { membership_revision: string; policy_revision: string; resource_revision: string; session_revision: string };
  session_ref: string;
  subject_ref: string;
};
export type GroupPageItem = { itemRef: string; text: string; authorRef: string; createdAt: string };
export type GroupPage = { groupRef: string; name: string; summary: string; accessRef: string; items: GroupPageItem[] };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(record) : record(value) && Array.isArray(value.items) ? value.items.filter(record) : [];
function fields(row: Record<string, unknown>) { if (record(row.fields)) return row.fields; try { const value = JSON.parse(String(row.fields)); return record(value) ? value : {}; } catch { return {}; } }

export function isAdmittedProjectionScope(value: unknown): value is AdmittedProjectionScope {
  if (!record(value) || !text(value.actor_ref) || !text(value.session_ref) || !text(value.subject_ref) || !text(value.action_ref) || !text(value.decision_proof) || !record(value.revisions)) return false;
  return ['membership_revision', 'policy_revision', 'resource_revision', 'session_revision'].every((key) => text(value.revisions[key]));
}

function projectedSubjectRef(value: unknown): string {
  if (isAdmittedProjectionScope(value)) return value.subject_ref;
  return '';
}

/** Query contract: only the admitted subject reaches this package reader. */
export function buildScopedGroupPageQuery(scope: AdmittedProjectionScope) {
  if (!isAdmittedProjectionScope(scope)) throw new Error('missing-admitted-scope');
  return { target: 'slot::find-current-items', payload: { operation: 'find-current-items', in: 'item-record-projection', where: { all: [{ field: 'target_ref', equals: scope.subject_ref }] }, admission: scope } };
}

function item(row: Record<string, unknown>, index: number): GroupPageItem { const values = fields(row); return { itemRef: text(row.item_ref) || text(row.id) || `item-${index}`, text: text(values.text) || text(values.body) || text(values.content) || text(values.message) || text(row.text), authorRef: text(row.actor_ref) || text(row.author_ref) || text(row.author), createdAt: text(row.created_at) || text(row.createdAt) }; }

/** This decoder only accepts an owner projection already restricted by scope. */
export function decodeGroupPagesFeed(groupsRaw: unknown, itemsRaw: unknown, scope: unknown): GroupPage[] {
  const subjectRef = projectedSubjectRef(scope);
  if (!subjectRef) return [];
  const scopedItems = rows(itemsRaw)
    .filter((row) => (text(row.group_ref) || text(row.target_ref)) === subjectRef)
    .map(item)
    .filter((value) => value.text)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return rows(groupsRaw)
    .filter((row) => (text(row.group_ref) || text(row.groupRef) || text(row.id)) === subjectRef)
    .map((row) => { const values = fields(row); return { groupRef: subjectRef, name: text(row.name) || text(row.title) || text(values.name) || text(values.title) || 'Untitled group', summary: text(row.summary) || text(row.description) || text(row.purpose) || text(values.summary) || text(values.description), accessRef: text(row.access_ref) || text(row.accessRef) || text(row.access) || text(values.access_ref), items: scopedItems }; });
}
