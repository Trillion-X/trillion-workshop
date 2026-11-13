// tools/gather-words-from-people/test/run-as-declared.test.mjs
//
// Each tool run the way its row runs it: the row's own rights (with the list and row type filled from the input, as the
// engine fills them) are all the made-up door grants, and the row's own entry program is run by the real driver, with the
// input on standard input and the door on descriptor 3. A right a tool needs but its row does not declare fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const tools = fileURLToPath(new URL('../..', import.meta.url));
const rows = Object.fromEntries(JSON.parse(readFileSync(`${folder}/tool-rows.json`, 'utf8')).records.map(({ payload }) => [payload.id, payload]));

const fields = ['words', 'who', 'person', 'consent', 'consent_note', 'status', 'case', 'win', 'asked_at', 'approved_identity'];
const list = {
  id: 'list:made-up-praise',
  type: 'list',
  value: {
    label: 'Made-up praise',
    row_type: 'made-up-praise',
    fields: fields.map(id => ({ id, kind: 'text', label: id })),
    gathers: {
      fields: Object.fromEntries(fields.map(id => [id, id])),
      consents: [{ id: 'full-name', label: 'Show my words with my name', may_show: true, name_use: 'full' }, { id: 'private', label: 'Keep my words private', may_show: false }],
      states: { asked: 'asked', received: 'received', approved: 'approved', declined: 'declined', withdrawn: 'withdrawn' },
      ask: { subject: 'How did it go, {name}?', body: 'Hi {name}, would you say in your own words how it went?' },
    },
  },
};
const base = { list: 'list:made-up-praise', type: 'record:made-up-praise' };

// The rights a row declares, with each `fill` taken from the input as the engine takes it.
const rightsOf = (row, input) => row.invoke.records.rights.map(right => ({
  ...right,
  kind: typeof right.kind === 'object' ? input[right.kind.fill.field] : right.kind,
  ...(right.id === undefined ? {} : { id: typeof right.id === 'object' ? input[right.id.fill.field] : right.id }),
}));

async function run(toolId, input, records) {
  const row = rows[toolId];
  const door = await startFakeDoor({ rights: rightsOf(row, input), records });
  try {
    const [, driver, entry, name] = row.invoke.argv.map(part => part.replace('/opt/records-door/', `${tools}/records-door/`).replace('/opt/gather-words-from-people/', `${folder}/`));
    const answer = await new Promise((done, fail) => {
      const child = spawn(process.execPath, [driver, entry, name], { stdio: ['pipe', 'pipe', 'pipe', openSync(door.descriptor, 'r')] });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('error', fail);
      child.on('close', () => done(JSON.parse(out.trim().split('\n').at(-1))));
      child.stdin.end(JSON.stringify(input));
    });
    return { answer, kept: door };
  } finally { await door.close(); }
}

test('every tool runs on exactly the rights its row declares, from asking to what may show', async () => {
  const ask = await run('tool:ask-people-for-words', { ...base, case: 'made-up-case', people: [{ id: 'p1', name: 'Pat Example', address: 'pat@example.com', win: 'made-up-ref' }] }, [list]);
  assert.equal(ask.answer.error, undefined);
  const rowId = ask.answer.result.asked[0].row_id;
  const written = { id: rowId, type: 'record:made-up-praise', value: { who: 'Pat Example', person: 'p1', status: 'asked', case: 'made-up-case', win: 'made-up-ref', asked_at: 'x' } };

  const keep = await run('tool:keep-the-words-a-person-gave', { ...base, row_id: rowId, words: 'Made-up words.', consent: 'full-name', consent_note: 'made-up consent' }, [list, written]);
  assert.equal(keep.answer.error, undefined);
  assert.equal(keep.answer.result.status, 'received');
  const received = { ...written, value: { ...written.value, words: 'Made-up words.', consent: 'full-name', consent_note: 'made-up consent', status: 'received' } };

  const approve = await run('tool:approve-words-to-show', { ...base, row_id: rowId, decision: 'approve', reviewed_words: 'Made-up words.' }, [list, received]);
  assert.equal(approve.answer.error, undefined);
  assert.equal(approve.answer.result.status, 'approved');
  assert.match(approve.kept.kept.get(rowId).value.approved_identity, /^1f:[0-9a-f]{64}$/);
});

test('reading what may show needs the list and the row type only, and refuses a row type that is not the list\'s', async () => {
  const shown = await run('tool:read-words-that-may-show', base, [list]);
  assert.deepEqual(shown.answer.result, { items: [], shown: 0, may_show_total: 0, held_back: {} });
  const wrong = await run('tool:read-words-that-may-show', { ...base, type: 'record:another' }, [list]);
  assert.match(wrong.answer.error, /record:made-up-praise/);
});
