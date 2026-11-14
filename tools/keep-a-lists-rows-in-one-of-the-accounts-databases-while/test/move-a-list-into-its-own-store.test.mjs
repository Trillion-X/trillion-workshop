// A list moves into its own store page by page, is verified row for row, and leaves the primary only after that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveList, canonical } from '../do-work/move-a-list-into-its-own-store.mjs';

// A records door over two stores, the primary and one scope, paged by id descending like the engine. Like the engine's
// records routes (`homes`), a call that names no scope and a kind with a `home:` row in the primary is answered in that
// home, and `scope: null` names the primary itself; `routes: false` is an engine without homes.
function door({ rows, failAfterWrites = Infinity, changeDuringCopy = null, routes = true }) {
  const stores = { primary: new Map(rows.map(row => [row.id, row])), scope: new Map() };
  let writes = 0;
  const kindOf = input => input.type ?? input.records?.[0]?.type;
  const op = async (address, method, input) => {
    const homed = routes && !('scope' in input) && stores.primary.get(`home:${kindOf(input)}`)?.value;
    const store = input.scope || homed ? stores.scope : stores.primary;
    if (method === 'records:read') return store.get(input.id) ?? { id: input.id, value: null };
    if (method === 'records:list') {
      // `above` and `below` bound the ids strictly; `fields: []` answers ids and types alone.
      const ids = [...store.values()].filter(row => row.type === input.type).map(row => row.id).sort().reverse()
        .filter(id => (!input.after || id < input.after) && (!input.above || id > input.above) && (!input.below || id < input.below));
      const shown = ids.slice(0, input.limit);
      const answered = id => (Array.isArray(input.fields) && !input.fields.length ? { ...store.get(id), value: {} } : store.get(id));
      return { context: { generation: 1 }, ...(input.scope || homed ? { scope: input.scope ?? homed.scope } : {}),
        records: shown.map(answered), next: ids.length > input.limit ? shown.at(-1) : null };
    }
    if (method === 'records:write') {
      if (++writes > failAfterWrites) throw new Error('the door went away');
      for (const row of input.records) {
        if (row.value === null) store.delete(row.id); else store.set(row.id, { ...row });
      }
      if (changeDuringCopy && input.scope && input.records.some(row => row.type === 'record:library')) { stores.primary.set(changeDuringCopy.id, changeDuringCopy.row); changeDuringCopy = null; }
      return { ok: true };
    }
    throw new Error(method);
  };
  return { op, stores };
}

const scope = { id: 'list-library', incarnation: 'first', generation: 1 };
const rowsOf = count => Array.from({ length: count }, (_, at) => ({ id: `x:${String(at).padStart(4, '0')}`, type: 'record:library', value: { text: `line ${at}`, at } }));
const definition = { id: 'list:library', type: 'list', value: { row_type: 'library', fields: [] } };
const libraryRows = store => [...store.values()].filter(row => row.type === 'record:library');

test('every row lands in its own store equal, and the primary keeps them until remove', async () => {
  const { op, stores } = door({ rows: [definition, ...rowsOf(23)] });
  const progress = await moveList(op, { rowType: 'library', scope, pageSize: 5 });
  assert.equal(progress.state, 'verified');
  assert.equal(progress.verified, 23);
  assert.equal(libraryRows(stores.scope).length, 23);
  assert.ok(stores.scope.has('list:library'), 'the list definition is in its own store first');
  assert.equal(libraryRows(stores.primary).length, 23, 'copy changes nothing in the primary');
  const removed = await moveList(op, { rowType: 'library', scope, pageSize: 5, step: 'remove' });
  assert.equal(removed.state, 'moved');
  assert.equal(removed.removed, 23);
  assert.equal(libraryRows(stores.primary).length, 0);
  assert.equal(canonical(stores.scope.get('x:0007').value), canonical({ at: 7, text: 'line 7' }));
});

test('an interrupted copy resumes where its progress row says', async () => {
  const first = door({ rows: [definition, ...rowsOf(12)], failAfterWrites: 7 });
  await assert.rejects(moveList(first.op, { rowType: 'library', scope, pageSize: 3, parts: 3, writeBytes: 1 }));
  const parts = [...first.stores.primary.values()].filter(row => row.type === 'list-move' && row.id.startsWith('list-move:library:part-'));
  assert.equal(first.stores.primary.get('list-move:library').value.state, 'copying');
  assert.ok(parts.some(part => part.value.copied > 0) && parts.reduce((sum, part) => sum + part.value.copied, 0) < 12, 'some ranges saved where they reached');
  const again = door({ rows: [...first.stores.primary.values()] });
  for (const [id, row] of first.stores.scope) again.stores.scope.set(id, row);
  const progress = await moveList(again.op, { rowType: 'library', scope, pageSize: 3 });
  assert.equal(progress.state, 'verified');
  assert.equal(progress.verified, 12);
  assert.equal(libraryRows(again.stores.scope).length, 12);
});

test('a row changed in the primary after its page was copied is copied again before verify passes', async () => {
  const changed = { id: 'x:0009', type: 'record:library', value: { text: 'edited', at: 9 } };
  const { op, stores } = door({ rows: [definition, ...rowsOf(10)], changeDuringCopy: { id: 'x:0009', row: changed } });
  const progress = await moveList(op, { rowType: 'library', scope, pageSize: 4 });
  assert.equal(progress.state, 'verified');
  assert.equal(stores.scope.get('x:0009').value.text, 'edited');
});

test('remove sets the home first, and an engine that does not answer from it removes nothing', async () => {
  const routed = door({ rows: [definition, ...rowsOf(6)] });
  await moveList(routed.op, { rowType: 'library', scope, pageSize: 4 });
  await moveList(routed.op, { rowType: 'library', scope, pageSize: 4, step: 'remove' });
  assert.equal(routed.stores.primary.get('home:record:library').value.scope.id, 'list-library');
  const answer = await routed.op('@own-records', 'records:list', { type: 'record:library', limit: 10 });
  assert.equal(answer.records.length, 6, 'a call naming no scope is answered by the home');

  const old = door({ rows: [definition, ...rowsOf(6)], routes: false });
  await moveList(old.op, { rowType: 'library', scope, pageSize: 4 });
  await assert.rejects(moveList(old.op, { rowType: 'library', scope, pageSize: 4, step: 'remove' }), /nothing was removed/);
  assert.equal(libraryRows(old.stores.primary).length, 6);
  assert.equal(old.stores.primary.has('home:record:library'), false, 'the home row is taken back out');
});

test('remove is refused before verify', async () => {
  const { op } = door({ rows: [definition, ...rowsOf(3)] });
  await assert.rejects(moveList(op, { rowType: 'library', scope, step: 'remove' }), /remove needs a verified move/);
});
