// Mandatory public List rules compare current records to reviewed snapshots using
// the shared compiler and real formula evaluator, with no publication-time agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { compileRules, ruleVocabulary } from '../../formula-engine/rules/compile-rules.mjs';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { listCopy } from '../read-data/list-copy.mjs';

const wasm = () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const { filterRowsByRules: filterRows } = makeRowFilter({ operators, wasm });
const matches = (field, other) => ({ kind: 'rule', field, operator: 'matches_field', params: { text: other } });
const group = rules => ({ kind: 'group', combinator: 'and', negate: false, rules });

test('field comparison retains both fields and compares exact known values', async () => {
  const fields = [{ id: 'current', kind: 'text' }, { id: 'reviewed', kind: 'text' }];
  const tree = group([matches('current', 'reviewed')]);
  assert.deepEqual(compileRules(tree, { fields, vocabulary: ruleVocabulary(operators) }).reads, ['current', 'reviewed']);
  const answer = await filterRows({ tree, fields, rows: [
    { current: 'Exact Case', reviewed: 'Exact Case' },
    { current: 'exact case', reviewed: 'Exact Case' },
    { current: 'Edited', reviewed: 'Exact Case' },
    { current: 'Exact Case' }, {}, { current: null, reviewed: null },
  ] });
  assert.deepEqual(answer.matches, [0]);
  assert.deepEqual(answer.incomplete, []);
  for (const other of ['missing', 'wrong_kind']) {
    const incomplete = await filterRows({ tree: group([matches('current', other)]), fields: [...fields, { id: 'wrong_kind', kind: 'number' }], rows: [{}] });
    assert.equal(incomplete.incomplete.length, 1);
  }
});

test('mandatory snapshot equality hides an edited row and its media even after its own rule is removed', async () => {
  const identity = `1f:${'a'.repeat(64)}`;
  const another = `1f:${'b'.repeat(64)}`;
  const fields = [
    { id: 'title', label: 'Title', kind: 'text' }, { id: 'reviewed_title', label: 'Reviewed title', kind: 'text' },
    { id: 'body', label: 'Body', kind: 'file' }, { id: 'reviewed_body', label: 'Reviewed body', kind: 'text' },
    { id: 'approval', label: 'Approval', kind: 'choice', choices: ['Passed', 'Pending'] }, { id: 'shown', label: 'Shown when', kind: 'shown-when' },
  ];
  const share_when = group([
    { kind: 'rule', field: 'approval', operator: 'is_any_of', params: { values: ['Passed'] } },
    matches('title', 'reviewed_title'), matches('body', 'reviewed_body'),
  ]);
  const rows = [
    { id: 'unchanged', title: 'Approved', values: { title: 'Approved', reviewed_title: 'Approved', body: identity, reviewed_body: identity, approval: 'Passed' } },
    { id: 'edited-title', title: 'approved', values: { title: 'approved', reviewed_title: 'Approved', body: identity, reviewed_body: identity, approval: 'Passed' } },
    { id: 'edited-body', title: 'Approved', values: { title: 'Approved', reviewed_title: 'Approved', body: another, reviewed_body: identity, approval: 'Passed' } },
    { id: 'missing-review', title: 'Draft', values: { title: 'Draft', body: another, approval: 'Passed' } },
  ];
  const asked = [];
  const copy = await listCopy({ fields, rows, facts: { now: Date.parse('2026-10-13T13:00:00Z') }, share_when, filterRows,
    fileOf: value => { asked.push(value); return { identity: value, media_type: 'text/markdown' }; } });
  assert.deepEqual(copy.rows.map(row => row.id), ['unchanged']);
  assert.deepEqual(asked, [identity]);
  const invalid = await listCopy({ fields, rows, facts: { now: 0 }, share_when: group([matches('body', 'missing')]), filterRows,
    fileOf: () => { throw new Error('An unfinished approval rule must not open files'); } });
  assert.deepEqual(invalid.rows, []);
});

test('mandatory current-clock comparison reveals only unchanged approved content at and after its own date', async () => {
  const due = Date.parse('2026-10-14T13:00:00Z');
  const fields = [
    { id: 'title', label: 'Title', kind: 'text' }, { id: 'reviewed_title', label: 'Reviewed title', kind: 'text' },
    { id: 'published', label: 'Publication date', kind: 'date' },
    { id: 'state', label: 'State', kind: 'choice', choices: ['Draft', 'Scheduled', 'Published'] },
  ];
  const rows = [{ id: 'prepared', title: 'Prepared', values: { title: 'Prepared', reviewed_title: 'Prepared', published: new Date(due).toISOString(), state: 'Scheduled' } },
    { id: 'missing-date', title: 'No date', values: { title: 'No date', reviewed_title: 'No date', state: 'Scheduled' } },
    { id: 'draft', title: 'Draft', values: { title: 'Draft', reviewed_title: 'Draft', published: new Date(due).toISOString(), state: 'Draft' } }];
  const share_when = group([
    { kind: 'rule', field: 'state', operator: 'is_any_of', params: { values: ['Scheduled', 'Published'] } },
    matches('title', 'reviewed_title'),
    { kind: 'rule', field: 'now', operator: 'at_least_field', params: { text: 'published' } },
  ]);
  for (const [now, expected] of [[due - 1, []], [due, ['prepared']], [due + 1, ['prepared']]]) {
    const copy = await listCopy({ fields, rows, facts: { now }, share_when, filterRows, fileOf: () => null });
    assert.deepEqual(copy.rows.map(row => row.id), expected);
  }
  assert.equal(rows[0].values.state, 'Scheduled', 'time visibility never rewrites the stored state');
  const compared = await filterRows({ fields: [{ id: 'current', kind: 'number' }, { id: 'threshold', kind: 'number' }],
    tree: group([{ kind: 'rule', field: 'current', operator: 'at_least_field', params: { text: 'threshold' } }]), rows: [
      { current: 3, threshold: 2 }, { current: 2, threshold: 2 }, { current: 1, threshold: 2 }, { current: 3 }, {},
    ] });
  assert.deepEqual(compared.matches, [0, 1]);
});
