// The sales contract statements (do-work/sales-contract-sql.mjs) through a fake client that answers the three statement shapes
// the tool runs: the table, the upsert, one page of the list and one read. The rules are the store's: a name is needed, a save
// keeps the first creation time, a page is newest first, and a removed contract is not read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSalesContracts } from '../do-work/sales-contract-sql.mjs';

function fakeClient(removed = []) {
  const table = new Map();
  const statements = [];
  return {
    table, statements,
    query: async (text, values = []) => {
      statements.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (text.startsWith('CREATE TABLE')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO sales_contracts')) {
        const [id, name, contract, at] = values;
        if (removed.includes(id)) return { rows: [], rowCount: 0 };
        const earlier = table.get(id);
        const row = { id, name, status: 'draft', contract: JSON.parse(contract), share_id: earlier?.share_id ?? null,
          created_at: earlier?.created_at ?? at, updated_at: at };
        table.set(id, row);
        return { rows: [row], rowCount: 1 };
      }
      if (text.includes('WHERE id = $1')) {
        const row = table.get(values[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes('ORDER BY updated_at DESC')) {
        const [cursorAt, cursorId, limit] = values;
        const sorted = [...table.values()].sort((a, b) => (b.updated_at.localeCompare(a.updated_at)) || (b.id.localeCompare(a.id)));
        const after = cursorAt === null ? sorted : sorted.filter(row => row.updated_at < cursorAt || (row.updated_at === cursorAt && row.id < cursorId));
        return { rows: after.slice(0, limit), rowCount: Math.min(after.length, limit) };
      }
      throw new Error(`the fake client does not know: ${text.slice(0, 60)}`);
    },
  };
}

const negotiated = { name: 'Casey CPG engagement', primitives: [
  { type: 'Commitment', label: 'Services', amount: 125000, currency: 'USD', recurrence: 'monthly' },
] };

test('a saved contract comes back as the store shapes it, with the table made first', async () => {
  const client = fakeClient();
  const saved = await runSalesContracts({ action: 'save', contract: negotiated }, client);
  assert.equal(client.statements[0], 'CREATE TABLE IF');
  assert.match(saved.id, /^sales-contract:/);
  assert.equal(saved.kind, 'sales-contract');
  assert.equal(saved.status, 'draft');
  assert.deepEqual(saved.contract, negotiated);
  const read = await runSalesContracts({ action: 'read', contract_id: saved.id }, client);
  assert.deepEqual(read, saved);
});

test('a save keeps the first creation time and names an unknown contract as not in this account', async () => {
  const client = fakeClient();
  const first = await runSalesContracts({ action: 'save', contract: negotiated }, client);
  const updated = await runSalesContracts({ action: 'save', contract_id: first.id, contract: { name: 'Updated terms' } }, client);
  assert.equal(updated.created_at, first.created_at);
  assert.equal(updated.name, 'Updated terms');
  await assert.rejects(() => runSalesContracts({ action: 'read', contract_id: 'sales-contract:unknown' }, client), /There is no sales contract/);
});

test('a contract with no name is refused before any statement that writes', async () => {
  const client = fakeClient();
  await assert.rejects(() => runSalesContracts({ action: 'save', contract: { primitives: [] } }, client), /Give the contract a name/);
  assert.equal(client.statements.some(text => text.startsWith('INSERT')), false);
});

test('a list is one page, newest first, and its cursor reaches the rest', async () => {
  const client = fakeClient();
  const ids = [];
  for (const name of ['One', 'Two', 'Three']) {
    ids.push((await runSalesContracts({ action: 'save', contract: { name } }, client)).id);
  }
  const first = await runSalesContracts({ action: 'list', limit: 2 }, client);
  assert.equal(first.count, 2);
  assert.ok(first.next, 'a full page names the next cursor');
  const second = await runSalesContracts({ action: 'list', limit: 2, after: first.next }, client);
  assert.equal(second.count, 1);
  assert.equal(second.next, undefined);
  const seen = [...first.contracts, ...second.contracts].map(row => row.id);
  assert.deepEqual(seen.sort(), [...ids].sort(), 'every contract is listed once across the pages');
  await assert.rejects(() => runSalesContracts({ action: 'list', limit: 0 }, client), /limit must be a whole number/);
  await assert.rejects(() => runSalesContracts({ action: 'list', after: 'not a cursor' }, client), /after is the next cursor/);
});

test('a removed contract is not read and is not revived by a save', async () => {
  const client = fakeClient(['sales-contract:gone']);
  await assert.rejects(() => runSalesContracts({ action: 'save', contract_id: 'sales-contract:gone', contract: negotiated }, client), /was removed/);
  await assert.rejects(() => runSalesContracts({ action: 'read', contract_id: 'sales-contract:gone' }, client), /There is no sales contract/);
});
