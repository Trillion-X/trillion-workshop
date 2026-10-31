// tools/publish-a-changelog/do-work/record-a-step.mjs
//
// Records steps on a queue of work records and returns the queue as it then stands. Run by the Workshop tool
// `tool:record-a-publishing-step` in the tool container:
//
//   node do-work/record-a-step.mjs < <the input as JSON>
//
// `graph` is the queue as data; each of `steps` is one step ({ operationId, descriptorId or method, recordId,
// fieldPatch, relationshipPatch, receipt, correction, expectedBasis, actor, observedAt, sources }). A step names an
// action of the graph by descriptorId, and that action's patch, params and bindings apply. The record the step is
// about is offered to the action's bindings as the source `selected` unless the step gives its own. A step whose
// action names an owner is handed back in `handoffs` with its inputs bound; every other step is applied to the queue.
// Prints the answer on its last line.
import { text } from 'node:stream/consumers';
import { buildRecordStep, materializeRecordActionGraph } from './record-action-steps.ts';

const input = JSON.parse((await text(process.stdin)) || '{}');
if (!input.graph || typeof input.graph !== 'object' || Array.isArray(input.graph)) throw new Error('Send graph: the queue described as data.');
if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error('Send steps: at least one step to record.');

const records = Array.isArray(input.graph.records) ? input.graph.records : [];
const descriptors = Array.isArray(input.graph.actions) ? input.graph.actions : [];
const operations = [];
const handoffs = [];
const refused = [];
for (const step of input.steps) {
  const recordId = typeof step?.recordId === 'string' ? step.recordId : undefined;
  const selected = records.find(record => record && record.id === recordId);
  const result = buildRecordStep({ ...step, descriptors, sources: { ...(selected ? { selected } : {}), ...step?.sources } });
  operations.push(...result.recordOperations);
  handoffs.push(...result.handoffs);
  if (result.errors.length > 0) refused.push({ operationId: step?.operationId ?? null, errors: result.errors });
}
console.log(JSON.stringify({
  operations,
  handoffs,
  refused,
  graph: materializeRecordActionGraph(input.graph, operations),
}));
