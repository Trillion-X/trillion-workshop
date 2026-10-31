// tools/formulas: every row's sample run exactly as the container runs it (node do-work/run-request.mjs <function>, the request on
// standard input), and the refusals a person's AI gets for a request the tool cannot run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const folder = new URL('..', import.meta.url).pathname;
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const run = (argv, input) => new Promise(resolve => {
  const child = promisify(execFile)(argv[0], argv.slice(1), { cwd: folder });
  child.child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  child.then(({ stdout }) => resolve({ code: 0, last: JSON.parse(stdout.trim().split('\n').pop()) }), error => resolve({ code: error.code, last: JSON.parse(error.stdout.trim().split('\n').pop()) }));
});
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((at, key) => at?.[key], value);
const argvOf = fn => ['node', 'do-work/run-request.mjs', fn];

test('the four rows run their own sample and the output holds the words the row says it will', async () => {
  assert.equal(rows.length, 4);
  for (const row of rows) {
    for (const check of row.verify) {
      const { code, last } = await run(row.invoke.argv, check.input);
      assert.equal(code, 0, `${row.id}: ${JSON.stringify(last)}`);
      assert.ok(String(select(select(last, row.result_selector), check.output_selector)).includes(check.contains), row.id);
    }
  }
});

test('every row names its folder, is offline, and keeps its own words generic', () => {
  for (const row of rows) {
    assert.deepEqual([row.invoke.files.package_files.package, row.invoke.internet, row.maker], ['formulas', false, 'maker:formulas']);
    assert.ok(Array.isArray(row.input_schema.required ?? []) && row.job.length > 20, row.id);
  }
});

test('a request that is not JSON, an unknown function and a request missing its parts are refused with a sentence', async () => {
  assert.match((await run(argvOf('filterRecords'), 'not json')).last.error, /JSON/);
  assert.match((await run(argvOf('nothingLikeThis'), {})).last.error, /Unknown request/);
  assert.match((await run(argvOf('filterRecords'), { fields: [] })).last.error, /records must be a list/);
  assert.match((await run(argvOf('filterRecords'), { records: [], fields: [{ id: 'a' }] })).last.error, /fields must be a list/);
  assert.match((await run(argvOf('filterRecords'), { records: [], fields: [{ id: 'a', kind: 'text' }, { id: 'a', kind: 'text' }] })).last.error, /share an id/);
  assert.match((await run(argvOf('filterRecords'), { records: [], fields: [], operators: { operators: [], combinators: [{ id: 'and', op: 'op:core.add' }] } })).last.error, /combinator needs/);
  assert.match((await run(argvOf('evaluateFormula'), { rows: [] })).last.error, /binding must be an object/);
  assert.match((await run(argvOf('evaluateFormula'), { binding: { $kind: 'binding' } })).last.error, /rows must be a list/);
  assert.match((await run(argvOf('listComparisons'), { field_kind: 3 })).last.error, /field_kind must be text/);
});

test('the person\'s own comparison rows replace the built-in ones', async () => {
  const operators = {
    combinators: [{ id: 'all', label: 'All', sentence: 'and', op: 'op:core.and' }],
    operators: [{ id: 'is_big', label: 'is big', input: 'none', applies_to: ['weight'], binding: { $kind: 'binding', select: { from: 'self', path: { $field: 'path' } }, transform: [{ op: 'op:core.gt', args: { value: 100 } }] } }],
  };
  const answer = await run(argvOf('filterRecords'), {
    records: [{ g: 50 }, { g: 500 }], fields: [{ id: 'g', kind: 'weight' }], operators,
    tree: { kind: 'group', combinator: 'all', negate: false, rules: [{ kind: 'rule', field: 'g', operator: 'is_big' }] },
  });
  assert.deepEqual(answer.last.result.matches, [1]);
  assert.deepEqual((await run(argvOf('listComparisons'), { operators })).last.result.comparisons.map(row => row.id), ['is_big']);
});

test('a row of the wrong kind is counted, not kept, and the rest are answered', async () => {
  const { last } = await run(argvOf('filterRecords'), {
    records: [{ n: 'x' }, { n: 5 }], fields: [{ id: 'n', kind: 'number' }],
    tree: { kind: 'rule', field: 'n', operator: 'greater_than', params: { value: 1 } },
  });
  assert.deepEqual([last.result.matches, last.result.error_rows], [[1], 1]);
});

test('evaluate a formula over rows: one value per row, errors named by row', async () => {
  const { last } = await run(argvOf('evaluateFormula'), {
    binding: { $kind: 'binding', select: { from: 'self', path: ['n'] }, transform: [{ op: 'op:core.gt', args: { value: 1 } }] },
    rows: [{ n: 5 }, { n: 0 }, { n: null }, { n: 'x' }],
  });
  assert.deepEqual(last.result.values, [true, false, null, null]);
  assert.deepEqual(last.result.errors.map(item => item.row), [3]);
});

test('list-comparisons narrows to one field kind', async () => {
  const { last } = await run(argvOf('listComparisons'), { field_kind: 'date' });
  assert.deepEqual(last.result.comparisons.map(row => row.id), ['on_day', 'between', 'after', 'before', 'is_known', 'is_unknown']);
  assert.ok(last.result.field_kinds.includes('tags'));
});

test('a group whose combinator is not in the vocabulary is refused in words, never joined by a guess', async () => {
  for (const combinator of ['xor', undefined]) {
    const { code, last } = await run(argvOf('filterRecords'), { records: [{ n: 1 }], fields: [{ id: 'n', kind: 'number' }], tree: { kind: 'group', combinator, negate: false, rules: [{ kind: 'rule', field: 'n', operator: 'greater_than', params: { value: 0 } }] } });
    assert.equal(code, 1);
    assert.match(last.error, /combinator .* is not one of and, or/);
  }
});

test('classify a record: the first rule that holds answers, and an unfinished request is refused in words', async () => {
  const request = { facts: [{ key: 'done', path: ['done_at'], as: 'present' }], rules: [{ key: 'open', label: 'Open', requires: [{ fact: 'done', op: 'absent' }] }], record: { name: 'loaf' } };
  assert.deepEqual((await run(argvOf('classifyRecord'), request)).last.result, { result: { key: 'open', label: 'Open', tone: null, severity: null } });
  assert.match((await run(argvOf('classifyRecord'), { ...request, rules: [{ key: 'x', label: 'X', requires: [{ fact: 'nope', op: 'present' }] }] })).last.error, /does not declare/);
});
