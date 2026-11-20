// The sales contract actions (do-work/sales-contract-actions.mjs) over a fake records door: the person's contracts are read a
// page at a time, a save writes back its record with the sales-contract type, and a read of a missing contract is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSalesContract, listSalesContracts, readSalesContract } from '../do-work/sales-contract-actions.mjs';

function fakeHost(seed = []) {
  const rows = new Map(seed.map(row => [row.id, row]));
  const calls = [];
  return {
    rows, calls,
    operation: async (method, input) => {
      calls.push({ method, input });
      if (method === 'records:list') {
        const keys = [...rows.keys()].sort();
        const start = input.after ? keys.indexOf(input.after) + 1 : 0;
        const page = keys.slice(start, start + 2).map(id => ({ id, type: rows.get(id).type, value: rows.get(id).value }));
        const more = start + 2 < keys.length;
        return { records: page, ...(more ? { next: page.at(-1).id } : {}) };
      }
      if (method === 'records:write') {
        for (const record of input.records) rows.set(record.id, { id: record.id, type: record.type, value: record.value });
        return { written: input.records.length };
      }
      throw new Error(`unexpected door method ${method}`);
    },
  };
}

const negotiated = { name: 'Casey CPG engagement', primitives: [
  { type: 'Commitment', label: 'Services', amount: 125000, currency: 'USD', recurrence: 'monthly' },
] };

test('a saved contract is written back as a sales-contract record and listed on the next read', async () => {
  const host = fakeHost([
    { id: 'sales-contract:old', type: 'sales-contract', value: { id: 'sales-contract:old', kind: 'sales-contract', status: 'draft', name: 'Older terms', contract: { name: 'Older terms' }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' } },
    { id: 'unrelated:1', type: 'note', value: { words: 'not a contract' } },
  ]);
  const saved = await saveSalesContract({ contract: negotiated }, host);
  assert.match(saved.id, /^sales-contract:/);
  assert.deepEqual(saved.contract, negotiated);
  const write = host.calls.find(call => call.method === 'records:write');
  assert.equal(write.input.records.length, 1);
  assert.equal(write.input.records[0].type, 'sales-contract');
  assert.equal(write.input.records[0].id, saved.id);
  const listed = await listSalesContracts({}, host);
  assert.equal(listed.count, 2, 'the contracts of both pages are read, and the note is not one');
  assert.deepEqual(listed.contracts.map(row => row.id).sort(), [saved.id, 'sales-contract:old'].sort());
  assert.equal(host.calls.filter(call => call.method === 'records:list').length >= 2, true, 'a second page was read');
});

test('an update keeps the first creation time and names an unknown contract as not in this account', async () => {
  const host = fakeHost([]);
  const first = await saveSalesContract({ contract: negotiated }, host);
  const updated = await saveSalesContract({ contract_id: first.id, contract: { name: 'Updated terms' } }, host);
  assert.equal(updated.created_at, first.created_at);
  assert.deepEqual(await readSalesContract({ contract_id: first.id }, host), updated);
  await assert.rejects(() => readSalesContract({ contract_id: 'sales-contract:unknown' }, host), /There is no sales contract/);
});

test('a save with no name is refused before anything is written', async () => {
  const host = fakeHost([]);
  await assert.rejects(() => saveSalesContract({ contract: { primitives: [] } }, host), /Give the contract a name/);
  assert.equal(host.calls.some(call => call.method === 'records:write'), false);
});
