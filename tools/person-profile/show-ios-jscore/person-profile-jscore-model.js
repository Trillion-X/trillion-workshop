export function materializationToNativeTree(materialization) {
  const value = materialization && materialization.value ? materialization.value : materialization;
  const sections = [];
  sections.push({ kind: 'identityHeader', data: value.identity });
  if (Array.isArray(value.fields) && value.fields.length > 0) {
    sections.push({ kind: 'fieldGroup', data: value.fields });
  }
  for (const relationship of Array.isArray(value.relationships) ? value.relationships : []) {
    sections.push({ kind: 'contributionShelf', data: relationship });
  }
  if (Array.isArray(value.actions) && value.actions.length > 0) {
    sections.push({ kind: 'actionArea', data: value.actions });
  }
  return { surfaceId: value.surfaceId, readerId: value.readerId, sections };
}
