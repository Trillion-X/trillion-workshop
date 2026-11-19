// The row-changes leaf over a stand-in client: each change told once in (txid, position) order, a refused tell told
// again, the kept place resumed after a restart, a NOTIFY waking it before look_again. Made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { carried, clientOptions, describeMechanism, readSettings, readSql, watchForTransitions } from '../do-work/mechanisms/row-changes.mjs';

const change = (txid, position, op = 'INSERT', by = null) => ({ database: 'p_made_up', txid: String(txid), position: String(position), at: '2026-11-18T14:00:00Z', table_name: 'notes', op, before: null, after: { id: position }, by });
// A stand-in client: answers each read with the committed changes after the place asked, and can announce on a channel.
function client(changes) {
  const asked = [];
  const listeners = [];
  return {
    asked, changes,
    on: (kind, listener) => listeners.push(listener),
    notify: channel => listeners.forEach(listener => listener({ channel })),
    query: async (sql, params = []) => {
      asked.push(sql.startsWith('LISTEN') ? sql : params);
      if (sql.startsWith('LISTEN')) return { rows: [] };
      const [txid, position, limit] = params;
      const after = row => txid === null || BigInt(row.txid) > BigInt(txid) || (row.txid === txid && BigInt(row.position) > BigInt(position));
      return { rows: changes.filter(after).sort((a, b) => Number(BigInt(a.txid) - BigInt(b.txid)) || Number(a.position) - Number(b.position)).slice(0, limit) };
    },
    end: async () => {},
  };
}
const run = async (stand, { state = null, tell = async () => true, stopAfter = 1, settings = {} } = {}) => {
  const control = new AbortController();
  const told = [];
  let kept = null;
  const done = watchForTransitions({ look_again_seconds: 3600, ...settings }, {
    connection: 'postgresql://made-up', connect: async () => stand, signal: control.signal, state,
    keepState: async value => { kept = value; },
    onTransition: async transition => { const ok = await tell(transition); if (ok !== false) told.push(transition); if (told.length >= stopAfter) control.abort(); return ok; },
  });
  return { done, control, told, kept: () => kept };
};

test('it declares its fields and reads its settings, refusing a table name that is not a plain name', () => {
  assert.deepEqual(describeMechanism().conditions, ['became-reachable']);
  assert.deepEqual(readSettings({}), { connection_fd: 4, table: 'row_changes', channel: 'row_changes', look_again_ms: 30000, most_per_read: 500 });
  assert.equal(readSettings({ table: 'x; DROP TABLE y' }).table, 'row_changes');
  assert.match(readSql('row_changes'), /txid < pg_snapshot_xmin\(pg_current_snapshot\(\)\)/);
  assert.match(readSql('row_changes'), /ORDER BY txid, position/);
  assert.match(readSql('row_changes'), /to_jsonb\(c\) ->> 'changed_by' AS by/, 'a change table with no changed_by is read the same: by is null');
});

test('who made a change is told as by, and a change table that keeps no one tells null', async () => {
  const stand = client([change(9, 1, 'INSERT', 'may_change_rows_0a1b2c3d4e5f'), change(9, 2, 'UPDATE')]);
  const { done, told } = await run(stand, { stopAfter: 2 });
  await done;
  assert.deepEqual(told.map(item => item.detail.by), ['may_change_rows_0a1b2c3d4e5f', null]);
});

test('a change is told as where, place and change: INSERT is added, UPDATE changed, DELETE removed', async () => {
  const stand = client([change(9, 3, 'INSERT'), change(10, 1, 'UPDATE'), change(10, 2, 'DELETE')]);
  const { done, told } = await run(stand, { stopAfter: 3 });
  await done;
  assert.deepEqual(told.map(item => [item.detail.where, item.detail.place, item.detail.change]),
    [['p_made_up', 'notes', 'added'], ['p_made_up', 'notes', 'changed'], ['p_made_up', 'notes', 'removed']]);
  assert.deepEqual(told[0].observed_identity, { where: 'p_made_up', place: 'notes' });
});

test('each committed change is told once, in transaction order, under its own key', async () => {
  const stand = client([change(10, 2), change(9, 3), change(10, 1)]);
  const { done, told } = await run(stand, { stopAfter: 3 });
  await done;
  assert.deepEqual(told.map(item => item.event_key), ['p_made_up:9:3', 'p_made_up:10:1', 'p_made_up:10:2']);
  assert.equal(told[0].detail.after, '{"id":3}');
  assert.equal(told[0].detail.key, 'p_made_up:9:3');
  assert.equal(stand.asked[0], 'LISTEN row_changes');
});

test('a refused tell is told again, and nothing after it is told first', async () => {
  const stand = client([change(1, 1), change(2, 2)]);
  let refusals = 1;
  const { done, told, control } = await run(stand, { stopAfter: 2, settings: { look_again_seconds: 1 }, tell: async item => (item.event_key.endsWith(':1:1') && refusals-- > 0 ? false : true) });
  setTimeout(() => control.abort(), 3000);
  await done;
  assert.deepEqual(told.map(item => item.event_key), ['p_made_up:1:1', 'p_made_up:2:2']);
});

test('a restart resumes after the kept place and tells nothing twice', async () => {
  const stand = client([change(1, 1), change(2, 2), change(3, 3)]);
  const first = await run(stand, { stopAfter: 2 });
  await first.done;
  assert.deepEqual(first.kept(), { after: { txid: '2', position: '2' } });
  const again = await run(stand, { state: first.kept(), stopAfter: 1 });
  await again.done;
  assert.deepEqual(again.told.map(item => item.event_key), ['p_made_up:3:3']);
});

test('a NOTIFY on its channel reads at once instead of waiting', async () => {
  const stand = client([]);
  const { done, told } = await run(stand, { stopAfter: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  stand.changes.push(change(5, 5));
  stand.notify('other_channel');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(told.length, 0, 'another channel does not wake it');
  stand.notify('row_changes');
  await done;
  assert.deepEqual(told.map(item => item.event_key), ['p_made_up:5:5']);
});

test("a sandboxed run reaches the database only through the run's proxy: each connection is one CONNECT to the database's host and port", async () => {
  const { createServer } = await import("node:net");
  const asked = [];
  const proxy = createServer((socket) => socket.once("data", (chunk) => { asked.push(chunk.toString("latin1").split("\r\n")[0]); socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); }));
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    assert.deepEqual(await clientOptions("postgres://db.example.test:5432/rows", undefined), { connectionString: "postgres://db.example.test:5432/rows" });
    const options = await clientOptions("postgres://db.example.test:5432/rows", `http://127.0.0.1:${proxy.address().port}`);
    const tunnel = options.stream().connect(5432, "db.example.test");
    const refused = await new Promise((resolve) => tunnel.once("error", resolve));
    assert.match(refused.message, /the run's proxy did not open db\.example\.test:5432 \(answered 403\)/);
    assert.deepEqual(asked, ["CONNECT db.example.test:5432 HTTP/1.1"]);
  } finally {
    proxy.close();
  }
});

test('a change too big for a fact field goes without that side; the rest of the change is still told', () => {
  assert.equal(carried({ wide: 'x'.repeat(2000) }), null);
  assert.equal(carried(null), null);
  assert.equal(carried({ id: 1 }), '{"id":1}');
});
