// src/database-list-calls.mjs
//
// Purpose: the calls a list placed in a customer database answers there (src/customer-database-resource.mjs), each the
// list owner's own method (src/lists.mjs makeLists) with that method's own arguments, so a list in its own database
// keeps every behaviour it has in an account's records (fields, links, settled values, conditional writes, views,
// manual order). The command meter reads the same names (src/database-command-quota.mjs).
//
//   DATABASE_LIST_CALLS: operation -> (lists, input, actor) => answer
//   DATABASE_LIST_READS: the operations that change nothing (lists:backlinks is built over the list owner's reads, src/list-row-operations.mjs, and lists:documentTypes reads a folder's sidecar in the Namespace, src/document-properties.mjs, so neither has a call of its own)
//   HOMED_LIST_CALLS: method -> operation for the row calls answered only where a list's rows live (src/placed-lists.mjs
//                     routes each by the list's home); each takes (list_id, input, { actor }) and is sent as { list_id, input }.
export const HOMED_LIST_CALLS = Object.freeze({ keyHolders: 'lists:keyHolders', linkHolders: 'lists:linkHolders', removedRows: 'lists:removedRows',
  restoreRows: 'lists:restoreRows', fieldAt: 'lists:fieldAt', keepSnapshot: 'lists:keepSnapshot', readSnapshot: 'lists:readSnapshot',
  fieldHistory: 'lists:fieldHistory', noteUse: 'lists:noteUse', heatOf: 'lists:heatOf',
  resolve: 'lists:resolve', filters: 'lists:filters', saveFilter: 'lists:saveFilter', removeFilter: 'lists:removeFilter',
  proposeChanges: 'lists:proposeChanges', proposals: 'lists:proposals', proposal: 'lists:proposal', decideProposal: 'lists:decideProposal' });
export const DATABASE_LIST_CALLS = Object.freeze({
  ...Object.fromEntries(Object.entries(HOMED_LIST_CALLS).map(([method, operation]) => [operation, (lists, input, actor) => lists[method](input.list_id, input.input ?? {}, { actor })])),
  'lists:find': (lists, input) => lists.find(input.list_id),
  'lists:save': (lists, input, actor) => lists.save(input.list, { actor }),
  'lists:read': (lists, input) => lists.read(input.list_id, input.options ?? {}),
  'lists:putRows': (lists, input, actor) => lists.putRows(input.list_id, { rows: input.rows ?? [], remove: input.remove ?? [] }, { actor }),
  'lists:previewRows': (lists, input, actor) => lists.previewRows(input.list_id, { rows: input.rows ?? [], remove: input.remove ?? [] }, { actor }),
  'lists:saveView': (lists, input, actor) => lists.saveView(input.list_id, input.view, { actor }),
  'lists:removeView': (lists, input, actor) => lists.removeView(input.list_id, input.view_id, { actor }),
  'lists:moveRow': (lists, input, actor) => lists.moveRow(input.list_id, input.move, { actor }),
  'lists:search': (lists, input) => lists.search(input.search ?? {}),
  'lists:all': lists => lists.all(),
  'lists:retire': (lists, input, actor) => lists.retire(input.list_id, input.row_ids ?? [], { actor }),
});
export const DATABASE_LIST_READS = new Set(['lists:find', 'lists:read', 'lists:search', 'lists:all', 'lists:previewRows', 'lists:backlinks', 'lists:aggregate',
  'lists:keyHolders', 'lists:linkHolders', 'lists:removedRows', 'lists:fieldAt', 'lists:readSnapshot', 'lists:fileReferences',
  'lists:fieldHistory', 'lists:filters', 'lists:resolve', 'lists:heatOf', 'lists:proposals', 'lists:proposal', 'lists:needsReview', 'lists:coldRows', 'lists:documentTypes']);
