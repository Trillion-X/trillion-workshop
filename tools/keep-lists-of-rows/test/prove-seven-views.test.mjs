// tools/keep-lists-of-rows/test/prove-seven-views.test.mjs
// The seven-view proof's step list against a fake page and an in-memory records door, no network: every step acts,
// is read back from the page and the records, and prints one line; the first readback that fails stops the run with 1;
// the proof refuses to start without an origin given to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, steps, runSteps, main } from '../prove-seven-views.mjs';

function fakeComputer({ dropField = null } = {}) {
  const store = new Map();
  const records = {
    write: async written => { for (const record of written) {
      const value = record.value && dropField && record.type === 'list' ? { ...record.value, fields: record.value.fields.filter(field => field.id !== dropField) } : record.value;
      if (value === null) store.delete(record.id); else store.set(record.id, { type: record.type, value: structuredClone(value) });
    } return { changed: true }; },
    read: async (id, type) => (store.get(id)?.type === type ? structuredClone(store.get(id).value) : null),
    list: async ({ type, prefix }) => [...store].filter(([id, record]) => record.type === type && id.startsWith(prefix)).map(([id, record]) => ({ id, value: structuredClone(record.value) })),
  };
  // The page draws what the records hold: every list's label, field labels and row names, the saved view's label, rows in
  // their order; a view's marker is shown when the address opens that view.
  let address = null;
  const words = () => [...store.values()].flatMap(({ type, value }) => type === 'list' ? [value.label, ...value.fields.map(field => field.label)] : type === 'list-view' ? [value.view.label] : [value.name]);
  const rows = () => [...store.values()].filter(({ type }) => type.startsWith('record:')).map(({ value }) => value).sort((a, b) => (a.order < b.order ? -1 : 1));
  const shots = [];
  const page = {
    goto: async url => { address = new URL(url); },
    getByText: (text, { exact = false } = {}) => ({ first: () => ({
      isVisible: async () => words().some(word => exact ? word === text : String(word).includes(text)),
      boundingBox: async () => { const at = rows().findIndex(row => row.name === text); return at < 0 ? null : { x: 0, y: 40 * at, width: 100, height: 30 }; },
    }) }),
    locator: selector => ({ first: () => ({ waitFor: async () => {
      const view = data.views.find(row => row.as === address?.searchParams.get(data.list_screen.view_query));
      if (view?.shows !== selector) throw new Error('not shown');
    } }) }),
    screenshot: async ({ path }) => { shots.push(path); },
  };
  return { ctx: { page, base: 'https://computer.test/a/addr', records, stamp: 't' }, store, shots };
}

test('the steps are the five list steps and the seven views, in order', () => {
  assert.deepEqual(steps.map(step => step.name), ['create a list', 'add a field', 'edit a cell', 'reorder rows', 'save a view',
    'switch to grid', 'switch to board', 'switch to timeline', 'switch to schedule', 'switch to form', 'switch to node graph', 'switch to metric']);
});

test('against a page and records that keep what each step did, every step passes with one line and one screenshot', async () => {
  const { ctx, store, shots } = fakeComputer();
  const lines = [];
  assert.equal(await runSteps(ctx, { shots: '/shots', print: line => lines.push(line) }), 0);
  assert.equal(lines.length, 12);
  assert.ok(lines.every(line => line.startsWith('pass ')), lines.join('\n'));
  assert.match(lines[3], /^pass 04 reorder rows: .*"rows":\["Gamma","Alpha edited","Beta"\]/);
  assert.equal(shots.length, 12);
  assert.equal(shots[11], '/shots/12-switch-to-metric.png');
  assert.equal(store.get('list-view:list-prooft:proof').value.view.display.as, 'summary');
  assert.ok([...store.keys()].every(id => id.includes('list-proof')), 'nothing but the proof list is written');
});

test('the first readback that fails stops the run: a field the records did not keep fails "add a field"', async () => {
  const { ctx, shots } = fakeComputer({ dropField: 'due' });
  const lines = [];
  assert.equal(await runSteps(ctx, { shots: '/shots', print: line => lines.push(line) }), 1);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^fail 02 add a field: page=\{"due":false\} records=\{"fields":\["name"\]\}$/);
  assert.equal(shots.length, 2);
});

test('a step that throws fails with its first line, never an address', async () => {
  const { ctx } = fakeComputer();
  ctx.records.write = async () => { throw new Error('refused at https://computer.test/a/addr/work/api/records\nmore'); };
  const lines = [];
  assert.equal(await runSteps(ctx, { print: line => lines.push(line) }), 1);
  assert.equal(lines[0], 'fail 01 create a list: page=null records=null error="refused at [URL]"');
});

test('no origin, no run: the proof names none of its own', async () => {
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = text => { written.push(String(text)); return true; };
  try { assert.equal(await main(['--shots', '/tmp/x'], {}), 2); }
  finally { process.stderr.write = write; }
  assert.match(written.join(''), /--origin/);
});
