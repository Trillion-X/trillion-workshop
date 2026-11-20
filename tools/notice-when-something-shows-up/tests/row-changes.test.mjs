// The row-changes leaf over a stand-in client: each change told once in (txid, position) order, a refused tell told
// again, the kept place resumed after a restart, a NOTIFY waking it before look_again. Made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { carried, clientOptions, describeMechanism, heldBackSql, heldBackWords, readSettings, readSql, watchForTransitions } from '../do-work/mechanisms/row-changes.mjs';
import { factOf } from '../do-work/tell-the-engine.mjs';
import { THIS_TOOL, troublePayload } from '../do-work/emit-arrival-fact.mjs';

const change = (txid, position, op = 'INSERT', by = null) => ({ database: 'p_made_up', txid: String(txid), position: String(position), at: '2026-11-18T14:00:00Z', table_name: 'notes', op, before: null, after: { id: position }, by });
// A stand-in client: answers each read with the committed changes after the place asked, and can announce on a channel.
function client(changes) {
  const asked = [];
  const listeners = [];
  const stand = {
    asked, changes,
    on: (kind, listener) => listeners.push(listener),
    notify: channel => listeners.forEach(listener => listener({ channel })),
    // What the look for held-back changes answers, look by look (the last one again once they run out).
    held: [{ xmin: '1', waiting: 0, database: 'p_made_up', holder: null }],
    query: async (sql, params = []) => {
      if (sql.includes('AS waiting')) {
        const held = asked.held = (asked.held ?? 0) + 1;
        const next = stand.held[Math.min(held, stand.held.length) - 1];
        if (next instanceof Error) throw next;
        return { rows: [next] };
      }
      if (sql.includes('ORDER BY txid DESC')) {
        // The newest committed change: where a reader with no kept place starts.
        const newest = [...changes].sort((a, b) => Number(BigInt(b.txid) - BigInt(a.txid)) || Number(b.position) - Number(a.position))[0];
        asked.push('NOW');
        return { rows: newest ? [{ txid: newest.txid, position: newest.position }] : [] };
      }
      asked.push(sql.startsWith('LISTEN') ? sql : params);
      if (sql.startsWith('LISTEN')) return { rows: [] };
      const [txid, position, limit] = params;
      const after = row => txid === null || BigInt(row.txid) > BigInt(txid) || (row.txid === txid && BigInt(row.position) > BigInt(position));
      return { rows: changes.filter(after).sort((a, b) => Number(BigInt(a.txid) - BigInt(b.txid)) || Number(a.position) - Number(b.position)).slice(0, limit) };
    },
    end: async () => {},
  };
  return stand;
}
const run = async (stand, { state = null, tell = async () => true, stopAfter = 1, settings = {}, troubles = null, now = undefined } = {}) => {
  const control = new AbortController();
  const told = [];
  let kept = null;
  const done = watchForTransitions({ look_again_seconds: 3600, from_the_start: true, ...settings }, {
    connection: 'postgresql://made-up', connect: async () => stand, signal: control.signal, state, now,
    onTrouble: troubles ? async trouble => { troubles.push(trouble); return true; } : undefined,
    keepState: async value => { kept = value; },
    onTransition: async transition => { const ok = await tell(transition); if (ok !== false) told.push(transition); if (told.length >= stopAfter) control.abort(); return ok; },
  });
  return { done, control, told, kept: () => kept };
};

test('it declares its fields and reads its settings, refusing a table name that is not a plain name', () => {
  assert.deepEqual(describeMechanism().conditions, ['became-reachable']);
  assert.deepEqual(readSettings({}), { connection_fd: 4, table: 'row_changes', channel: 'row_changes', look_again_ms: 30000, most_per_read: 500, held_back_ms: 120000, from_the_start: false });
  assert.equal(readSettings({ from_the_start: 'yes' }).from_the_start, false, 'only true replays the table');
  assert.equal(readSettings({ held_back_seconds: 5 }).held_back_ms, 5000);
  assert.equal(readSettings({ table: 'x; DROP TABLE y' }).table, 'row_changes');
  assert.match(readSql('row_changes'), /WHERE txid < coalesce\(\(SELECT min\(x\) FROM pg_snapshot_xip\(pg_current_snapshot\(\)\) x/, 'the horizon is this database\'s own');
  assert.match(readSql('row_changes'), /a\.datname <> current_database\(\)\)\),\s+pg_snapshot_xmax\(pg_current_snapshot\(\)\)\)/, 'only a transaction placed in another database is left out');
  assert.doesNotMatch(readSql('row_changes'), /pg_snapshot_xmin/, 'never the server\'s horizon');
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

// Changes held back: committed changes wait behind a transaction still running on the server (Nov 20 2026, 7:29:55 to 7:41
// AM CST, one idle session on another database held every row change on the Mac back for 11 minutes, and nothing said so).
const holding = (xmin, waiting, holder = { pid: 415254, database: 'p_other', state: 'idle in transaction', since: '2026-11-20T13:29:55Z' }) =>
  ({ xmin: String(xmin), waiting, database: 'p_made_up', holder });
/** Run the leaf over `held` looks, one a second of made-up time (look_again 1 s, held_back 3 s), and answer its troubles. */
async function looks(held, { looks: count = held.length, settings = {} } = {}) {
  const stand = client([]);
  stand.held = held;
  let at = Date.parse('2026-11-20T13:30:00Z');
  const troubles = [];
  const control = new AbortController();
  const done = watchForTransitions({ look_again_seconds: 1, held_back_seconds: 3, from_the_start: true, ...settings }, {
    connection: 'postgresql://made-up', connect: async () => stand, signal: control.signal,
    now: () => at, onTrouble: async trouble => { troubles.push(trouble); return true; }, onTransition: async () => true,
  });
  for (let look = 0; look < count; look += 1) {
    while ((stand.asked.held ?? 0) <= look) await new Promise(resolve => setTimeout(resolve, 5));
    at += 1000;
    stand.notify('row_changes');
  }
  control.abort();
  await done;
  return troubles;
}

test('changes held back past held_back_seconds are told once, naming the session that holds them', async () => {
  const troubles = await looks([holding(7, 2), holding(7, 2), holding(7, 3), holding(7, 3), holding(7, 3), holding(7, 4), holding(7, 4)]);
  assert.equal(troubles.length, 1, 'told once while the same transaction holds them');
  assert.equal(troubles[0].event_key, 'p_made_up:held-back:7');
  assert.equal(troubles[0].cause, 'row-changes-held-back');
  assert.match(troubles[0].said, /^3 committed changes have waited in p_made_up for 1 min/);
  assert.match(troubles[0].said, /session 415254 on p_other \(idle in transaction since 2026-11-20T13:29:55.000Z\)/);
});

test('a quiet database, a hold shorter than held_back_seconds, and a horizon that moves on tell nothing', async () => {
  assert.deepEqual(await looks([holding(7, 0), holding(7, 0), holding(7, 0), holding(7, 0), holding(7, 0)]), [], 'nothing waits: an unmoving horizon is a quiet database');
  assert.deepEqual(await looks([holding(7, 1), holding(7, 1), holding(8, 0), holding(8, 0), holding(8, 0)]), [], 'ended within its time');
  assert.deepEqual(await looks([holding(7, 1), holding(8, 1), holding(9, 1), holding(10, 1), holding(11, 1)]), [], 'each look waits behind a newer transaction: changes keep flowing');
});

test('a second hold after the first ended is told again, and a look that fails changes nothing', async () => {
  const troubles = await looks([holding(7, 1), new Error('permission denied for pg_stat_activity'), holding(7, 1), holding(7, 1), holding(7, 1),
    holding(9, 0), holding(12, 1), holding(12, 1), holding(12, 1), holding(12, 1)]);
  assert.deepEqual(troubles.map(trouble => trouble.event_key), ['p_made_up:held-back:7', 'p_made_up:held-back:12']);
});

test('a holder this login may not see is said so, and the read names its own horizon and server-wide sessions', () => {
  assert.match(heldBackWords(holding(7, 1, null), 125000), /^1 committed change has waited in p_made_up for 2 min behind a transaction still running: a session this login may not see\./);
  assert.match(heldBackWords(holding(7, 2, { pid: 9 }), 60000), /session 9 on a database this login may not name\./);
  assert.match(heldBackSql('row_changes'), /FROM row_changes WHERE txid >= \(SELECT horizon FROM h\)/);
  assert.match(heldBackSql('row_changes'), /l\.transactionid::text::bigint = \(\(SELECT horizon FROM h\)::text::bigint % 4294967296\)/, 'the holder is the session whose transaction is the horizon');
});

test("a waiter's trouble is told as the fact a stopped wake is named by: tool, wake, cause and said, within a fact's fields", () => {
  const payload = troublePayload({ waiter_ref: 'waiter:row-changes' }, { cause: 'row-changes-held-back', said: 'x'.repeat(5000) },
    { observedAt: '2026-11-20T13:32:00.000Z', sequence: 4 });
  const fact = factOf({ addressLabel: 'where::something-changed::trouble', payload }, 'where::something-changed::trouble@p_made_up:held-back:7');
  assert.equal(fact.kind, 'something-showed-up');
  assert.deepEqual(Object.keys(fact.payload), ['waiter_ref', 'condition', 'observed_at', 'sequence', 'tool', 'wake', 'cause', 'said']);
  assert.equal(fact.payload.condition, 'became-unreachable');
  assert.equal(fact.payload.tool, THIS_TOOL);
  assert.equal(fact.payload.wake, 'waiter:row-changes');
  assert.equal(Buffer.byteLength(fact.payload.said), 1000, 'cut to a fact field');
  assert.equal(troublePayload({ waiter_ref: 'w' }, { said: 'é'.repeat(600) }, { observedAt: 'x', sequence: 0 }).observed_identity.said.length, 500, 'cut at a character');
});

// A reader with no kept place starts from now (Nov 20 2026, 2:15 PM CST: a first switch on the always-on computer told all 189
// old changes of the person's own database, and 122 owed causes were let go, the one it was switched on for among them).
test('a reader with no kept place starts from now, keeps that place at once, and tells only what comes after', async () => {
  const stand = client([change(1, 1), change(2, 2), change(3, 3)]);
  const kept = [];
  const told = [];
  const control = new AbortController();
  const done = watchForTransitions({ look_again_seconds: 3600 }, {
    connection: 'postgresql://made-up', connect: async () => stand, signal: control.signal,
    keepState: async value => { kept.push(value); },
    onTransition: async transition => { told.push(transition.event_key); control.abort(); return true; },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(told, [], 'nothing already in the table is told');
  assert.deepEqual(kept[0], { after: { txid: '3', position: '3' } }, 'the starting place is kept before anything is told');
  stand.changes.push(change(4, 1));
  stand.notify('row_changes');
  await done;
  assert.deepEqual(told, ['p_made_up:4:1'], 'a change after the start is told');
});

test('an empty table starts at its beginning, a kept place is resumed, and from_the_start tells the whole table', async () => {
  const empty = client([]);
  const first = await run(empty, { settings: { from_the_start: false } });
  await new Promise(resolve => setTimeout(resolve, 20));
  empty.changes.push(change(1, 1));
  empty.notify('row_changes');
  await first.done;
  assert.deepEqual(first.told.map(item => item.event_key), ['p_made_up:1:1'], 'the first change of an empty table is told');
  const kept = client([change(1, 1), change(2, 2), change(3, 3)]);
  const resumed = await run(kept, { state: { after: { txid: '1', position: '1' } }, stopAfter: 2, settings: { from_the_start: false } });
  await resumed.done;
  assert.deepEqual(resumed.told.map(item => item.event_key), ['p_made_up:2:2', 'p_made_up:3:3'], 'a kept place resumes, never jumps to now');
  assert.ok(!kept.asked.includes('NOW'), 'a reader with a kept place never asks where now is');
  const all = await run(client([change(1, 1), change(2, 2)]), { stopAfter: 2, settings: { from_the_start: true } });
  await all.done;
  assert.deepEqual(all.told.map(item => item.event_key), ['p_made_up:1:1', 'p_made_up:2:2'], 'from_the_start tells every change');
});
