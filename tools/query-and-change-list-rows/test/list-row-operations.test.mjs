// Row operations over lists (src/list-row-operations.mjs, src/list-paths.mjs, src/list-input-grammar.mjs and the
// row checks in src/lists.mjs): required fields, input grammar, the basis of a value, a preview that writes nothing,
// rows put by who they are, a whole selection by its edges, a merge of two rows, who points at a row, and a saved
// view that reaches through links. Each runs against the real record store and the real rule evaluator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { handleListsRequest, makeLists, ListsError } from '../../keep-lists-of-rows/lists.mjs';
import { listTools } from '../src/list-tools.mjs';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const evaluator = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
const ruleKinds = new Map(settings.field_kinds.map(kind => [kind.id, kind.ruleKind]));
const views = { filterRows: input => evaluator.filterRowsByRules(input), ruleKindOf: kind => ruleKinds.get(kind) ?? kind,
  evaluateBinding: async (binding, input) => (await evaluator.evaluateBinding({ binding, input })).value };

const fresh = t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  let n = 0;
  const lists = makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` });
  const ask = async (path, body) => {
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}), views);
    return { status: response.status, body: await response.json() };
  };
  return { store, lists, ask };
};
const group = (...rules) => ({ kind: 'group', combinator: 'and', negate: false, rules });
const rule = (field, operator, params) => ({ kind: 'rule', field, operator, params });

test('a required field, a declared input grammar and the basis of a value are checked where the row is kept', async t => {
  const { lists } = fresh(t);
  await lists.save({ id: 'deals', label: 'Deals', fields: [
    { id: 'name', label: 'Name', required: true },
    { id: 'amount', label: 'Amount', kind: 'number', input: { decimal: ',' } },
    { id: 'guess', label: 'Guess', kind: 'number' },
    { id: 'closes', label: 'Closes', kind: 'date', input: { date_order: 'dmy' } },
  ] });
  const refusal = async body => { try { await lists.putRows('deals', body); } catch (error) { assert.ok(error instanceof ListsError); return error; } assert.fail('expected a refusal'); };
  assert.equal((await refusal({ rows: [{ id: 'a', values: { amount: 5 } }] })).detail.code, 'missing_required');
  assert.match((await refusal({ rows: [{ id: 'a', values: { name: 'A', guess: '1,25' } }] })).message, /does not say which mark is its decimal separator/);
  assert.equal((await lists.putRows('deals', { rows: [{ id: 'whole', values: { name: 'W', guess: '12' } }] })).kept[0].values.guess, 12, 'a whole number written as text is not ambiguous');
  assert.equal((await refusal({ rows: [{ id: 'a', values: { name: 'A', closes: '31/02/2026' } }] })).detail.code, 'bad_date');
  assert.equal((await refusal({ rows: [{ id: 'a', values: { name: 'A', amount: '12,5x' } }] })).detail.code, 'bad_number');
  const kept = (await lists.putRows('deals', { rows: [{ id: 'a', values: { name: 'A', amount: '1.250,5', closes: '03/04/2026' },
    basis: { amount: { confidence: 'low', reasoning: 'Read off the quote email', sources: ['quote.pdf'] } } }] }, { actor: { by: 'Claude' } })).kept[0].values;
  assert.equal(kept.amount, 1250.5);
  assert.equal(kept.closes, '2026-04-03');
  assert.deepEqual({ ...kept._basis.amount, at: undefined }, { confidence: 'low', reasoning: 'Read off the quote email', sources: ['quote.pdf'], by: 'Claude', at: undefined });
  assert.equal((await refusal({ rows: [{ id: 'a', values: { name: null } }] })).detail.code, 'required_cleared');
  assert.equal((await refusal({ rows: [{ id: 'a', values: { name: 'A' }, basis: { amount: { confidence: 'high' } } }] })).detail.code, 'unknown_field', 'a basis is for a value written in the same row');
  const rewritten = (await lists.putRows('deals', { rows: [{ id: 'a', values: { amount: '2,5' } }] })).kept[0].values;
  assert.equal(rewritten._basis, undefined, 'a value written again without a basis no longer has the old one');
  await assert.rejects(async () => await lists.save({ id: 'deals', fields: [{ id: 'x', label: 'X', input: { decimal: ',' } }] }), /declares input/, 'a text field has no number grammar');
});

test('a preview says what a write would do and writes nothing; a refusal comes back as a form to mend', async t => {
  const { lists, ask, store } = fresh(t);
  await lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name', required: true }, { id: 'tier', label: 'Tier' }] });
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, { id: 'company', label: 'Company', kind: 'link', links_to: 'companies', on_target_remove: 'detach' }] });
  await lists.putRows('companies', { rows: [{ id: 'acme', values: { name: 'Acme' } }, { id: 'zeta', values: { name: 'Zeta' } }] });
  await lists.putRows('people', { rows: [{ id: 'pat', values: { name: 'Pat', company: ['acme'] } }] });
  const before = { revision: lists.revisionOf('companies'), people: lists.revisionOf('people'), sequence: store.eeaf.changeSeq?.(), rows: (await lists.read('companies')).rows, pat: (await lists.read('people')).rows };
  const ok = (await ask('/lists/companies/rows/preview', { rows: [{ id: 'zeta', values: { tier: 'A' } }, { values: { name: 'Beta' } }], remove: ['acme'] })).body;
  assert.equal(ok.ok, true);
  assert.equal(ok.dry_run, true);
  assert.deepEqual(ok.would_keep.map(row => [row.id, row.created]), [['zeta', false], ['row-1', true]]);
  assert.deepEqual(ok.would_remove, ['acme']);
  assert.deepEqual(ok.would_also_change, [{ record: 'record:people:pat', removed: false }], 'the link detached from the removed company is part of what it would do');
  const refused = (await ask('/lists/companies/rows/preview', { rows: [{ values: { tier: 'B' } }] })).body;
  assert.equal(refused.ok, false);
  assert.equal(refused.refused.code, 'missing_required');
  assert.deepEqual(refused.refused.required_fields, [{ field_id: 'name', label: 'Name', kind: 'text' }]);
  assert.equal((await ask('/lists/companies/rows/preview', { rows: [], select: {} })).status, 400, 'a preview takes only rows and remove');
  assert.deepEqual({ revision: lists.revisionOf('companies'), people: lists.revisionOf('people'), sequence: store.eeaf.changeSeq?.(), rows: (await lists.read('companies')).rows, pat: (await lists.read('people')).rows }, before, 'nothing was written, counted or logged');
  const real = (await ask('/lists/companies/rows', { rows: [{ values: { name: 'Beta' } }] })).body;
  assert.equal(real.kept[0].values.name, 'Beta', 'the same request then keeps what the preview said');
  assert.equal((await lists.read('companies')).rows.filter(row => row.values.name === 'Beta').length, 1);
});

test('a row put by who it is joins the row already holding that email, in its shared form', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'contacts', label: 'Contacts', fields: [{ id: 'name', label: 'Name' }, { id: 'email', label: 'Email', kind: 'email' }, { id: 'phone', label: 'Phone', kind: 'phone' }, { id: 'site', label: 'Site', kind: 'link-address' }] });
  await lists.putRows('contacts', { rows: [
    { id: 'ana', values: { name: 'Ana', email: 'Ana@Example.com', phone: '+1 (415) 555-0100' } },
    { id: 'bo', values: { name: 'Bo', email: 'bo@example.com' } },
  ] });
  const first = (await ask('/lists/contacts/rows', { match_on: ['email', 'phone'], rows: [
    { values: { email: ' ana@example.COM', name: 'Ana Cruz' } },
    { values: { phone: '14155550100x', name: 'no phone match' } },
    { values: { email: 'cy@example.com', name: 'Cy' } },
    { values: { email: 'CY@example.com', site: 'https://www.Acme.com/about' } },
  ] })).body;
  assert.deepEqual(first.matches, [
    { index: 0, field_id: 'email', matched: ' ana@example.COM', form: 'ana@example.com', row_id: 'ana', created: false },
    { index: 1, field_id: 'phone', matched: '14155550100x', form: '14155550100', row_id: null, created: true },
    { index: 2, field_id: 'email', matched: 'cy@example.com', form: 'cy@example.com', row_id: null, created: true },
    { index: 3, field_id: 'email', matched: 'CY@example.com', form: 'cy@example.com', row_id: null, created: true }]);
  const all = Object.fromEntries((await lists.read('contacts')).rows.map(row => [row.id, row.values]));
  assert.equal(all.ana.email, 'Ana@Example.com', 'the spelling already kept stays');
  assert.equal(all.ana.name, 'Ana Cruz');
  const cy = Object.values(all).filter(values => values.email?.toLowerCase() === 'cy@example.com');
  assert.equal(cy.length, 1, 'the same new email named twice in one request is one row');
  assert.equal(cy[0].site, 'https://www.Acme.com/about');
  assert.equal(Object.keys(all).length, 4, 'ana, bo, the row whose phone differs by its country mark, and cy');
  await lists.putRows('contacts', { rows: [{ id: 'dup', values: { name: 'Bo again', email: 'BO@example.com' } }] });
  const ambiguous = await ask('/lists/contacts/rows', { match_on: ['email'], rows: [{ values: { email: 'bo@EXAMPLE.com' } }] });
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.refused.code, 'match_ambiguous');
  assert.equal((await ask('/lists/contacts/rows', { match_on: ['nope'], rows: [{ values: { name: 'x' } }] })).body.refused.code, 'bad_match');
  const sites = (await lists.read('contacts', { only: ['site'] })).rows.filter(row => row.values.site);
  assert.equal(sites.length, 1);
});

test('a whole selection is put or removed by its edges: a view, the rows left out, the rows added', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'tasks', label: 'Tasks', fields: [{ id: 'name', label: 'Name' }, { id: 'status', label: 'Status', kind: 'choice', choices: ['open', 'closed'] }],
    views: [{ id: 'open', label: 'Open', rules: group(rule('status', 'is_any_of', { values: ['open'] })) }] });
  const total = 1130;
  for (let at = 0; at < total; at += 200) await lists.putRows('tasks', { rows: Array.from({ length: Math.min(200, total - at) }, (_, index) => ({ id: `t${at + index}`, values: { name: `Task ${at + index}`, status: 'open' } })) });
  const select = { view_id: 'open', except: ['t5'], values: { status: 'closed' } };
  const first = (await ask('/lists/tasks/rows', { select })).body;
  assert.equal(first.selection.complete, false, 'one call changes at most select_rows_per_call rows');
  assert.ok(first.selection.matched >= settings.limits.select_rows_per_call && first.selection.matched < settings.limits.select_rows_per_call + settings.limits.read_page_rows);
  assert.equal(first.kept.length, first.selection.matched);
  const second = (await ask('/lists/tasks/rows', { select: { ...select, cursor: first.selection.next_cursor } })).body;
  assert.equal(second.selection.complete, true);
  assert.equal(first.selection.matched + second.selection.matched, total - 1, 'every open row but the one left out, once');
  const state = Object.fromEntries(((await lists.read('tasks', { only: ['status'] })).rows).map(row => [row.id, row.values.status]));
  assert.equal(Object.values(state).filter(value => value === 'open').length, 1);
  assert.equal(state.t5, 'open');
  const removed = (await ask('/lists/tasks/rows', { select: { view_id: 'open', include: ['t6', 't7'], remove: true } })).body;
  assert.deepEqual(removed.removed.sort(), ['t5', 't6', 't7'].sort(), 'the rows added by name are taken whatever the view says of them');
  assert.equal((await lists.read('tasks')).rows.length, total - 3);
  assert.equal((await ask('/lists/tasks/rows', { select: { values: { status: 'closed' }, remove: true } })).body.refused.code, 'bad_select');
  assert.equal((await ask('/lists/tasks/rows', { select: { bogus: 1, values: {} } })).body.refused.code, 'bad_select');
});

test('a selection can be the rows a snapshot held still, so rows written since neither join nor leave it', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'tasks', label: 'Tasks', fields: [{ id: 'name', label: 'Name' }, { id: 'status', label: 'Status', kind: 'choice', choices: ['open', 'closed'] }] });
  await lists.putRows('tasks', { rows: ['a', 'b', 'c'].map(id => ({ id, values: { name: id, status: 'open' } })) });
  const held = (await ask('/lists/tasks/snapshots', {})).body;
  await lists.putRows('tasks', { rows: [{ id: 'late', values: { name: 'late', status: 'open' } }] });
  await lists.putRows('tasks', { remove: ['c'] });
  const done = (await ask('/lists/tasks/rows', { select: { snapshot_id: held.snapshot_id, except: ['b'], values: { status: 'closed' } } })).body;
  assert.equal(done.selection.complete, true);
  assert.deepEqual(done.kept.map(row => row.id ?? row).sort(), ['a'].sort(), 'only a: b was left out, c was removed since, late was not held');
  const state = Object.fromEntries((await lists.read('tasks', { only: ['status'] })).rows.map(row => [row.id, row.values.status]));
  assert.deepEqual(state, { a: 'closed', b: 'open', late: 'open' });
  assert.equal((await ask('/lists/tasks/rows', { select: { snapshot_id: held.snapshot_id, view_id: 'x', values: {} } })).body.refused.code, 'bad_select');
  assert.equal((await ask('/lists/tasks/rows', { select: { snapshot_id: 'nope', values: {} } })).body.refused.code, 'no_snapshot');
});

test('two rows that are one thing merge: values fold, every link follows, the row that goes is removed last', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'companies', label: 'Companies', fields: [
    { id: 'name', label: 'Name' }, { id: 'domain', label: 'Domain', kind: 'link-address' }, { id: 'tags', label: 'Tags', kind: 'tags' },
    { id: 'stage', label: 'Stage', kind: 'choice', choices: ['lead', 'paying'], settles: ['paying'] }, { id: 'size', label: 'Size', kind: 'number' },
    { id: 'partners', label: 'Partners', kind: 'link', links_to: 'companies' }] });
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, { id: 'company', label: 'Company', kind: 'link', links_to: 'companies' }] });
  await lists.putRows('companies', { rows: [
    { id: 'acme-1', values: { name: 'Acme', domain: 'acme.com', tags: ['a', 'b'], stage: 'paying', size: 40 }, basis: { size: { confidence: 'low', reasoning: 'LinkedIn' } } },
    { id: 'acme-2', values: { name: 'ACME Inc', tags: ['b', 'c'], stage: 'lead', size: 50, partners: ['acme-1', 'zed'] } },
    { id: 'zed', values: { name: 'Zed', partners: ['acme-1'] } },
  ] });
  await lists.putRows('people', { rows: [{ id: 'p1', values: { name: 'P1', company: ['acme-1'] } }, { id: 'p2', values: { name: 'P2', company: ['acme-1', 'acme-2'] } }, { id: 'p3', values: { name: 'P3', company: ['zed'] } }] });
  const links = (await ask('/lists/companies/backlinks?row_id=acme-1')).body;
  assert.equal(links.complete, true);
  assert.deepEqual(links.backlinks.map(link => `${link.list_id}.${link.field_id}:${link.row_id}`).sort(), ['companies.partners:acme-2', 'companies.partners:zed', 'people.company:p1', 'people.company:p2']);
  assert.deepEqual(links.backlinks.find(link => link.row_id === 'p1'), { list_id: 'people', field_id: 'company', row_id: 'p1', title: 'P1' });
  const conflict = await ask('/lists/companies/merge', { base_id: 'acme-1', target_id: 'acme-2' });
  assert.equal(conflict.status, 400);
  assert.equal(conflict.body.refused.code, 'merge_conflict');
  assert.equal((await lists.read('companies', { row_ids: ['acme-1'] })).rows.length, 1, 'a refused merge removed nothing');
  const merged = (await ask('/lists/companies/merge', { base_id: 'acme-1', target_id: 'acme-2', prefer: 'base' })).body;
  assert.deepEqual(merged.removed, ['acme-1']);
  assert.deepEqual(merged.merged_from, ['acme-1']);
  assert.deepEqual(merged.relinked.map(item => `${item.list_id}.${item.field_id}:${item.rows}`).sort(), ['companies.partners:2', 'people.company:2']);
  const rows = Object.fromEntries((await lists.read('companies')).rows.map(row => [row.id, row.values]));
  assert.equal(rows['acme-1'], undefined);
  assert.equal(rows['acme-2'].domain, 'acme.com', 'a value only one row held');
  assert.equal(rows['acme-2'].stage, 'paying', 'a settled value stays settled');
  assert.equal(rows['acme-2'].size, 40, 'prefer base took the base value where both differed');
  assert.deepEqual(rows['acme-2'].tags, ['b', 'c', 'a'], 'lists unite');
  assert.deepEqual(rows['acme-2']._merged_from, ['acme-1']);
  assert.deepEqual(rows['acme-2'].partners, ['zed'], 'a link the survivor would hold to itself is dropped');
  assert.deepEqual(rows.zed.partners, ['acme-2']);
  const people = Object.fromEntries((await lists.read('people')).rows.map(row => [row.id, row.values.company]));
  assert.deepEqual(people, { p1: ['acme-2'], p2: ['acme-2'], p3: ['zed'] });
  assert.equal((await ask('/lists/companies/merge', { base_id: 'acme-1', target_id: 'acme-2' })).body.refused.code, 'merge_missing', 'asking again after it finished finds nothing to merge');
  assert.equal((await ask('/lists/companies/merge', { base_id: 'zed', target_id: 'zed' })).body.refused.code, 'merge_same');
});

test('a saved view reaches through links: filter, column and group by a field of the linked row', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }, { id: 'employees', label: 'Employees', kind: 'number' }, { id: 'industry', label: 'Industry', kind: 'tags' }, { id: 'parent', label: 'Parent', kind: 'link', links_to: 'companies', link_constraints: { max_links: 1 } }] });
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' },
    { id: 'company', label: 'Company', kind: 'link', links_to: 'companies', link_constraints: { max_links: 1 } },
    { id: 'boards', label: 'Boards', kind: 'link', links_to: 'companies' }] });
  await lists.putRows('companies', { rows: [
    { id: 'big', values: { name: 'Big', employees: 500, industry: ['bank'], parent: ['holding'] } },
    { id: 'small', values: { name: 'Small', employees: 12, industry: ['shop', 'bank'] } },
    { id: 'holding', values: { name: 'Holding', employees: 9000 } }] });
  await lists.putRows('people', { rows: [
    { id: 'ann', values: { name: 'Ann', company: ['big'], boards: ['big', 'small'] } },
    { id: 'bob', values: { name: 'Bob', company: ['small'], boards: ['small'] } },
    { id: 'cat', values: { name: 'Cat' } }] });
  const saved = await ask('/lists/people/views', { id: 'big-employers', label: 'Big employers', rules: group(rule('company.employees', 'greater_than', { value: 50 })), columns: { order: ['name', 'company.industry', 'company.parent.employees'], hidden: ['company', 'boards', 'company.employees'] }, sort: [{ field: 'company.employees', direction: 'desc' }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const through = (await ask('/lists/people/views/big-employers')).body;
  assert.deepEqual(through.rows.map(row => row.id), ['ann']);
  assert.deepEqual(through.view_fields.map(field => [field.id, field.label, field.kind]), [['name', 'Name', 'text'], ['company.industry', 'Company › Industry', 'tags'], ['company.parent.employees', 'Company › Parent › Employees', 'number']]);
  assert.deepEqual(through.rows[0].values['company.industry'], ['bank']);
  assert.equal(through.rows[0].values['company.parent.employees'], 9000);
  const many = await ask('/lists/people/views', { id: 'on-a-bank-board', label: 'On a bank board', rules: group(rule('boards.industry', 'has_any_of', { values: ['shop'] })) });
  assert.equal(many.status, 200, JSON.stringify(many.body));
  assert.deepEqual((await ask('/lists/people/views/on-a-bank-board')).body.rows.map(row => row.id).sort(), ['ann', 'bob'], 'a link that can hold several rows reaches the list of their values');
  for (const field of ['name.employees', 'company.nothing', 'nothing.employees', 'company.parent.parent.parent.parent.employees']) {
    const refused = await ask('/lists/people/views', { label: 'Bad', rules: group(rule(field, 'is_empty', {})) });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.refused.code, 'bad_path', field);
  }
});

test('a copy of rows is made field by field as the list says: links follow the copies, a finished row copies open, a basis stays behind', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }] });
  await lists.save({ id: 'plan', label: 'Plan', fields: [
    { id: 'name', label: 'Name' }, { id: 'status', label: 'Status', kind: 'choice', choices: ['Todo', 'Done'], settles: ['Done'], starts: 'Todo' },
    { id: 'parent', label: 'Parent', kind: 'link', links_to: 'plan' }, { id: 'owner', label: 'Owner', kind: 'link', links_to: 'people' },
    { id: 'secret', label: 'Secret', duplicate: 'drop' }, { id: 'size', label: 'Size', kind: 'number' }] });
  await lists.putRows('plan', { rows: [
    { id: 'a', values: { name: 'Ship', status: 'Done', secret: 'x', size: 3, owner: ['pat'] }, basis: { size: { confidence: 'low' } } },
    { id: 'b', values: { name: 'Announce', parent: ['a'], size: 1 } }] });
  const both = (await ask('/lists/plan/duplicate', { row_ids: ['a', 'b'] })).body;
  const copy = Object.fromEntries(both.copies.map(item => [item.from, item.id]));
  const rows = Object.fromEntries((await lists.read('plan')).rows.map(row => [row.id, row.values]));
  assert.equal(Object.keys(rows).length, 4);
  assert.deepEqual([rows[copy.a].name, rows[copy.a].status, rows[copy.a].secret, rows[copy.a].size], ['Ship', 'Todo', undefined, 3], 'a finished row copies open, a dropped field is left out');
  assert.deepEqual(rows[copy.a].owner, ['pat'], 'a link to another list is kept');
  assert.deepEqual(rows[copy.b].parent, [copy.a], 'a link to a row copied in the same call points at its copy');
  assert.equal(rows[copy.a]._basis, undefined);
  assert.equal(rows[copy.a]._copied_from, 'a');
  assert.equal(rows.a.status, 'Done', 'the source is untouched');
  const alone = (await ask('/lists/plan/duplicate', { row_ids: ['b'], values: { name: 'Announce again' } })).body;
  const rowsAfter = Object.fromEntries((await lists.read('plan')).rows.map(row => [row.id, row.values]));
  assert.deepEqual(rowsAfter[alone.copies[0].id].parent, ['a'], 'a link to a row not copied stays on the original');
  assert.equal(rowsAfter[alone.copies[0].id].name, 'Announce again');
  assert.equal((await ask('/lists/plan/duplicate', { row_ids: ['nope'] })).body.refused.code, 'merge_missing');
  assert.equal((await ask('/lists/plan/duplicate', { row_ids: [] })).body.refused.code, 'bad_duplicate');
  await assert.rejects(async () => await lists.save({ id: 'plan', fields: [{ id: 'x', label: 'X', duplicate: 'move' }] }), /duplicate: "move"/);
});

test('totals over a list or a saved view come from the formula engine without the rows, with groups, and say when they are partial', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'amount', label: 'Amount', kind: 'number' },
    { id: 'stage', label: 'Stage', kind: 'choice', choices: ['open', 'won', 'lost'] }, { id: 'tags', label: 'Tags', kind: 'tags' }],
    views: [{ id: 'open', label: 'Open', rules: group(rule('stage', 'is_any_of', { values: ['open'] })) }] });
  await lists.putRows('deals', { rows: [
    { id: 'a', values: { name: 'A', amount: 100, stage: 'open', tags: ['x', 'y'] } }, { id: 'b', values: { name: 'B', amount: 50.5, stage: 'open', tags: ['x'] } },
    { id: 'c', values: { name: 'C', amount: 10, stage: 'won' } }, { id: 'd', values: { name: 'D', stage: 'lost' } }] });
  const measures = [{ op: 'count' }, { op: 'filled', field: 'amount' }, { op: 'sum', field: 'amount' }, { op: 'average', field: 'amount' }, { op: 'max', field: 'amount' }, { op: 'median', field: 'amount' }, { op: 'distinct', field: 'stage' }];
  const all = (await ask('/lists/deals/aggregate', { measures })).body;
  assert.deepEqual(all.measures.map(item => [item.op, item.value]), [['count', 4], ['filled', 3], ['sum', 160.5], ['average', 53.5], ['max', 100], ['median', 50.5], ['distinct', 3]]);
  assert.deepEqual([all.rows_counted, all.complete], [4, true]);
  const open = (await ask('/lists/deals/aggregate', { view_id: 'open', measures: [{ op: 'count' }, { op: 'sum', field: 'amount' }], group_by: 'tags' })).body;
  assert.deepEqual(open.measures.map(item => item.value), [2, 150.5]);
  assert.deepEqual(open.groups.map(item => [item.key, item.rows, item.measures[1].value]).sort(), [['x', 2, 150.5], ['y', 1, 100]]);
  const byStage = (await ask('/lists/deals/aggregate', { measures: [{ op: 'sum', field: 'amount' }], group_by: 'stage' })).body;
  assert.deepEqual(byStage.groups.map(item => [item.key, item.measures[0].value]).sort(), [['lost', null], ['open', 150.5], ['won', 10]].sort());
  for (const bad of [{ measures: [{ op: 'sum', field: 'name' }] }, { measures: [{ op: 'nope' }] }, { measures: [] }, { measures: [{ op: 'count' }], view_id: 'missing-view' }, { measures: [{ op: 'count' }], group_by: 'nope' }]) {
    const refused = await ask('/lists/deals/aggregate', bad);
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  assert.equal((await ask('/lists/deals/aggregate', { measures: [{ op: 'sum', field: 'name' }] })).body.refused.code, 'bad_aggregate');
});

test('the tools ask the routes the owners answer', async () => {
  const asked = [];
  const tools = Object.fromEntries(listTools((path, body) => { asked.push([path, body]); return {}; }).map(tool => [tool.name, tool]));
  await tools.preview_list_rows.run({ list_id: 'list:deals', rows: [{ values: { name: 'A' } }] });
  await tools.merge_list_rows.run({ list_id: 'deals', base_id: 'a', target_id: 'b', prefer: 'base' });
  await tools.read_list_backlinks.run({ list_id: 'deals', row_id: 'a b' });
  await tools.read_list_aggregates.run({ list_id: 'deals', measures: [{ op: 'count' }] });
  await tools.duplicate_list_rows.run({ list_id: 'deals', row_ids: ['a'] });
  await tools.put_list_rows.run({ list_id: 'deals', match_on: ['email'], rows: [{ values: { email: 'x' } }] });
  assert.deepEqual(asked, [
    ['/lists/deals/rows/preview', { rows: [{ values: { name: 'A' } }] }],
    ['/lists/deals/merge', { base_id: 'a', target_id: 'b', prefer: 'base' }],
    ['/lists/deals/backlinks?row_id=a%20b', undefined],
    ['/lists/deals/aggregate', { measures: [{ op: 'count' }] }],
    ['/lists/deals/duplicate', { row_ids: ['a'] }],
    ['/lists/deals/rows', { match_on: ['email'], rows: [{ values: { email: 'x' } }] }],
  ]);
  assert.ok(tools.put_list_rows.inputSchema.properties.select && tools.put_list_rows.inputSchema.properties.match_on);
});

test('a write that uses most of a limit still succeeds and says what is nearly full and what to do; past it, it is refused', async t => {
  const { lists } = fresh(t);
  const fields = count => Array.from({ length: count }, (_, index) => ({ id: `f${index}`, label: `F${index}` }));
  const near = settings.limits.fields_per_list * settings.limits.warn_share;
  assert.equal((await lists.save({ id: 'wide', label: 'Wide', fields: fields(near - 1) })).warnings, undefined);
  const warned = await lists.save({ id: 'wide', fields: fields(near) });
  assert.deepEqual(warned.warnings.map(({ limit, used, of }) => [limit, used, of]), [['fields_per_list', near, settings.limits.fields_per_list]]);
  assert.match(warned.warnings[0].says, /Fields in this list: 48 of 60 used\. Remove a field nothing reads/);
  await assert.rejects(async () => await lists.save({ id: 'wide', fields: fields(settings.limits.fields_per_list + 1) }), /at most 60 fields/);
  const rows = count => Array.from({ length: count }, (_, index) => ({ id: `r${index}`, values: { f0: 'x' } }));
  assert.equal((await lists.putRows('wide', { rows: rows(10) })).warnings, undefined);
  assert.equal((await lists.putRows('wide', { rows: rows(settings.limits.rows_per_write * settings.limits.warn_share) })).warnings[0].limit, 'rows_per_write');
});
