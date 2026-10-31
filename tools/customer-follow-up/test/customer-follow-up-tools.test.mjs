// The four customer tools run as the container runs them (node, the input on stdin, the answer on the last stdout
// line). Each row that keeps a record names where in the answer it is and which fields are its type and id; the test
// checks every such selector finds a record whose type and id are there, and that see-where-each-customer-is reads back
// what the others made. Made-up customers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const rowOf = id => rows.find(row => row.id === id);

function run(id, input) {
  const [command, ...rest] = rowOf(id).invoke.argv;
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

const kept = (id, answer) => rowOf(id).keeps_records.map(keep => {
  const record = answer[keep.output_selector.replace(/^\$\./, '')];
  return { type: record[keep.type_field], id: record[keep.id_field], record };
});

test('each tool that keeps a record names a record with a type and an id in its answer', async () => {
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
