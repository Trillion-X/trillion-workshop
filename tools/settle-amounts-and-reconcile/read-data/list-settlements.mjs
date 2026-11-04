// src/list-settlements.mjs
//
// Purpose
//   Two things any list of amounts needs, once, over the person's own lists (src/lists.mjs), with no business named:
//   SETTLEMENT applies an amount held by one row (a payment, a credit, a grant) across other rows (invoices, bills,
//   budgets) as allocation rows between them, and RECONCILIATION closes a set of cleared lines against a statement
//   with an explained residual, a receipt per close and a record of any later edit to a closed line.
//
// Non-negotiable invariants
//   1. An allocation is its own row linking a source row to a target row with an amount. Nothing is kept on the two
//      rows: a row's applied and open amounts are always worked out from the allocation rows, so removing an
//      allocation reopens the target and frees the source and changes nothing else (no cascade).
//   2. What is left of a source after allocation is reported as unapplied (a credit). It is never forced onto a row.
//   3. A row with no amount has nothing to settle: an empty amount is not zero (refused with the field named).
//   4. Applying or removing many items reports each one (done, already_done or refused, with why) and a three-state
//      outcome (all, some, none). One refused item never hides or undoes the others, and each is retryable alone.
//   5. The same request_key applied again changes nothing: an allocation row's id is made from the key, the source and
//      the target. A close with the same request_key returns the same receipt.
//   6. After the writes, the totals are read again; an allocation that left a target or source over-applied (another
//      change used the amount first) is removed and reported refused, never left in place.
//   7. A close needs the cleared lines to add up to the statement, or a residual explained in words. A receipt is kept
//      forever (a close that is undone gets undone_at; the receipt stays). A line that changed or was removed after
//      it was closed is found by check and may be recorded as a discrepancy row beside the receipts.
//   8. A balance check reads signed lines grouped under an entry and lists every entry that does not add to zero;
//      a line with no amount or no entry is listed as unplaced, never counted as zero. It reads only.
//   9. Orders, field names, limits and words are rows in src/list-settlements.json, never branches here.
//  10. An entry (signed lines under one entry id) is posted only when its lines add to zero, in one write; it is never
//      edited, and is undone by a new entry with every line negated. Percent lines name their base (previous line,
//      since the last subtotal, all above) and the answer shows the base used. Accrual and cash are two reads of the
//      same rows and allocations, each figure naming its basis and listing the rows behind it.
//  11. A list too large to read in full for an answer says so (too_large); a partial read is never presented as the
//      whole.
//
// Shapes
//   makeSettlements({ lists, now? }) → { propose, settle, unsettle, position, checkBalance,
//                                          closeReconciliation, checkReconciliation, undoReconciliation }
//   handleSettlementRequest(lists, action, input) → Response   (POST /lists/<list>/settlement/<action>)
import data from './list-settlements.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

/** BLAKE3-256 of the bytes as 64 hex digits, from the one content-identity owner (its `1f:` prefix dropped). */
const blake3Hex = bytes => makeHashCodeHexFromBytes(bytes).slice(3);

export class SettlementError extends Error {}

const { limits } = data;
const orders = new Map(data.orders.map(order => [order.id, order]));
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const say = (key, values = {}) => new SettlementError(fill(data.words[key], values));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const identity = (...parts) => blake3Hex(new TextEncoder().encode(JSON.stringify(parts)));
const idsOf = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : typeof value === 'string' && value ? [value] : []);

export const unitsOf = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * data.scale) : null);
export const SETTLEMENT_SCALE = data.scale;
export const REPORT_BASES = data.basis.options.map(option => option.id);
const amountOf = value => value / data.scale;

function need(value, what, detail) {
  if (value === null || value === undefined || value === '') throw say('bad_input', { what, detail });
  return value;
}

// A row to read: { list_id, row_id, amount_field }, the list id with or without its list: prefix.
const listIdOf = value => String(need(text(value), 'list_id', 'the id of a list from list_lists')).replace(/^list:/, '');

async function scanAll(lists, listId, keep) {
  const rows = [];
  let cursor;
  let scanned = 0;
  for (;;) {
    const page = await lists.read(listId, { limit: limits.page_rows, ...(cursor === undefined ? {} : { cursor }), ...(keep ? { keep } : {}) });
    rows.push(...page.rows);
    scanned += page.page?.scanned ?? page.rows.length;
    if (scanned > limits.max_scan_rows) throw say('too_large', { list_id: listId, limit: limits.max_scan_rows });
    if (!page.page || page.page.complete || !page.page.next_cursor) return rows;
    cursor = page.page.next_cursor;
  }
}

async function rowsByIds(lists, listId, rowIds) {
  const found = new Map();
  for (let at = 0; at < rowIds.length; at += 500) {
    const read = await lists.read(listId, { row_ids: rowIds.slice(at, at + 500) });
    for (const row of read.rows) found.set(row.id, row);
  }
  return found;
}

const allocationFields = spec => ({ ...data.allocation_fields, ...Object.fromEntries(Object.entries(isObject(spec) ? spec : {}).filter(([, value]) => text(value)).map(([key, value]) => [key.replace(/_field$/, ''), value])) });

function outcomeOf(items) {
  const done = items.filter(item => item.state !== data.item_states.refused).length;
  const state = done === items.length ? 'all' : done === 0 ? 'none' : 'some';
  return { state, done, count: items.length, says: fill(data.outcomes[state], { done, count: items.length }) };
}

export function makeSettlements({ lists, now = () => new Date().toISOString() }) {
  const ensureAllocations = async (spec, fields) => {
    const definition = data.lists.allocations;
    const names = { source: spec.source.list_id, target: spec.targets.list_id };
    const id = text(spec.allocations?.list_id) ?? fill(definition.id, names);
    if (!await lists.find(id)) {
      return await lists.ensure({
        id, label: fill(definition.label, names), row_type: definition.row_type, title_field: fields.amount,
        fields: [
          { id: fields.source, label: 'Source', kind: 'link', links_to: spec.source.list_id },
          { id: fields.target, label: 'Target', kind: 'link', links_to: spec.targets.list_id },
          { id: fields.amount, label: 'Amount', kind: 'number' },
          { id: fields.date, label: 'Date', kind: 'text' },
          { id: fields.request, label: 'Request', kind: 'text' },
        ],
      });
    }
    return null;
  };

  function readSpec(input) {
    if (!isObject(input)) throw say('bad_input', { what: 'The settlement', detail: 'an object with source, targets and request_key' });
    const source = isObject(input.source) ? input.source : {};
    const targets = isObject(input.targets) ? input.targets : {};
    const spec = {
      source: { list_id: listIdOf(source.list_id), row_id: need(text(source.row_id), 'source.row_id', 'the row that holds the amount'), amount_field: need(text(source.amount_field), 'source.amount_field', 'the number field with the amount') },
      targets: { list_id: listIdOf(targets.list_id ?? source.list_id), amount_field: need(text(targets.amount_field), 'targets.amount_field', 'the number field with each row\'s amount'), order_field: text(targets.order_field), row_ids: Array.isArray(targets.row_ids) ? targets.row_ids : null },
      allocations: isObject(input.allocations) ? input.allocations : {},
      order: text(input.order) ?? data.default_order,
    };
    if (!orders.has(spec.order)) throw say('no_order', { order: spec.order, orders: [...orders.keys()].join(', ') });
    if (orders.get(spec.order).by === 'order_field' && !spec.targets.order_field) throw say('order_needs_field', { order: spec.order });
    return spec;
  }

  // Every allocation between the two lists, summed by source row and by target row.
  async function ledger(spec, fields, exceptRequest = null) {
    const id = text(spec.allocations.list_id) ?? fill(data.lists.allocations.id, { source: spec.source.list_id, target: spec.targets.list_id });
    const bySource = new Map();
    const byTarget = new Map();
    const rows = new Map();
    if (await lists.find(id)) {
      for (const row of await scanAll(lists, id)) {
        const amount = unitsOf(row.values[fields.amount]);
        if (amount === null) continue;
        rows.set(row.id, row);
        if (exceptRequest !== null && row.values[fields.request] === exceptRequest) continue;
        for (const sourceId of idsOf(row.values[fields.source])) bySource.set(sourceId, (bySource.get(sourceId) ?? 0) + amount);
        for (const targetId of idsOf(row.values[fields.target])) byTarget.set(targetId, (byTarget.get(targetId) ?? 0) + amount);
      }
    }
    return { list_id: id, bySource, byTarget, rows };
  }

  async function sourceOf(spec, books) {
    const row = (await rowsByIds(lists, spec.source.list_id, [spec.source.row_id])).get(spec.source.row_id);
    if (!row) throw say('no_row', { row_id: spec.source.row_id, list_id: spec.source.list_id });
    const amount = unitsOf(row.values[spec.source.amount_field]);
    if (amount === null) throw say('no_amount', { row_id: row.id, list_id: spec.source.list_id, field_id: spec.source.amount_field });
    const applied = books.bySource.get(row.id) ?? 0;
    return { row, amount, applied, available: amount - applied };
  }

  async function openTargets(spec, books) {
    const rows = spec.targets.row_ids
      ? [...(await rowsByIds(lists, spec.targets.list_id, spec.targets.row_ids)).values()]
      : await scanAll(lists, spec.targets.list_id);
    const found = [];
    for (const row of rows) {
      if (spec.targets.list_id === spec.source.list_id && row.id === spec.source.row_id) continue;
      const amount = unitsOf(row.values[spec.targets.amount_field]);
      if (amount === null) continue;
      found.push({ id: row.id, amount, applied: books.byTarget.get(row.id) ?? 0, open: amount - (books.byTarget.get(row.id) ?? 0), order_value: spec.targets.order_field ? row.values[spec.targets.order_field] ?? null : null });
    }
    return found;
  }

  function sortTargets(targets, spec) {
    const order = orders.get(spec.order);
    const sign = order.direction === 'desc' ? -1 : 1;
    const key = target => (order.by === 'open' ? target.open : target.order_value);
    return [...targets].sort((left, right) => {
      const a = key(left);
      const b = key(right);
      // A row with no order value goes last whichever way the order runs; ties keep a fixed order by id.
      if (a === null && b !== null) return 1;
      if (b === null && a !== null) return -1;
      const compared = a === b ? 0 : a < b ? -1 : 1;
      return compared * sign || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
  }

  const view = value => ({ id: value.id, amount: amountOf(value.amount), applied: amountOf(value.applied), open: amountOf(value.open) });

  async function plan(spec, books) {
    const source = await sourceOf(spec, books);
    let remaining = Math.max(source.available, 0);
    const proposals = [];
    for (const target of sortTargets((await openTargets(spec, books)).filter(one => one.open > 0), spec)) {
      if (remaining <= 0) break;
      const apply = Math.min(target.open, remaining);
      remaining -= apply;
      proposals.push({ target_id: target.id, open: amountOf(target.open), apply: amountOf(apply), remaining: amountOf(target.open - apply) });
    }
    return {
      source: { list_id: spec.source.list_id, row_id: source.row.id, amount: amountOf(source.amount), applied: amountOf(source.applied), available: amountOf(source.available) },
      order: spec.order, proposals, unapplied: amountOf(remaining),
    };
  }

  async function propose(input) {
    const spec = readSpec(input);
    return plan(spec, await ledger(spec, allocationFields(spec.allocations)));
  }

  async function settle(input) {
    const spec = readSpec(input);
    const requestKey = need(text(input.request_key), 'request_key', 'any unique text; the same key applies once');
    const fields = allocationFields(spec.allocations);
    const planned = Array.isArray(input.items)
      ? input.items.map(item => ({ target_id: text(item?.target_id), amount: item?.amount }))
      // Without items the plan is made as if this request had not been applied yet, so asking again plans the same
      // allocations and finds each one already done.
      : (await plan(spec, await ledger(spec, fields, requestKey))).proposals.map(item => ({ target_id: item.target_id, amount: item.apply }));
    if (planned.length > limits.items_per_call) throw say('too_many_items', { limit: limits.items_per_call });
    await ensureAllocations(spec, fields);
    const books = await ledger(spec, fields);
    const source = await sourceOf(spec, books);
    const targets = new Map((await openTargets(spec, books)).map(target => [target.id, target]));
    const date = text(input.date) ?? now();
    const items = [];
    let available = source.available;
    for (const item of planned) {
      const result = { target_id: item.target_id, amount: item.amount };
      items.push(result);
      const amount = unitsOf(item.amount);
      if (!item.target_id || amount === null || amount <= 0) { Object.assign(result, { state: data.item_states.refused, why: say('bad_amount', { amount: item.amount }).message }); continue; }
      const allocationId = `a-${identity(requestKey, spec.source.row_id, item.target_id).slice(0, 24)}`;
      if (books.rows.has(allocationId)) { Object.assign(result, { state: data.item_states.already, allocation_id: allocationId }); continue; }
      const target = targets.get(item.target_id);
      if (!target) {
        const row = (await rowsByIds(lists, spec.targets.list_id, [item.target_id])).get(item.target_id);
        Object.assign(result, { state: data.item_states.refused, why: (row
          ? say('no_amount', { row_id: item.target_id, list_id: spec.targets.list_id, field_id: spec.targets.amount_field })
          : say('no_row', { row_id: item.target_id, list_id: spec.targets.list_id })).message });
        continue;
      }
      if (amount > target.open) { Object.assign(result, { state: data.item_states.refused, why: say('over_open', { row_id: target.id, open: amountOf(target.open), amount: item.amount }).message }); continue; }
      if (amount > available) { Object.assign(result, { state: data.item_states.refused, why: say('over_available', { available: amountOf(available), amount: item.amount }).message }); continue; }
      await lists.putRows(books.list_id, { rows: [{ id: allocationId, values: {
        [fields.source]: [spec.source.row_id], [fields.target]: [item.target_id], [fields.amount]: item.amount, [fields.date]: date, [fields.request]: requestKey,
      } }] });
      target.open -= amount;
      available -= amount;
      Object.assign(result, { state: data.item_states.done, allocation_id: allocationId });
    }
    // Read the books again: an allocation another change made over-applies a row, so this one comes back out.
    const after = await ledger(spec, fields);
    const sourceAfter = await sourceOf(spec, after);
    for (const result of [...items].reverse()) {
      if (result.state !== data.item_states.done) continue;
      const row = after.rows.get(result.allocation_id);
      const targetAmount = targets.get(result.target_id).amount;
      const targetOver = (after.byTarget.get(result.target_id) ?? 0) > targetAmount;
      if (!row || (!targetOver && sourceAfter.available >= 0)) continue;
      await lists.putRows(books.list_id, { remove: [result.allocation_id] });
      after.byTarget.set(result.target_id, (after.byTarget.get(result.target_id) ?? 0) - unitsOf(result.amount));
      sourceAfter.available += unitsOf(result.amount);
      Object.assign(result, { state: data.item_states.refused, why: say('over_applied_after_write').message });
      delete result.allocation_id;
    }
    return { allocations_list: books.list_id, items, outcome: outcomeOf(items), source: { row_id: spec.source.row_id, available: amountOf(sourceAfter.available) }, unapplied: amountOf(Math.max(sourceAfter.available, 0)) };
  }

  async function unsettle(input) {
    const spec = readSpec(input);
    const fields = allocationFields(spec.allocations);
    const ids = need(Array.isArray(input.allocation_ids) && input.allocation_ids.length ? input.allocation_ids : null, 'allocation_ids', 'the ids of the allocation rows to remove');
    if (ids.length > limits.items_per_call) throw say('too_many_items', { limit: limits.items_per_call });
    const books = await ledger(spec, fields);
    const items = [];
    for (const allocationId of ids) {
      const row = books.rows.get(allocationId);
      if (!row) { items.push({ allocation_id: allocationId, state: data.item_states.already }); continue; }
      if (!idsOf(row.values[fields.source]).includes(spec.source.row_id)) {
        items.push({ allocation_id: allocationId, state: data.item_states.refused, why: say('not_this_source', { allocation_id: allocationId }).message });
        continue;
      }
      await lists.putRows(books.list_id, { remove: [allocationId] });
      items.push({ allocation_id: allocationId, state: data.item_states.done, amount: row.values[fields.amount] });
    }
    const after = await ledger(spec, fields);
    const source = await sourceOf(spec, after);
    return { allocations_list: books.list_id, items, outcome: outcomeOf(items), source: { row_id: spec.source.row_id, available: amountOf(source.available) } };
  }

  // One row's amount, what has been applied to or from it, what is open, and the allocations behind it.
  async function position(input) {
    const row = isObject(input?.row) ? input.row : {};
    const listId = listIdOf(row.list_id);
    const rowId = need(text(row.row_id), 'row.row_id', 'the row to read');
    const amountField = need(text(row.amount_field), 'row.amount_field', 'the number field with its amount');
    const role = input.role === 'source' ? 'source' : 'target';
    const fields = allocationFields(input.allocations);
    const found = (await rowsByIds(lists, listId, [rowId])).get(rowId);
    if (!found) throw say('no_row', { row_id: rowId, list_id: listId });
    const amount = unitsOf(found.values[amountField]);
    if (amount === null) throw say('no_amount', { row_id: rowId, list_id: listId, field_id: amountField });
    const allocationsList = need(text(input.allocations?.list_id), 'allocations.list_id', 'the list that keeps the allocations');
    const side = role === 'source' ? fields.source : fields.target;
    const behind = await lists.find(allocationsList) ? await scanAll(lists, allocationsList, values => idsOf(values[side]).includes(rowId)) : [];
    const applied = behind.reduce((sum, one) => sum + (unitsOf(one.values[fields.amount]) ?? 0), 0);
    return {
      row_id: rowId, role, amount: amountOf(amount), applied: amountOf(applied), open: amountOf(amount - applied),
      allocations: behind.map(one => ({ allocation_id: one.id, source: idsOf(one.values[fields.source]), target: idsOf(one.values[fields.target]), amount: one.values[fields.amount], date: one.values[fields.date] ?? null })),
    };
  }

  // Reconciliation

  const receiptFields = data.reconciliation_fields.receipt;

  function readLines(input) {
    const lines = isObject(input?.lines) ? input.lines : {};
    return {
      list_id: listIdOf(lines.list_id),
      amount_field: need(text(lines.amount_field), 'lines.amount_field', 'the number field with each line\'s amount'),
      closed_in_field: text(lines.closed_in_field) ?? data.reconciliation_fields.lines_closed_in,
    };
  }

  function receiptsList(input, lines) {
    return text(input?.receipts?.list_id) ?? fill(data.lists.receipts.id, { lines: lines.list_id });
  }

  async function ensureReceipts(id, lines) {
    if (await lists.find(id)) return null;
    const definition = data.lists.receipts;
    return await lists.ensure({
      id, label: fill(definition.label, { lines: lines.list_id }), row_type: definition.row_type, title_field: definition.title_field,
      fields: [
        { id: receiptFields.kind, label: 'Kind', kind: 'text' },
        { id: receiptFields.period, label: 'Period', kind: 'text' },
        { id: receiptFields.opening, label: 'Opening balance', kind: 'number' },
        { id: receiptFields.statement, label: 'Statement balance', kind: 'number' },
        { id: receiptFields.cleared, label: 'Cleared total', kind: 'number' },
        { id: receiptFields.residual, label: 'Explained residual', kind: 'number' },
        { id: receiptFields.reason, label: 'Residual reason', kind: 'text' },
        { id: receiptFields.lines, label: 'Lines closed (id=amount)', kind: 'tags' },
        { id: receiptFields.fingerprint, label: 'Fingerprint', kind: 'text' },
        { id: receiptFields.closed_at, label: 'Closed at', kind: 'text' },
        { id: receiptFields.undone_at, label: 'Undone at', kind: 'text' },
        { id: receiptFields.request, label: 'Request', kind: 'text' },
        { id: receiptFields.line, label: 'Line', kind: 'text' },
        { id: receiptFields.was, label: 'Amount when closed', kind: 'number' },
        { id: receiptFields.now, label: 'Amount now', kind: 'number' },
        { id: receiptFields.receipt_ref, label: 'Receipt', kind: 'text' },
      ],
    });
  }

  async function requireLineFields(lines) {
    const list = await lists.find(lines.list_id);
    if (!list) throw say('no_row', { row_id: '(any)', list_id: lines.list_id });
    for (const [id, what] of [[lines.amount_field, 'lines.amount_field'], [lines.closed_in_field, 'lines.closed_in_field']]) {
      if (!list.fields.some(field => field.id === id)) throw say('bad_input', { what, detail: `${id} is not a field of ${lines.list_id}; save_list adds it` });
    }
  }

  const lineEntry = (id, amount) => `${id}=${amount}`;
  const fingerprintOf = entries => identity([...entries].sort());

  async function closeReconciliation(input) {
    const lines = readLines(input);
    const requestKey = need(text(input.request_key), 'request_key', 'any unique text; the same key closes once');
    const period = need(text(input.period), 'period', 'the statement period in words').slice(0, limits.period_chars);
    const opening = unitsOf(input.opening_balance);
    const statement = unitsOf(input.statement_balance);
    if (opening === null || statement === null) throw say('bad_input', { what: 'opening_balance and statement_balance', detail: 'both are numbers' });
    const rowIds = Array.isArray(input.row_ids) ? [...new Set(input.row_ids)] : [];
    if (!rowIds.length) throw say('no_lines');
    await requireLineFields(lines);
    const receiptsId = receiptsList(input, lines);
    await ensureReceipts(receiptsId, lines);
    const receiptId = `r-${identity(requestKey).slice(0, 24)}`;
    const earlier = (await rowsByIds(lists, receiptsId, [receiptId])).get(receiptId);
    if (earlier) return { receipt_id: receiptId, receipts_list: receiptsId, repeated: true, receipt: earlier.values };
    const found = await rowsByIds(lists, lines.list_id, rowIds);
    const entries = [];
    let cleared = 0;
    for (const rowId of rowIds) {
      const line = found.get(rowId);
      if (!line) throw say('no_row', { row_id: rowId, list_id: lines.list_id });
      const amount = unitsOf(line.values[lines.amount_field]);
      if (amount === null) throw say('no_amount', { row_id: rowId, list_id: lines.list_id, field_id: lines.amount_field });
      const closedIn = line.values[lines.closed_in_field];
      if (closedIn && closedIn !== receiptId) throw say('lines_closed', { row_id: rowId, receipt: closedIn });
      cleared += amount;
      entries.push(lineEntry(rowId, amount));
    }
    const difference = statement - (opening + cleared);
    const reason = text(input.residual_reason)?.slice(0, limits.reason_chars) ?? null;
    if (difference !== 0 && !reason) throw say('residual_unexplained', { difference: amountOf(difference) });
    if (input.residual !== undefined && unitsOf(input.residual) !== difference) throw say('residual_mismatch', { given: input.residual, difference: amountOf(difference) });
    const written = await lists.putRows(lines.list_id, { rows: rowIds.map(rowId => ({ id: rowId, values: { [lines.closed_in_field]: receiptId }, if_values: { [lines.closed_in_field]: found.get(rowId).values[lines.closed_in_field] ?? null } })) });
    if (written.conflicts?.length) {
      const mine = rowIds.filter(rowId => !written.conflicts.some(conflict => conflict.row_id === rowId));
      if (mine.length) await lists.putRows(lines.list_id, { rows: mine.map(rowId => ({ id: rowId, values: { [lines.closed_in_field]: null }, if_values: { [lines.closed_in_field]: receiptId } })) });
      throw say('close_conflict');
    }
    const receipt = {
      [receiptFields.kind]: 'receipt', [receiptFields.period]: period, [receiptFields.opening]: input.opening_balance, [receiptFields.statement]: input.statement_balance,
      [receiptFields.cleared]: amountOf(cleared), [receiptFields.residual]: amountOf(difference), ...(reason ? { [receiptFields.reason]: reason } : {}),
      [receiptFields.lines]: entries, [receiptFields.fingerprint]: fingerprintOf(entries), [receiptFields.closed_at]: now(), [receiptFields.request]: requestKey,
    };
    await lists.putRows(receiptsId, { rows: [{ id: receiptId, values: receipt }] });
    return { receipt_id: receiptId, receipts_list: receiptsId, receipt, closed: rowIds.length };
  }

  const openReceipts = async receiptsId => (await lists.find(receiptsId)
    ? await scanAll(lists, receiptsId, values => values[receiptFields.kind] === 'receipt' && !values[receiptFields.undone_at])
    : []);

  async function checkReconciliation(input) {
    const lines = readLines(input);
    const receiptsId = receiptsList(input, lines);
    const discrepancies = [];
    for (const receipt of await openReceipts(receiptsId)) {
      const wanted = receipt.values[receiptFields.lines].map(entry => {
        const at = entry.lastIndexOf('=');
        return { id: entry.slice(0, at), was: Number(entry.slice(at + 1)) };
      });
      const current = await rowsByIds(lists, lines.list_id, wanted.map(one => one.id));
      for (const one of wanted) {
        const row = current.get(one.id);
        const now_ = row ? unitsOf(row.values[lines.amount_field]) : null;
        if (row && now_ === one.was) continue;
        discrepancies.push({
          receipt_id: receipt.id, line_id: one.id, was: amountOf(one.was), now: now_ === null ? null : amountOf(now_),
          says: say(row ? 'line_changed' : 'line_removed').message,
        });
      }
    }
    let recorded = 0;
    if (input.record === true && discrepancies.length) {
      const rows = discrepancies.map(found => ({
        id: `d-${identity(found.receipt_id, found.line_id, found.now).slice(0, 24)}`,
        values: { [receiptFields.kind]: 'discrepancy', [receiptFields.period]: found.says, [receiptFields.receipt_ref]: found.receipt_id, [receiptFields.line]: found.line_id, [receiptFields.was]: found.was, ...(found.now === null ? {} : { [receiptFields.now]: found.now }), [receiptFields.closed_at]: now() },
      }));
      const known = await rowsByIds(lists, receiptsId, rows.map(row => row.id));
      const fresh = rows.filter(row => !known.has(row.id));
      if (fresh.length) await lists.putRows(receiptsId, { rows: fresh });
      recorded = fresh.length;
    }
    return { receipts_list: receiptsId, discrepancies, recorded, ok: discrepancies.length === 0 };
  }

  async function undoReconciliation(input) {
    const lines = readLines(input);
    const receiptsId = receiptsList(input, lines);
    const [latest] = (await openReceipts(receiptsId)).sort((left, right) => {
      const a = left.values[receiptFields.closed_at];
      const b = right.values[receiptFields.closed_at];
      return a === b ? (left.id < right.id ? 1 : -1) : a < b ? 1 : -1;
    });
    if (!latest) throw say('nothing_to_undo', { lines: lines.list_id });
    const ids = latest.values[receiptFields.lines].map(entry => entry.slice(0, entry.lastIndexOf('=')));
    await lists.putRows(lines.list_id, { rows: ids.map(id => ({ id, values: { [lines.closed_in_field]: null }, if_values: { [lines.closed_in_field]: latest.id } })) });
    await lists.putRows(receiptsId, { rows: [{ id: latest.id, values: { [receiptFields.undone_at]: now() } }] });
    return { receipt_id: latest.id, receipts_list: receiptsId, reopened: ids.length };
  }

  // Signed lines grouped under one header (a journal entry's lines): every group's amounts add to zero, or it is listed.
  async function checkBalance(input) {
    const lines = isObject(input?.lines) ? input.lines : {};
    const listId = listIdOf(lines.list_id);
    const amountField = need(text(lines.amount_field), 'lines.amount_field', 'the number field with each line\'s signed amount');
    const groupField = need(text(lines.group_field), 'lines.group_field', 'the field that names the entry each line belongs to');
    const groups = new Map();
    const unplaced = [];
    for (const row of await scanAll(lists, listId)) {
      const amount = unitsOf(row.values[amountField]);
      const group = idsOf(row.values[groupField]).join(',') || text(row.values[groupField]);
      if (amount === null || !group) { unplaced.push(row.id); continue; }
      groups.set(group, (groups.get(group) ?? 0) + amount);
    }
    const unbalanced = [...groups].filter(([, sum]) => sum !== 0).map(([group, sum]) => ({ group, sum: amountOf(sum) }));
    return { list_id: listId, groups: groups.size, unbalanced, unplaced, balanced: unbalanced.length === 0 };
  }

  // Entries: signed lines posted together so they add to zero in one write, and undone by a new entry, never an edit.
  const entryLines = input => {
    const lines = isObject(input?.lines) ? input.lines : {};
    return {
      list_id: listIdOf(lines.list_id),
      amount_field: need(text(lines.amount_field), 'lines.amount_field', 'the number field with each line\'s signed amount'),
      group_field: need(text(lines.group_field), 'lines.group_field', 'the field that names the entry each line belongs to'),
    };
  };
  const entryRowId = (entryId, index) => `e-${identity(entryId, index).slice(0, 24)}`;

  async function postEntry(input) {
    const lines = entryLines(input);
    const entryId = need(text(input.entry_id), 'entry_id', 'any unique text; the same entry posts once');
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (rows.length < 2) throw say('entry_too_short');
    if (rows.length > limits.items_per_call) throw say('too_many_items', { limit: limits.items_per_call });
    let sum = 0;
    for (const [index, row] of rows.entries()) {
      const amount = unitsOf(row?.values?.[lines.amount_field]);
      if (amount === null) throw say('no_amount', { row_id: `line ${index + 1}`, list_id: lines.list_id, field_id: lines.amount_field });
      sum += amount;
    }
    if (sum !== 0) throw say('entry_unbalanced', { sum: amountOf(sum) });
    const ids = rows.map((_, index) => entryRowId(entryId, index));
    const earlier = await rowsByIds(lists, lines.list_id, ids);
    if (earlier.size === ids.length) return { entry_id: entryId, line_ids: ids, repeated: true };
    if (earlier.size) throw say('entry_partial', { entry_id: entryId });
    await lists.putRows(lines.list_id, { rows: rows.map((row, index) => ({ id: ids[index], values: { ...row.values, [lines.group_field]: entryId } })) });
    return { entry_id: entryId, line_ids: ids };
  }

  async function reverseEntry(input) {
    const lines = entryLines(input);
    const entryId = need(text(input.entry_id), 'entry_id', 'the entry to reverse');
    const reverseId = need(text(input.reverse_id), 'reverse_id', 'any unique text for the reversing entry');
    const original = (await scanAll(lists, lines.list_id, values => text(values[lines.group_field]) === entryId))
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    if (!original.length) throw say('no_entry', { entry_id: entryId, list_id: lines.list_id });
    const rows = original.map(row => ({ values: { ...row.values, [lines.amount_field]: amountOf(-unitsOf(row.values[lines.amount_field])) } }));
    return { reverses: entryId, ...(await postEntry({ lines, entry_id: reverseId, rows })) };
  }

  // The lines of a quote or invoice, each percent saying which base it multiplies; the answer names the base it used.
  async function totalLines(input) {
    const lines = isObject(input?.lines) ? input.lines : {};
    const listId = listIdOf(lines.list_id);
    const kindField = text(lines.kind_field) ?? data.line_totals.fields.kind;
    const valueField = text(lines.value_field) ?? data.line_totals.fields.value;
    const baseField = text(lines.base_field) ?? data.line_totals.fields.base;
    const orderField = text(lines.order_field);
    const kinds = new Map(data.line_totals.kinds.map(kind => [kind.id, kind]));
    const bases = new Map(data.line_totals.bases.map(base => [base.id, base]));
    const rows = Array.isArray(input.row_ids) ? [...(await rowsByIds(lists, listId, input.row_ids)).values()] : await scanAll(lists, listId);
    rows.sort((left, right) => {
      const a = orderField ? left.values[orderField] ?? null : null;
      const b = orderField ? right.values[orderField] ?? null : null;
      return a === b ? (left.id < right.id ? -1 : 1) : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
    });
    const answered = [];
    let running = 0;
    let sinceSubtotal = 0;
    let previous = 0;
    for (const row of rows) {
      const kind = kinds.get(row.values[kindField]);
      if (!kind) throw say('line_kind', { row_id: row.id, kind: JSON.stringify(row.values[kindField] ?? null), kinds: [...kinds.keys()].join(', ') });
      const value = row.values[valueField];
      let amount = 0;
      let base = null;
      if (kind.adds === 'value') {
        amount = unitsOf(value);
        if (amount === null) throw say('no_amount', { row_id: row.id, list_id: listId, field_id: valueField });
      } else if (kind.adds === 'percent_of_base') {
        if (typeof value !== 'number') throw say('no_amount', { row_id: row.id, list_id: listId, field_id: valueField });
        const baseId = text(row.values[baseField]);
        if (!baseId) throw say('line_base', { row_id: row.id, field_id: baseField, bases: [...bases.keys()].join(', ') });
        if (!bases.has(baseId)) throw say('line_base', { row_id: row.id, field_id: baseField, bases: [...bases.keys()].join(', ') });
        const baseAmount = { previous_line: previous, since_subtotal: sinceSubtotal, all_above: running }[bases.get(baseId).reads];
        base = { id: baseId, says: bases.get(baseId).says, amount: amountOf(baseAmount) };
        amount = Math.round(baseAmount * value / 100);
      }
      if (kind.reports === 'since_subtotal') {
        answered.push({ id: row.id, kind: kind.id, amount: 0, subtotal: amountOf(sinceSubtotal), running: amountOf(running) });
        sinceSubtotal = 0;
        continue;
      }
      running += amount;
      sinceSubtotal += amount;
      previous = amount;
      answered.push({ id: row.id, kind: kind.id, ...(typeof value === 'number' ? { value } : {}), ...(base ? { base } : {}), amount: amountOf(amount), running: amountOf(running) });
    }
    return { list_id: listId, lines: answered, total: amountOf(running) };
  }

  // The same records read on two bases: accrual by the date a row is due, cash by the date of each allocation to it.
  async function basisReport(input) {
    const targets = isObject(input?.targets) ? input.targets : {};
    const targetList = listIdOf(targets.list_id);
    const amountField = need(text(targets.amount_field), 'targets.amount_field', 'the number field with each row\'s amount');
    const dateField = need(text(targets.date_field), 'targets.date_field', 'the date field accrual is read by');
    const allocationsId = need(text(input.allocations?.list_id), 'allocations.list_id', 'the list that keeps the allocations');
    const fields = allocationFields(input.allocations);
    const from = need(text(input.from), 'from', 'the first date, like 2026-01-01');
    const to = need(text(input.to), 'to', 'the last date, like 2026-01-31');
    const within = value => typeof value === 'string' && value.slice(0, 10) >= from && value.slice(0, 10) <= to;
    const accrualRows = (await scanAll(lists, targetList)).filter(row => within(row.values[dateField]) && unitsOf(row.values[amountField]) !== null);
    const accrual = accrualRows.reduce((sum, row) => sum + unitsOf(row.values[amountField]), 0);
    const cashRows = await lists.find(allocationsId) ? (await scanAll(lists, allocationsId, values => within(values[fields.date]))).filter(row => unitsOf(row.values[fields.amount]) !== null) : [];
    const cash = cashRows.reduce((sum, row) => sum + unitsOf(row.values[fields.amount]), 0);
    const cap = rows => ({ rows: rows.slice(0, limits.report_rows), truncated: rows.length > limits.report_rows });
    // The basis is a setting: the call's own, else the one saved on the list (save_list report_basis), else the DATA default.
    const optionIds = data.basis.options.map(option => option.id);
    const basis = text(input.basis) ?? text((await lists.find(targetList))?.report_basis) ?? data.default_basis;
    if (!optionIds.includes(basis)) throw say('bad_basis', { basis, bases: optionIds.join(', ') });
    const says = id => data.basis.options.find(option => option.id === id).says;
    const shown = id => basis === id || basis === 'both';
    return {
      from, to, basis, basis_says: says(basis),
      ...(shown('accrual') ? { accrual: { basis: 'accrual', says: says('accrual'), total: amountOf(accrual), count: accrualRows.length, ...cap(accrualRows.map(row => ({ row_id: row.id, amount: row.values[amountField], date: row.values[dateField] }))) } } : {}),
      ...(shown('cash') ? { cash: { basis: 'cash', says: says('cash'), total: amountOf(cash), count: cashRows.length, ...cap(cashRows.map(row => ({ allocation_id: row.id, source: idsOf(row.values[fields.source]), target: idsOf(row.values[fields.target]), amount: row.values[fields.amount], date: row.values[fields.date] }))) } } : {}),
    };
  }

  return { propose, settle, unsettle, position, closeReconciliation, checkReconciliation, undoReconciliation, checkBalance, postEntry, reverseEntry, totalLines, basisReport };
}

const actions = {
  propose: 'propose', apply: 'settle', remove: 'unsettle', position: 'position',
  close: 'closeReconciliation', check: 'checkReconciliation', undo: 'undoReconciliation', balance: 'checkBalance', post: 'postEntry', reverse: 'reverseEntry', totals: 'totalLines', basis: 'basisReport',
};
export const settlementActions = Object.keys(actions);

/** One POST of /lists/<list>/settlement/<action>; the list in the path is the source (or the lines) when the body leaves it out. */
export async function handleSettlementRequest(lists, listId, action, input) {
  if (!Object.hasOwn(actions, action)) return Response.json({ error: `There is no settlement action ${action}. They are: ${settlementActions.join(', ')}.` }, { status: 404 });
  const body = isObject(input) ? input : {};
  const named = {
    ...body,
    ...(isObject(body.source) ? { source: { list_id: listId, ...body.source } } : {}),
    ...(isObject(body.lines) ? { lines: { list_id: listId, ...body.lines } } : {}),
    ...(isObject(body.row) ? { row: { list_id: listId, ...body.row } } : {}),
    ...(isObject(body.targets) && action === 'basis' ? { targets: { list_id: listId, ...body.targets } } : {}),
  };
  try {
    return Response.json(await makeSettlements({ lists })[actions[action]](named));
  } catch (error) {
    if (error instanceof SettlementError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
