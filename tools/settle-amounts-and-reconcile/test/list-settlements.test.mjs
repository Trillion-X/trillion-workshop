// read-data/list-settlements.mjs over the person's records (do-work/settle-over-records.mjs): settlement, reconciliation,
// entries, line totals and the report basis. Moved from old trillion test/list-settlements.test.mjs with every assertion
// as it was; only fresh() changed: the lists are records in a records door kept in memory, and each tool is the
// settlement action its old list tool posted to. Left out, because they test the old lists engine (src/lists.mjs), not
// the settlement code: 'a field keeps its limits: ...' and 'a balanced list refuses, atomically, ...', and the last line
// of the report-basis test (lists.save refusing a report_basis that is not one of the options).
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDoor } from '../../watch-my-sources/test/memory-door.mjs';
import { settle } from '../do-work/settle-over-records.mjs';

// The old list tool each test calls, and the settlement action it posted to (old trillion src/list-tools.mjs).
const actions = {
  propose_list_settlement: 'propose', settle_list_rows: 'apply', unsettle_list_rows: 'remove', read_list_settlement: 'position',
  close_list_reconciliation: 'close', check_list_reconciliation: 'check', undo_list_reconciliation: 'undo', check_list_balance: 'balance',
  post_list_entry: 'post', reverse_list_entry: 'reverse', total_list_lines: 'totals', report_list_basis: 'basis',
};

// The person's lists as the tests set them up and read them back: straight on the door's records, in the shape a
// Trillion list keeps them (list:<id> of type list; record:<row_type>:<row id> of type record:<row_type>).
function listsIn(door) {
  const find = id => { const held = door.kept.get(`list:${id}`); return held ? { id, ...held.value } : null; };
  const type = id => `record:${find(id).row_type}`;
  return {
    find,
    save({ id, ...definition }) {
      const value = { ...(find(id) ? (({ id: _id, ...rest }) => rest)(find(id)) : { row_type: id, indexes: [] }), ...definition };
      door.kept.set(`list:${id}`, { id: `list:${id}`, type: 'list', value });
    },
    putRows(id, { rows = [], remove = [] }) {
      for (const row of rows) {
        const recordId = `${type(id)}:${row.id}`;
        const value = { ...(door.kept.get(recordId)?.value ?? {}) };
        for (const [field, given] of Object.entries(row.values ?? {})) { if (given === null) delete value[field]; else value[field] = given; }
        door.kept.set(recordId, { id: recordId, type: type(id), value });
      }
      for (const rowId of remove) door.kept.delete(`${type(id)}:${rowId}`);
    },
    read(id) {
      const prefix = `${type(id)}:`;
      return { rows: [...door.kept.values()].filter(record => record.id.startsWith(prefix)).map(record => ({ id: record.id.slice(prefix.length), values: structuredClone(record.value) })) };
    },
  };
}

function fresh() {
  const door = memoryDoor();
  const lists = listsIn(door);
  lists.save({ id: 'invoices', label: 'Invoices', row_type: 'settle-invoice', title_field: 'name',
    fields: [{ id: 'name', label: 'Name' }, { id: 'total', label: 'Total', kind: 'number' }, { id: 'due', label: 'Due', kind: 'date' }] });
  lists.save({ id: 'payments', label: 'Payments', row_type: 'settle-payment', title_field: 'name',
    fields: [{ id: 'name', label: 'Name' }, { id: 'amount', label: 'Amount', kind: 'number' }] });
  lists.putRows('invoices', { rows: [
    { id: 'inv-march', values: { name: 'March', total: 100.1, due: '2026-03-01' } },
    { id: 'inv-jan', values: { name: 'January', total: 50, due: '2026-01-01' } },
    { id: 'inv-feb', values: { name: 'February', total: 80.2, due: '2026-02-01' } },
    { id: 'inv-blank', values: { name: 'No amount yet', due: '2026-04-01' } },
  ] });
  lists.putRows('payments', { rows: [
    { id: 'pay-1', values: { name: 'Wire', amount: 200 } },
    { id: 'pay-blank', values: { name: 'Unknown' } },
  ] });
  const tool = name => input => settle({ action: actions[name], ...input }, { door });
  return { door, lists, tool };
}

const base = {
  list_id: 'payments',
  source: { row_id: 'pay-1', amount_field: 'amount' },
  targets: { list_id: 'invoices', amount_field: 'total', order_field: 'due' },
};

test('a payment is proposed oldest first and the rest is a credit, never forced onto a row', async () => {
  const { tool } = fresh();
  const proposal = await tool('propose_list_settlement')(base);
  assert.deepEqual(proposal.proposals.map(row => [row.target_id, row.apply, row.remaining]), [
    ['inv-jan', 50, 0], ['inv-feb', 80.2, 0], ['inv-march', 69.8, 30.3],
  ]);
  assert.equal(proposal.unapplied, 0);
  const small = await tool('propose_list_settlement')({ ...base, source: { row_id: 'pay-1', amount_field: 'amount' }, order: 'largest_first', targets: { ...base.targets, row_ids: ['inv-jan'] } });
  assert.deepEqual(small.proposals.map(row => row.apply), [50]);
  assert.equal(small.unapplied, 150, 'what no row can take stays as unapplied credit');
});

test('settling keeps one allocation row per target, applies once per request key, and unsettling reopens only that target', async () => {
  const { tool, lists } = fresh();
  const first = await tool('settle_list_rows')({ ...base, request_key: 'wire-1' });
  assert.equal(first.outcome.state, 'all');
  assert.deepEqual(first.items.map(item => item.state), ['done', 'done', 'done']);
  const kept = lists.read('payments-to-invoices-allocations');
  assert.equal(kept.rows.length, 3, 'three allocation rows exist in the allocations list');
  const again = await tool('settle_list_rows')({ ...base, request_key: 'wire-1' });
  assert.deepEqual(again.items.map(item => item.state), ['already_done', 'already_done', 'already_done']);
  assert.equal(lists.read('payments-to-invoices-allocations').rows.length, 3, 'a retry with the same key writes nothing');
  const march = await tool('read_list_settlement')({ list_id: 'invoices', row: { row_id: 'inv-march', amount_field: 'total' }, allocations: { list_id: 'payments-to-invoices-allocations' } });
  assert.equal(march.applied, 69.8);
  assert.equal(march.open, 30.3);
  assert.equal(march.allocations[0].source[0], 'pay-1');
  const allocationId = first.items.find(item => item.target_id === 'inv-feb').allocation_id;
  const removed = await tool('unsettle_list_rows')({ ...base, allocation_ids: [allocationId, 'nope'] });
  assert.deepEqual(removed.items.map(item => item.state), ['done', 'already_done']);
  assert.equal(removed.source.available, 80.2);
  const proposal = await tool('propose_list_settlement')(base);
  assert.deepEqual(proposal.proposals.map(row => [row.target_id, row.apply]), [['inv-feb', 80.2]], 'the removed allocation reopened exactly that target');
  assert.equal((await tool('read_list_settlement')({ list_id: 'invoices', row: { row_id: 'inv-jan', amount_field: 'total' }, allocations: { list_id: 'payments-to-invoices-allocations' } })).open, 0, 'the other targets are untouched');
});

test('partial results are listed item by item and an empty amount is not zero', async () => {
  const { tool } = fresh();
  const partial = await tool('settle_list_rows')({ ...base, request_key: 'wire-2', items: [
    { target_id: 'inv-jan', amount: 50 }, { target_id: 'inv-feb', amount: 999 }, { target_id: 'inv-blank', amount: 5 }, { target_id: 'inv-march', amount: 0 },
  ] });
  assert.equal(partial.outcome.state, 'some');
  assert.deepEqual(partial.items.map(item => item.state), ['done', 'refused', 'refused', 'refused']);
  assert.match(partial.items[1].why, /only 80\.2 open/);
  assert.match(partial.items[2].why, /has no total number/);
  const none = await tool('settle_list_rows')({ ...base, request_key: 'wire-3', items: [{ target_id: 'inv-feb', amount: 999 }] });
  assert.equal(none.outcome.state, 'none');
  await assert.rejects(() => tool('propose_list_settlement')({ ...base, source: { row_id: 'pay-blank', amount_field: 'amount' } }), /has no amount number/);
  const over = await tool('settle_list_rows')({ ...base, request_key: 'wire-4', items: [{ target_id: 'inv-jan', amount: 9999 }] });
  assert.equal(over.items[0].state, 'refused', 'more than the source holds is refused, not clipped');
});

const bank = (lists, rows) => {
  lists.save({ id: 'bank', label: 'Bank lines', row_type: 'settle-bank', title_field: 'name',
    fields: [{ id: 'name', label: 'Name' }, { id: 'amount', label: 'Amount', kind: 'number' }, { id: 'reconciled_in', label: 'Closed in', kind: 'text' }] });
  lists.putRows('bank', { rows });
};
const linesBase = { list_id: 'bank', lines: { amount_field: 'amount' } };

test('a close needs the statement to add up or a residual in words, keeps a receipt, and is found out when a line changes', async () => {
  const { tool, lists } = fresh();
  bank(lists, [
    { id: 'l1', values: { name: 'Sale', amount: 100 } }, { id: 'l2', values: { name: 'Fee', amount: -2.5 } }, { id: 'l3', values: { name: 'Later', amount: 10 } },
  ]);
  const close = { ...linesBase, row_ids: ['l1', 'l2'], period: '2026-01', opening_balance: 1000, statement_balance: 1097, request_key: 'jan' };
  await assert.rejects(() => tool('close_list_reconciliation')(close), /differ by -0\.5/);
  const closed = await tool('close_list_reconciliation')({ ...close, residual_reason: 'Bank rounding fee' });
  assert.equal(closed.receipt.residual, -0.5);
  assert.equal(closed.receipt.reason, 'Bank rounding fee');
  assert.equal(lists.read('bank').rows.find(row => row.id === 'l1').values.reconciled_in, closed.receipt_id);
  assert.equal(lists.read('bank').rows.find(row => row.id === 'l3').values.reconciled_in, undefined);
  assert.equal((await tool('close_list_reconciliation')({ ...close, residual_reason: 'Bank rounding fee' })).repeated, true, 'the same key returns the same receipt');
  await assert.rejects(() => tool('close_list_reconciliation')({ ...close, request_key: 'again', residual_reason: 'x' }), /already closed/);
  assert.equal((await tool('check_list_reconciliation')(linesBase)).ok, true);
  lists.putRows('bank', { rows: [{ id: 'l2', values: { amount: -3 } }] });
  lists.putRows('bank', { remove: ['l1'] });
  const found = await tool('check_list_reconciliation')({ ...linesBase, record: true });
  assert.deepEqual(found.discrepancies.map(one => [one.line_id, one.was, one.now]).sort(), [['l1', 100, null], ['l2', -2.5, -3]]);
  assert.equal(found.recorded, 2);
  assert.equal((await tool('check_list_reconciliation')({ ...linesBase, record: true })).recorded, 0, 'a discrepancy is recorded once');
  const receipts = lists.read('bank-reconciliations').rows;
  assert.equal(receipts.filter(row => row.values.kind === 'discrepancy').length, 2);
  assert.equal(receipts.find(row => row.id === closed.receipt_id).values.undone_at, undefined, 'the receipt itself is never edited by a check');
  const undone = await tool('undo_list_reconciliation')(linesBase);
  assert.equal(undone.reopened, 2);
  assert.equal(lists.read('bank').rows.find(row => row.id === 'l2').values.reconciled_in, undefined);
  assert.ok(lists.read('bank-reconciliations').rows.find(row => row.id === closed.receipt_id).values.undone_at, 'the receipt stays, marked undone');
  await assert.rejects(() => tool('undo_list_reconciliation')(linesBase), /no closed reconciliation/);
});

test('entries whose signed lines do not add to zero are listed, and a line with no amount is unplaced, not zero', async () => {
  const { tool, lists } = fresh();
  lists.save({ id: 'journal', label: 'Journal lines', row_type: 'settle-journal', title_field: 'name',
    fields: [{ id: 'name', label: 'Name' }, { id: 'amount', label: 'Amount', kind: 'number' }, { id: 'entry', label: 'Entry' }] });
  lists.putRows('journal', { rows: [
    { id: 'a1', values: { name: 'Cash', amount: 100.1, entry: 'e1' } }, { id: 'a2', values: { name: 'Sales', amount: -100.1, entry: 'e1' } },
    { id: 'b1', values: { name: 'Rent', amount: 50, entry: 'e2' } }, { id: 'b2', values: { name: 'Cash', amount: -49.9, entry: 'e2' } },
    { id: 'c1', values: { name: 'Blank', entry: 'e3' } },
  ] });
  const answer = await tool('check_list_balance')({ list_id: 'journal', lines: { amount_field: 'amount', group_field: 'entry' } });
  assert.deepEqual(answer.unbalanced, [{ group: 'e2', sum: 0.1 }]);
  assert.deepEqual(answer.unplaced, ['c1']);
  assert.equal(answer.balanced, false);
});

test('an entry posts only when its lines add to zero, once, and is undone by a new entry', async () => {
  const { tool, lists } = fresh();
  lists.save({ id: 'journal', label: 'Journal lines', row_type: 'settle-journal', title_field: 'name',
    fields: [{ id: 'name', label: 'Name' }, { id: 'amount', label: 'Amount', kind: 'number' }, { id: 'entry', label: 'Entry' }] });
  const lines = { amount_field: 'amount', group_field: 'entry' };
  const rows = [{ values: { name: 'Cash', amount: 100.1 } }, { values: { name: 'Sales', amount: -100.1 } }];
  await assert.rejects(() => tool('post_list_entry')({ list_id: 'journal', lines, entry_id: 'e1', rows: [rows[0], { values: { name: 'Sales', amount: -100 } }] }), /add to 0\.1, not zero/);
  assert.equal(lists.read('journal').rows.length, 0, 'an unbalanced entry writes nothing');
  await tool('post_list_entry')({ list_id: 'journal', lines, entry_id: 'e1', rows });
  assert.equal((await tool('post_list_entry')({ list_id: 'journal', lines, entry_id: 'e1', rows })).repeated, true);
  assert.equal(lists.read('journal').rows.length, 2);
  const reversed = await tool('reverse_list_entry')({ list_id: 'journal', lines, entry_id: 'e1', reverse_id: 'e1-undo' });
  assert.equal(reversed.reverses, 'e1');
  const all = lists.read('journal').rows;
  assert.equal(all.length, 4, 'the original lines stay');
  assert.deepEqual(all.filter(row => row.values.entry === 'e1-undo').map(row => row.values.amount).sort(), [-100.1, 100.1]);
  assert.equal((await tool('check_list_balance')({ list_id: 'journal', lines })).balanced, true);
});

test('a percent line names its base and the answer shows it', async () => {
  const { tool, lists } = fresh();
  lists.save({ id: 'quote', label: 'Quote', row_type: 'settle-quote', title_field: 'name',
    fields: [{ id: 'name', label: 'Name' }, { id: 'kind', label: 'Kind' }, { id: 'value', label: 'Value', kind: 'number' }, { id: 'base', label: 'Base' }, { id: 'pos', label: 'Position', kind: 'number' }] });
  lists.putRows('quote', { rows: [
    { id: 'a', values: { name: 'Design', kind: 'amount', value: 200, pos: 1 } },
    { id: 'b', values: { name: 'Build', kind: 'amount', value: 800, pos: 2 } },
    { id: 'c', values: { name: 'Subtotal', kind: 'subtotal', pos: 3 } },
    { id: 'd', values: { name: 'Discount', kind: 'percent', value: -10, base: 'previous_line', pos: 4 } },
    { id: 'e', values: { name: 'Rush', kind: 'percent', value: 10, base: 'since_subtotal', pos: 5 } },
  ] });
  const answer = await tool('total_list_lines')({ list_id: 'quote', lines: { order_field: 'pos' } });
  const byId = Object.fromEntries(answer.lines.map(line => [line.id, line]));
  assert.equal(byId.c.subtotal, 1000);
  assert.equal(byId.d.amount, -80, 'previous_line is the one amount line above (800), not the 1000 subtotal');
  assert.equal(byId.d.base.id, 'previous_line');
  assert.equal(byId.d.base.amount, 800);
  assert.equal(byId.e.amount, -8, 'since_subtotal is what the lines after the subtotal added up to (-80)');
  assert.equal(byId.e.base.amount, -80);
  assert.equal(answer.total, 912);
  lists.putRows('quote', { rows: [{ id: 'f', values: { name: 'Tax', kind: 'percent', value: 5, pos: 6 } }] });
  await assert.rejects(() => tool('total_list_lines')({ list_id: 'quote', lines: { order_field: 'pos' } }), /must say its base/);
});

test('accrual and cash read the same rows, each figure naming its basis and the allocation behind it', async () => {
  const { tool } = fresh();
  await tool('settle_list_rows')({ ...base, request_key: 'basis', items: [{ target_id: 'inv-jan', amount: 50 }, { target_id: 'inv-feb', amount: 30 }], date: '2026-03-15T10:00:00Z' });
  const report = await tool('report_list_basis')({ list_id: 'invoices', targets: { amount_field: 'total', date_field: 'due' }, allocations: { list_id: 'payments-to-invoices-allocations' }, from: '2026-03-01', to: '2026-03-31' });
  assert.equal(report.accrual.total, 100.1, 'March accrual is the March invoice');
  assert.equal(report.cash.total, 80, 'March cash is what was applied in March');
  assert.deepEqual(report.cash.rows.map(row => row.target[0]).sort(), ['inv-feb', 'inv-jan']);
  assert.equal(report.cash.basis, 'cash');
  assert.match(report.cash.says, /^Cash/);
});

test('the report basis is a saved setting on the list, overridable per call, and every figure names its basis', async () => {
  const { tool, lists } = fresh();
  await tool('settle_list_rows')({ ...base, request_key: 'rb', items: [{ target_id: 'inv-jan', amount: 50 }], date: '2026-01-20T00:00:00Z' });
  const call = extra => tool('report_list_basis')({ list_id: 'invoices', targets: { amount_field: 'total', date_field: 'due' }, allocations: { list_id: 'payments-to-invoices-allocations' }, from: '2026-01-01', to: '2026-01-31', ...extra });
  assert.equal((await call({})).basis, 'both');
  lists.save({ id: 'invoices', report_basis: 'cash' });
  const cash = await call({});
  assert.equal(cash.basis, 'cash');
  assert.equal(cash.accrual, undefined);
  assert.equal(cash.cash.total, 50);
  assert.equal((await call({ basis: 'accrual' })).accrual.total, 50);
});
