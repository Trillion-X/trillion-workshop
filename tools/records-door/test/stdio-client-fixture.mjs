import { createInterface } from 'node:readline';
const mode = process.argv[2];
const kept = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  const { id, params } = JSON.parse(line);
  if (mode === 'exit') process.exit(0);
  if (mode === 'wait') continue;
  if (mode === 'invalid') { console.log('invalid-json'); continue; }
  const { method, input, request_key } = params.arguments;
  let structuredContent;
  if (mode === 'refuse') { console.log(JSON.stringify({ id, result: { isError: true, structuredContent: { code: 'current_workspace_rights_refused', outcome: 'not_started' } } })); continue; }
  if (method === 'records:write') {
    for (const row of input.records) kept.set(row.id, { id: row.id, type: row.type, value: row.value });
    structuredContent = { write_count: input.records.length, request_key };
  } else if (method === 'records:list') {
    const rows = [...kept.values()];
    const index = Number(input.after ?? 0);
    structuredContent = { records: rows.slice(index, index + 1), next: index + 1 < rows.length ? String(index + 1) : null };
  } else structuredContent = kept.get(input.id) ?? { id: input.id, type: input.type, value: null };
  console.log(JSON.stringify({ id, result: { isError: false, structuredContent } }));
}
