// The request check for the sales contract AI tool (manage-sales-contracts): one operation from its list, and only the
// fields its input schema names, each of the schema's type. Port of the input_schema in
// records/workshop-sales-contract-tool-records.json at 3b7063d6f3. The old dispatch messages were not in the tool file,
// so the problem words here come from the schema itself; the operations stay the caller's to run.
import data from './ai-tool-manage-sales-contracts.json' with { type: 'json' };
import { object } from './list-contract-records.mjs';

const EMAIL = new RegExp(data.email_pattern);

/** → { ok, problems }: every problem with the request, in words, empty when it is ready to run. */
export function checkManageRequest(input) {
  if (!object(input)) return { ok: false, problems: [data.messages.not_object] };
  const problems = [];
  if (!data.operations.includes(input.operation)) {
    problems.push(data.messages.operation.replace('{operations}', () => data.operations.join(', ')));
  }
  for (const field of Object.keys(input)) {
    if (!data.fields.includes(field)) problems.push(data.messages.unknown_field.replace('{field}', () => field));
  }
  if (input.contract_id !== undefined && typeof input.contract_id !== 'string') problems.push(data.messages.contract_id);
  if (input.contract !== undefined && !object(input.contract)) problems.push(data.messages.contract);
  if (input.name !== undefined && typeof input.name !== 'string') problems.push(data.messages.name);
  if (input.to !== undefined && (typeof input.to !== 'string' || !EMAIL.test(input.to))) problems.push(data.messages.to);
  if (input.scope !== undefined && !object(input.scope)) problems.push(data.messages.scope);
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > data.max_note_length)) {
    problems.push(data.messages.note.replace('{max}', () => String(data.max_note_length)));
  }
  if (input.expires_at !== undefined && (typeof input.expires_at !== 'string' || !Number.isFinite(Date.parse(input.expires_at)))) {
    problems.push(data.messages.expires_at);
  }
  return { ok: problems.length === 0, problems };
}
