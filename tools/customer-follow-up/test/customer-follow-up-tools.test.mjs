// The four customer tools run as the container runs them (node, the input on stdin, the answer on the last stdout
// line). The three tools that build a record answer it (`contact_record`, `step_record`, `target_record`) with its type and
// id inside, and keep nothing: no row declares `keeps_records` or a records door. The test checks each answer holds its
// record, and that see-where-each-customer-is reads back what the others made. Made-up customers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = JSON.parse(readFileSync(join(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records.map(record => record.payload);
const rowOf = id => rows.find(row => row.id === id);

function run(id, input) {
  const [command, ...rest] = rowOf(id).invoke.run;
  return new Promise((done, fail) => {
    const child = spawn(command === 'node' ? process.execPath : command, rest, { cwd: folder, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', fail);
    child.on('close', status => done({ status, err, answer: status === 0 ? JSON.parse(out.trim().split('\n').at(-1)) : null }));
    child.stdin.end(JSON.stringify(input));
  });
}

const ANSWERED = { 'tool:add-a-customer': ['contact_record', 'kind', 'contactId'], 'tool:set-a-customer-target': ['target_record', 'kind', 'targetId'], 'tool:record-a-customer-step': ['step_record', 'kind', 'stepId'] };
const kept = (id, answer) => {
  const [field, typeField, idField] = ANSWERED[id];
  const record = answer[field];
  return [{ type: record[typeField], id: record[idField], record }];
};

test('each tool that builds a record answers it with a type and an id, and keeps nothing', async () => {
  const contact = await run('tool:add-a-customer', { name: ' Sam Example ', reach_them_by: 'email', owner: 'Pat', came_from: 'a talk' });
  assert.equal(contact.status, 0, contact.err);
  const [keptContact] = kept('tool:add-a-customer', contact.answer);
  assert.equal(keptContact.type, 'customer-contact');
  assert.match(keptContact.id, /^contact:/);
  assert.equal(keptContact.record.displayName, 'Sam Example');

  const target = await run('tool:set-a-customer-target', { product_id: 'product:demo', product_name: 'Demo product', customers: 10 });
  const [keptTarget] = kept('tool:set-a-customer-target', target.answer);
  assert.deepEqual([keptTarget.type, keptTarget.id], ['customer-product-target', 'target:product:demo']);
  assert.equal(keptTarget.record.targetCount, 10);

  const step = await run('tool:record-a-customer-step', { contact_id: keptContact.id, product_id: 'product:demo', step: 'purchase', at: '2026-06-20T12:00:00.000Z' });
  const [keptStep] = kept('tool:record-a-customer-step', step.answer);
  assert.equal(keptStep.type, 'customer-step');
  assert.equal(keptStep.record.label, 'Purchase recorded');

  const seen = await run('tool:see-where-each-customer-is', { records: [keptContact.record, keptTarget.record, keptStep.record], contact_id: keptContact.id });
  assert.equal(seen.answer.customer_count, 1);
  assert.deepEqual(
    [seen.answer.products[0].customerCount, seen.answer.products[0].targetCount, seen.answer.products[0].remainingCount, seen.answer.products[0].percent],
    [1, 10, 9, 10],
  );
  assert.equal(seen.answer.selectedContact.contact.contactId, keptContact.id);
});

test('the tools refuse input that names no customer, product or target size', async () => {
  assert.notEqual((await run('tool:add-a-customer', { name: '  ' })).status, 0);
  assert.notEqual((await run('tool:set-a-customer-target', { product_id: 'p', product_name: 'P', customers: 0 })).status, 0);
  assert.notEqual((await run('tool:record-a-customer-step', { contact_id: ' ', product_id: 'p', step: 'reply' })).status, 0);
});

test('no row keeps a record or holds a records door, and the see-where run needs records sent to it', async () => {
  for (const row of rows) {
    assert.equal(row.keeps_records, undefined, row.id);
    assert.equal(row.invoke?.records, undefined, row.id);
    assert.equal(JSON.stringify(row.input_schema).includes('x-your-records'), false, row.id);
  }
  const none = await run('tool:see-where-each-customer-is', {});
  assert.notEqual(none.status, 0);
  assert.match(none.err, /Send the customer records/);
});
