// tools/publish-a-changelog/do-work/see-what-is-ready.mjs
//
// Reads a queue of work records the person is getting ready to publish: which group each record is in, what each
// one's actions are, which rule blocks it (a missing proof, for one) and which receipts it already has. Run by the
// Workshop tool `tool:see-what-work-is-ready-to-publish` in the tool container:
//
//   node do-work/see-what-is-ready.mjs < <the input as JSON>
//
// `graph` describes the queue (groups, fields, relationships, views, rules, actions, surface_copy) and the records and
// receipts come in it or beside it. Prints the laid-out queue on its last line.
import { text } from 'node:stream/consumers';
import { readRecordActionProjection } from '../read-data/read-record-action-projection.ts';

const input = JSON.parse((await text(process.stdin)) || '{}');
if (!input.graph || typeof input.graph !== 'object' || Array.isArray(input.graph)) {
  throw new Error('Send graph: the queue described as data (groups, fields, relationships, views, rules, actions), with its records in graph.records or in recordAtoms.');
}
console.log(JSON.stringify(readRecordActionProjection({
  graph: input.graph,
  recordAtoms: input.recordAtoms,
  receiptAtoms: input.receiptAtoms,
  selectedRecordId: input.selectedRecordId,
  status: input.status,
  issues: input.issues,
})));
