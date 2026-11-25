// tools/start-a-computer/test/hold-a-computer-row.test.mjs
//
// One apply of a row at a time: a second hold of the same row is refused at once with who holds it and since when, a hold of
// another row is not, a released or ended hold frees the row, a lost session is refused before anything more is written, and an
// apply takes its hold before it reads the row and gives it back after its last write. The database is made up: each session is a
// client of one shared lock list that answers the statements hold-a-computer-row.mjs sends, as PostgreSQL's advisory locks do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { heldWords, holdComputerRow, holderIn, LOCK_CLASS } from '../do-work/hold-a-computer-row.mjs';
import { applyARow } from '../do-work/apply-a-computer-row.mjs';

/** A made-up database: `connect()` opens a session of its own; advisory locks are kept per (class, name) with their session. */
function database() {
  const locks = new Map(), sessions = new Map();
  let next = 100;
  const connect = async () => {
    const pid = next++;
    const session = { pid, query: '', backend_start: '2026-11-25T11:00:00.000Z', open: true };
    sessions.set(pid, session);
    const client = new EventEmitter();
    client.escapeLiteral = text => `'${text.replaceAll("'", "''")}'`;
    client.query = async (sql, params = []) => {
      if (!session.open) throw new Error('the session has ended');
      const key = `${params[0]}|${params[1]}`;
      let answer;
      if (sql.startsWith('select pg_try_advisory_lock')) {
        const holder = locks.get(key);
        if (holder === undefined || holder === pid) { locks.set(key, pid); answer = [{ got: true }]; } else answer = [{ got: false }];
      } else if (sql.startsWith('select pg_advisory_unlock')) {
        answer = [{ released: locks.get(key) === pid }];
        if (locks.get(key) === pid) locks.delete(key);
      } else if (sql.startsWith('select a.pid')) {
        const holder = locks.get(key);
        const mine = sql.includes('pg_backend_pid()');
        answer = holder === undefined || (mine && holder !== pid) ? [] : [{ ...sessions.get(holder), client_addr: '192.0.2.50' }];
      } else answer = [{ holding: sql }];
      session.query = sql;
      return { rows: answer };
    };
    client.end = async () => {
      session.open = false;
      for (const [key, holder] of locks) if (holder === pid) locks.delete(key);
    };
    client.session = session;
    return client;
  };
  return { connect, locks };
}

const holder = by => ({ by, pid: 4242, host: 'a-mac', log_folder: '/tmp/row-example-box-x' });
const at = () => Date.parse('2026-11-25T11:30:00Z');

test('a second hold of the same row is refused at once, naming who holds it and since when', async () => {
  const db = database();
  const first = await holdComputerRow('example-box', { connect: db.connect, holder: holder('lane one'), now: at });
  await assert.rejects(holdComputerRow('example-box', { connect: db.connect, holder: holder('lane two') }), error => {
    assert.equal(error.exit, 3);
    assert.equal(error.row_held, true);
    assert.match(error.message, /^the example-box row is being applied by lane one \(process 4242 on a-mac, logs in \/tmp\/row-example-box-x\) since 2026-11-25T11:30:00\.000Z; one apply of a row at a time/);
    return true;
  });
  assert.equal(db.locks.size, 1, 'the refused hold took nothing');
  await first.release();
  const again = await holdComputerRow('example-box', { connect: db.connect, holder: holder('lane two') });
  assert.equal(again.holder.by, 'lane two');
  await again.release();
  assert.equal(db.locks.size, 0);
});

test('holds of two different rows both stand, and the lock key is the row name under one class', async () => {
  const db = database();
  const one = await holdComputerRow('box-one', { connect: db.connect, holder: holder('lane one') });
  const two = await holdComputerRow('box-two', { connect: db.connect, holder: holder('lane two') });
  assert.deepEqual([...db.locks.keys()].sort(), [`${LOCK_CLASS}|box-one`, `${LOCK_CLASS}|box-two`]);
  await one.check();
  await two.check();
  await Promise.all([one.release(), two.release()]);
});

test('a hold whose session ended frees the row, and a hold no longer this session\'s or whose session failed is refused', async () => {
  const db = database();
  const clients = [];
  const connect = async () => { const client = await db.connect(); clients.push(client); return client; };
  const taken = await holdComputerRow('example-box', { connect, holder: holder('lane one') });
  db.locks.delete(`${LOCK_CLASS}|example-box`);
  await assert.rejects(taken.check(), /no longer holds the example-box row; nothing more was written/);
  await taken.release();
  const died = await holdComputerRow('example-box', { connect, holder: holder('lane two') });
  await clients.at(-1).end();
  const next = await holdComputerRow('example-box', { connect, holder: holder('lane three') });
  assert.equal(next.holder.by, 'lane three', 'an apply that died holds nothing');
  clients.at(-1).emit('error', new Error('connection reset'));
  await assert.rejects(next.check(), /the hold on the example-box row was lost \(connection reset\)/);
  await Promise.all([died.release(), next.release()]);
});

test('the holder\'s words survive a quote, and a session with no words is named by its process and address', () => {
  const words = { by: "o'brien lane", pid: 1, host: 'h', since: '2026-11-25T11:30:00.000Z' };
  const query = `select '${`apply-a-computer-row holds ${JSON.stringify(words)}`.replaceAll("'", "''")}' as holding`;
  assert.deepEqual(holderIn(query), words);
  assert.equal(holderIn('select 1'), null);
  assert.match(heldWords('box', { pid: 77, client_addr: '192.0.2.9', backend_start: '2026-11-25T10:00:00Z', query: 'select 1' }),
    /being applied by database session 77 from 192\.0\.2\.9 since 2026-11-25T10:00:00\.000Z/);
});

// applyARow with every outside part made up, a store per row, and the apply paused until `finish` is called.
function applyWorld(db) {
  const reads = [];
  const store = {
    read: async name => { reads.push(name); return { computer: { _what: 'x', name, address: '192.0.2.7', os: 'linux', arch: 'x86_64', runs: { units: [] } }, siteSetting: null }; },
    write: async () => ({ read_back_equal: true }),
  };
  const gates = [];
  const deps = {
    store,
    targets: { machines: { '192.0.2.7': { ssh: { known_hosts: '/h', identity_file: '/k' } } }, probe: {} },
    heldValues: async () => ({}),
    runFolder: name => `/tmp/row-${name}-test`,
    archive: async () => {},
    checkApplyProtocol: async () => {},
    startProbe: async ({ urls }) => ({ stop: async () => ({ started: '2026-11-25T11:00:00Z', stopped: '2026-11-25T11:00:01Z', sent: 1, ok: 1, failed: 0, retried: 0, slow: 0, urls }) }),
    runApply: () => new Promise(done => gates.push(() => done({ exit: 0, receipt: { row_apply_protocol: 1, written: [], restarted: [] } }))),
    addressesOf: async () => ['192.0.2.7'],
    isAncestor: async () => true,
    sleep: async () => {}, now: () => Date.parse('2026-11-25T11:00:00Z'),
    holdRow: name => holdComputerRow(name, { connect: db.connect, holder: holder(`apply of ${name}`) }),
  };
  return { deps, reads, gates };
}
const COMMIT = 'a'.repeat(40);
const until = async check => { for (let i = 0; i < 200 && !check(); i++) await new Promise(done => setImmediate(done)); };

test('a second apply of a row being applied is refused before it reads the row; an apply of another row runs beside it', async t => {
  const { mkdirSync, rmSync } = await import('node:fs');
  for (const name of ['box-one', 'box-two']) mkdirSync(`/tmp/row-${name}-test`, { recursive: true });
  t.after(() => { for (const name of ['box-one', 'box-two']) rmSync(`/tmp/row-${name}-test`, { recursive: true, force: true }); });
  const db = database();
  const { deps, reads, gates } = applyWorld(db);
  const first = applyARow({ computer: 'box-one', workshop_commit: COMMIT }, {}, deps);
  await until(() => gates.length === 1);
  await assert.rejects(applyARow({ computer: 'box-one', workshop_commit: COMMIT }, {}, deps), /the box-one row is being applied by apply of box-one .* since .*; one apply of a row at a time/);
  assert.deepEqual(reads, ['box-one'], 'the refused apply never read the row');
  const dry = await applyARow({ computer: 'box-one', workshop_commit: COMMIT }, { dryRun: true }, deps);
  assert.equal(dry.summary.dry_run, true, 'a dry run takes no hold');
  const other = applyARow({ computer: 'box-two', workshop_commit: COMMIT }, {}, deps);
  await until(() => gates.length === 2);
  gates.forEach(open => open());
  const [one, two] = await Promise.all([first, other]);
  assert.deepEqual([one.code, two.code], [0, 0]);
  assert.match(one.summary.row_held_since, /^\d{4}-\d\d-\d\dT/);
  assert.equal(db.locks.size, 0, 'each apply gave its hold back');
  const after = applyARow({ computer: 'box-one', workshop_commit: COMMIT }, {}, deps);
  await until(() => gates.length === 3);
  gates[2]();
  assert.equal((await after).code, 0, 'the row is free once the first apply ended');
});

test('an apply that fails still gives its hold back', async () => {
  const db = database();
  const { deps } = applyWorld(db);
  deps.store.read = async () => { throw new Error('no such row'); };
  await assert.rejects(applyARow({ computer: 'box-gone', workshop_commit: COMMIT }, {}, deps), /no such row/);
  assert.equal(db.locks.size, 0);
});
