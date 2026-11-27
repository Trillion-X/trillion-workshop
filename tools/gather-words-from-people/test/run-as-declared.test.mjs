// tools/gather-words-from-people/test/run-as-declared.test.mjs
//
// Each tool run the way its row runs it: the row's own entry program is run by the real driver with the input on
// standard input and NO records door (the rows declare none, and nothing is handed on descriptor 3). Each answer holds the
// result, and a changing tool's answer holds the `keep` for the caller's AI to put in a store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const tools = fileURLToPath(new URL('../..', import.meta.url));
const rows = Object.fromEntries(JSON.parse(readFileSync(`${folder}/what-this-tool-does-and-how-to-run-it.json`, 'utf8')).records.map(({ payload }) => [payload.id, payload]));

const fields = ['words', 'who', 'person', 'consent', 'consent_note', 'status', 'case', 'win', 'asked_at', 'approved_identity'];
const list = {
  label: 'Made-up praise',
  row_type: 'made-up-praise',
  fields: fields.map(id => ({ id, kind: 'text', label: id })),
  gathers: {
    fields: Object.fromEntries(fields.map(id => [id, id])),
    consents: [{ id: 'full-name', label: 'Show my words with my name', may_show: true, name_use: 'full' }, { id: 'private', label: 'Keep my words private', may_show: false }],
    states: { asked: 'asked', received: 'received', approved: 'approved', declined: 'declined', withdrawn: 'withdrawn' },
    ask: { subject: 'How did it go, {name}?', body: 'Hi {name}, would you say in your own words how it went?' },
  },
};

async function run(toolId, input) {
  const row = rows[toolId];
  assert.equal(row.invoke.records, undefined, `${toolId} declares no records door`);
  assert.ok(!row.invoke.run.some(part => part.includes('records-door')), `${toolId} runs no records-door program`);
  const [, driver, entry, name] = row.invoke.run.map(part => part.replace('/opt/workflows/', `${tools}/workflows/`).replace('/opt/gather-words-from-people/', `${folder}/`));
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [driver, entry, name], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', fail);
    child.on('close', () => done(JSON.parse(out.trim().split('\n').at(-1))));
    child.stdin.end(JSON.stringify(input));
  });
}

test('every tool runs with no records door, from asking to what may show, and answers what to keep', async () => {
  const ask = await run('tool:ask-people-for-words', { list, rows: [], case: 'made-up-case', people: [{ id: 'p1', name: 'Pat Example', address: 'pat@example.com', win: 'made-up-ref' }] });
  assert.equal(ask.error, undefined);
  const [asked] = ask.result.keep;
  assert.equal(asked.id, ask.result.asked[0].row_id);

  const keep = await run('tool:keep-the-words-a-person-gave', { list, rows: [{ id: asked.id, value: asked.value }], row_id: asked.id, words: 'Made-up words.', consent: 'full-name', consent_note: 'made-up consent' });
  assert.equal(keep.error, undefined);
  assert.equal(keep.result.status, 'received');
  const receivedRow = keep.result.keep[0];

  const approve = await run('tool:approve-words-to-show', { list, rows: [{ id: receivedRow.id, value: receivedRow.value }], row_id: receivedRow.id, decision: 'approve', reviewed_words: 'Made-up words.' });
  assert.equal(approve.error, undefined);
  assert.equal(approve.result.status, 'approved');
  assert.match(approve.result.keep[0].value.approved_identity, /^1f:[0-9a-f]{64}$/);

  const shown = await run('tool:read-words-that-may-show', { list, rows: [{ id: receivedRow.id, value: approve.result.keep[0].value }] });
  assert.deepEqual(shown.result.items.map(item => item.body), ['Made-up words.']);
});

test('reading what may show needs the list definition and the rows only', async () => {
  const shown = await run('tool:read-words-that-may-show', { list, rows: [] });
  assert.deepEqual(shown.result, { items: [], shown: 0, may_show_total: 0, held_back: {} });
  const wrong = await run('tool:read-words-that-may-show', { rows: [] });
  assert.match(wrong.error, /list/);
});
