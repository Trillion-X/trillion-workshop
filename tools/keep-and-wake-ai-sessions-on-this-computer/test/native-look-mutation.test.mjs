import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { makeLooks, handleLooksRequest } from '../../choose-and-publish-screen-looks/src/looks.mjs';
import inputs from '../../choose-and-publish-screen-looks/src/workspace/inputs.json' with { type: 'json' };
import appLooks from '../../choose-and-publish-screen-looks/src/workspace/looks.json' with { type: 'json' };

const WORN = inputs['current-screen-look'].address;
const OWN = inputs['own-screen-look-themes'].address;
const PLAN = 'workspace-preference:screen-look-over-time';
const RULES = 'workspace-preference:where-looks-apply';
const APP_ID = appLooks.themes[0].payload.id;
const at = new Date('2026-10-15T06:00:00.000Z');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// Canonical decoded tokens may carry undefined optional properties; the public JSON response omits those.
const publicResult = value => JSON.parse(JSON.stringify(value));

function lookRecord(id) {
  const record = structuredClone(appLooks.themes[0]);
  record.address = `package::screen-look::published-record::editable-theme::${id}`;
  record.payload = { ...record.payload, id, name: id, description: `Fixture ${id}` };
  return record;
}

// The canonical Looks owner, real synchronous SQLite workspace records, and the native transaction boundary.
// The exact result lives in the same transaction as the records, rather than a second best-effort capture.
function fixture(t, { beforeShelf = async () => {}, beforeMutation = async () => {}, commitMutation } = {}) {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  host.sql.exec('CREATE TABLE workspace_records (label TEXT PRIMARY KEY,value TEXT NOT NULL)');
  host.sql.exec('CREATE TABLE command_results (request_key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const trace = [], commits = [], published = new Map(), effects = [];
  let admitted = true, failCommit = false, requestKey = 'original-command';
  const read = label => {
    const row = host.sql.exec('SELECT value FROM workspace_records WHERE label=? LIMIT 1', label).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  };
  const write = (label, value) => host.sql.exec('INSERT INTO workspace_records VALUES(?,?) ON CONFLICT(label) DO UPDATE SET value=excluded.value', label, JSON.stringify(value));
  const looks = makeLooks({
    records: {
      read: labels => Object.fromEntries(labels.map(label => [label, read(label)])),
      write: writes => { for (const item of writes) { trace.push(`write:${item.address_label}`); write(item.address_label, item.payload); } },
    },
    maker: 'maker:fixture', now: () => new Date(at),
    shelf: {
      one: async (shelf, id) => {
        assert.equal(shelf, 'look'); trace.push(`shelf:${id}`); await beforeShelf(id);
        return structuredClone(published.get(id) ?? null);
      },
      published: async () => { throw new Error('The native fixture never enumerates the whole shelf.'); },
      publishedPage: async () => ({ rows: [], total: 0 }),
      publish: async input => { effects.push(['publish', structuredClone(input)]); },
      withdraw: async input => { effects.push(['withdraw', structuredClone(input)]); return true; },
    },
    beforeMutation: async (operation, input) => {
      await beforeMutation(operation, input);
      trace.push(`gate:${operation}`);
      assert.ok(input && typeof input === 'object');
      if (!admitted) throw Object.assign(new Error('Current Looks rights were revoked.'), { status: 403 });
    },
    commitMutation: commitMutation ?? ((change, metadata) => {
      assert.deepEqual(Object.keys(metadata), ['operation']);
      assert.equal(trace.at(-1), `gate:${metadata.operation}`, 'No awaited shelf read follows final admission.');
      const result = host.transaction(() => {
        if (!admitted) throw Object.assign(new Error('Current synchronous commitment was revoked.'), { status: 403 });
        trace.push(`commit:${metadata.operation}`);
        const answer = change();
        assert.equal(typeof answer?.then, 'undefined', 'Local state and exact public response are synchronous.');
        if (failCommit) throw new Error('Original local transaction failed.');
        host.sql.exec('INSERT INTO command_results VALUES(?,?)', requestKey, JSON.stringify(answer));
        return answer;
      });
      commits.push(structuredClone(metadata));
      return result;
    }),
  });
  return { looks, read, write, trace, commits, effects, published,
    revoke: () => { admitted = false; }, failCommit: () => { failCommit = true; }, request: key => { requestKey = key; },
    result: () => { const row = host.sql.exec('SELECT value FROM command_results WHERE request_key=? LIMIT 1', requestKey).toArray()[0]; return row ? JSON.parse(row.value) : null; },
    offer: (id, maker = 'maker:other') => published.set(id, { maker, row: { id, name: id, record: lookRecord(id) } }),
  };
}

for (const stage of ['lookup', 'publication']) {
  test(`wear rechecks current rights after awaited external ${stage} and keeps no revoked copy`, async t => {
    const arrived = deferred(), release = deferred();
    let reads = 0;
    const f = fixture(t, { beforeShelf: async () => {
      reads++;
      if (reads === (stage === 'lookup' ? 1 : 2)) { arrived.resolve(); await release.promise; }
    } });
    f.offer('borrowed-look');
    const pending = f.looks.wear({ look_id: 'borrowed-look' });
    await arrived.promise; f.revoke(); release.resolve();
    await assert.rejects(pending, { status: 403 });
    assert.equal(f.read(OWN), null); assert.equal(f.read(WORN), null); assert.equal(f.result(), null);
    assert.deepEqual(f.commits, []);
    assert.equal(f.trace.at(-1), 'gate:looks:wear');
  });
}

test('wear reads an owned publication before its local mutation and captures the unchanged public summary', async t => {
  const f = fixture(t); f.write(OWN, [lookRecord('owned-look')]); f.offer('owned-look', 'maker:fixture');
  const answer = await f.looks.wear({ look_id: 'owned-look' });
  assert.equal(answer.look.published, true); assert.equal(answer.look.made_by, 'this account');
  assert.deepEqual(f.result(), answer); assert.deepEqual(f.read(WORN), [{ name: 'owned-look' }]);
  assert.deepEqual(f.trace, ['shelf:owned-look', 'gate:looks:wear', 'commit:looks:wear', `write:${WORN}`]);
});

test('wear atomically keeps an offered look, wears it and holds the current plan with its exact result', async t => {
  const f = fixture(t); f.offer('borrowed-look');
  await f.looks.over_time({ preset: 'evening-dims-to-black' }); f.request('wear-command'); f.trace.length = 0;
  const answer = await f.looks.wear({ look_id: 'borrowed-look' });
  assert.equal(answer.look.published, false); assert.equal(answer.look.made_by, 'this account');
  assert.deepEqual(f.result(), answer); assert.equal(f.read(OWN)[0].payload.id, 'borrowed-look');
  assert.deepEqual(f.read(WORN), [{ name: 'borrowed-look' }]);
  assert.deepEqual(f.read(PLAN).hold, { kind: 'worn', since: at.toISOString() });
  assert.deepEqual(f.trace.slice(0, 4), ['shelf:borrowed-look', 'shelf:borrowed-look', 'gate:looks:wear', 'commit:looks:wear']);
  assert.equal(f.trace.filter(item => item.startsWith('shelf:')).length, 2);
});

for (const stage of ['base', 'identity']) {
  test(`save rechecks current rights after awaited ${stage} lookup before keeping or wearing a look`, async t => {
    const arrived = deferred(), release = deferred();
    const id = stage === 'base' ? 'borrowed-look' : 'new-name';
    const f = fixture(t, { beforeShelf: async readId => { if (readId === id) { arrived.resolve(); await release.promise; } } });
    f.offer('borrowed-look');
    const pending = f.looks.save(stage === 'base' ? { from: 'borrowed-look', name: 'Copied' } : { from: APP_ID, name: 'New Name' });
    await arrived.promise; f.revoke(); release.resolve();
    await assert.rejects(pending, { status: 403 });
    assert.equal(f.read(OWN), null); assert.equal(f.read(WORN), null); assert.equal(f.result(), null);
    assert.deepEqual(f.commits, []); assert.equal(f.trace.at(-1), 'gate:looks:save');
  });
}

const localMutations = [
  { verb: 'wear', input: { look_id: 'borrowed-look' }, prepare: f => f.offer('borrowed-look') },
  { verb: 'save', input: { from: APP_ID, name: 'Saved Fixture', tokens: { 'accent-primary': '#123456' } } },
  { verb: 'over_time', input: { preset: 'evening-dims-to-black' } },
  { verb: 'set_rule', input: { rule: { id: 'fixture-rule', look_id: APP_ID, label: 'Fixture rule' } } },
  { verb: 'remove_rule', input: { id: 'fixture-rule' }, prepare: async f => {
    f.request('setup'); await f.looks.set_rule({ rule: { id: 'fixture-rule', look_id: APP_ID } }); f.request('original-command');
  } },
];

for (const { verb, input, prepare } of localMutations) {
  test(`${verb} commits the exact public response with its local workspace state`, async t => {
    const f = fixture(t); await prepare?.(f); f.trace.length = 0;
    const answer = await f.looks[verb](input);
    assert.deepEqual(f.result(), publicResult(answer));
    assert.deepEqual(f.commits.at(-1), { operation: `looks:${verb}` });
    const writes = f.trace.filter(item => item.startsWith('write:'));
    assert.ok(writes.length);
    assert.equal(f.trace.indexOf(`gate:looks:${verb}`) + 1, f.trace.indexOf(`commit:looks:${verb}`));
    assert.equal(f.trace.slice(f.trace.indexOf(`commit:looks:${verb}`) + 1).some(item => item.startsWith('shelf:')), false);
    if (verb === 'save') {
      assert.equal(f.read(OWN)[0].payload.id, answer.look.id);
      assert.equal(f.read(WORN)[0].name, answer.look.id);
    } else if (verb === 'over_time') assert.deepEqual(f.read(PLAN), answer.plan);
    else if (verb === 'set_rule' || verb === 'remove_rule') {
      assert.deepEqual(await f.looks.rules(), { ...answer, said: answer.said.replace(/^(Saved|Removed)\. /, '') });
      assert.equal(answer.rules.length, verb === 'set_rule' ? 1 : 0);
    }
  });

  test(`${verb} rolls back the local records and response together when result commitment fails`, async t => {
    const f = fixture(t); await prepare?.(f);
    const earlier = [OWN, WORN, PLAN, RULES].map(f.read);
    const committed = f.commits.length; f.failCommit();
    await assert.rejects(f.looks[verb](input), /Original local transaction failed/);
    assert.deepEqual([OWN, WORN, PLAN, RULES].map(f.read), earlier);
    assert.equal(f.result(), null); assert.equal(f.commits.length, committed);
    if (verb === 'set_rule') assert.deepEqual((await f.looks.rules()).rules, [], 'Rollback is visible through the same owner.');
    if (verb === 'remove_rule') assert.equal((await f.looks.rules()).rules.length, 1);
  });

  test(`${verb} refuses current revocation before any local workspace write`, async t => {
    const f = fixture(t); await prepare?.(f);
    const earlier = [OWN, WORN, PLAN, RULES].map(f.read);
    const committed = f.commits.length; f.trace.length = 0; f.revoke();
    await assert.rejects(f.looks[verb](input), { status: 403 });
    assert.deepEqual([OWN, WORN, PLAN, RULES].map(f.read), earlier);
    assert.equal(f.result(), null); assert.equal(f.commits.length, committed);
    assert.equal(f.trace.at(-1), `gate:looks:${verb}`);
    assert.equal(f.trace.some(item => item.startsWith('write:')), false);
  });
}

test('read-only Looks operations and an unchanged over-time read never enter the mutation boundary', async t => {
  const f = fixture(t);
  await f.looks.list(); await f.looks.read({ look_id: APP_ID }); await f.looks.rules(); await f.looks.over_time({});
  await f.looks.device({}); await f.looks.page({}); await f.looks.which({}); await f.looks.shelf({});
  assert.deepEqual(f.trace.filter(item => item.startsWith('gate:') || item.startsWith('commit:') || item.startsWith('write:')), []);
  assert.deepEqual(f.commits, []); assert.equal(f.result(), null);
});

test('publication and withdrawal keep the shelf lifecycle instead of using a local mutation receipt', async t => {
  const f = fixture(t); f.write(OWN, [lookRecord('owned-look')]);
  assert.deepEqual(await f.looks.publish({ look_id: 'owned-look' }), { published: 'owned-look', said: 'owned-look is published for everyone.' });
  assert.deepEqual(await f.looks.withdraw({ look_id: 'owned-look' }), { withdrawn: true, said: 'owned-look is withdrawn.' });
  assert.deepEqual(f.effects.map(([operation]) => operation), ['publish', 'withdraw']);
  assert.deepEqual(f.trace, []); assert.deepEqual(f.commits, []); assert.equal(f.result(), null);
});

test('invalid local changes are refused before a native mutation is committed', async t => {
  const f = fixture(t);
  await assert.rejects(f.looks.save({ look_id: APP_ID, tokens: { 'accent-primary': 'not-a-colour' } }));
  await assert.rejects(f.looks.over_time({ points: [{ at: { clock: '21:00' }, look: 'missing-look' }] }));
  await assert.rejects(f.looks.set_rule({ rule: { look_id: 'missing-look' } }));
  assert.deepEqual(f.trace, []); assert.deepEqual(f.commits, []); assert.equal(f.result(), null);
});

test('an async Looks commit supply is refused before it can start', () => {
  let started = false;
  assert.throws(() => makeLooks({ records: {}, shelf: {}, maker: 'maker:fixture', commitMutation: async () => { started = true; } }), /must be synchronous/);
  assert.equal(started, false);
});

test('a returned Looks commit Promise is refused without falling back to uncaptured writes', async t => {
  const f = fixture(t, { commitMutation: () => Promise.resolve({}) });
  await assert.rejects(f.looks.wear({ look_id: APP_ID }), /must be synchronous/);
  assert.equal(f.read(WORN), null); assert.equal(f.result(), null);
  assert.deepEqual(f.trace, ['gate:looks:wear']);
});

for (const family of ['rule', 'plan']) test(`delayed ${family} admission derives its final change from current local state`, async t => {
  const arrived = deferred(), release = deferred();
  let blocked = false;
  const f = fixture(t, { beforeMutation: async () => {
    if (!blocked) { blocked = true; arrived.resolve(); await release.promise; }
  } });
  const first = family === 'rule'
    ? f.looks.set_rule({ rule: { id: 'first-rule', look_id: APP_ID } })
    : f.looks.over_time({ time_zone: 'America/Los_Angeles' });
  await arrived.promise;
  f.request('intervening-command');
  if (family === 'rule') await f.looks.set_rule({ rule: { id: 'second-rule', look_id: APP_ID } });
  else await f.looks.over_time({ place: { latitude: 37, longitude: -122 } });
  f.request('original-command'); release.resolve(); await first;
  if (family === 'rule') assert.deepEqual(new Set((await f.looks.rules()).rules.map(row => row.id)), new Set(['first-rule', 'second-rule']));
  else {
    const { plan } = await f.looks.over_time({});
    assert.equal(plan.time_zone, 'America/Los_Angeles');
    assert.deepEqual(plan.place, { latitude: 37, longitude: -122 });
  }
});

for (const status of [401, 402, 403]) test(`native Looks HTTP preserves trusted current-admission status ${status} after its awaited reads`, async t => {
  const f = fixture(t, { beforeMutation: async () => { throw Object.assign(new Error('Fixture current admission refusal'), { status }); } });
  const response = await handleLooksRequest(f.looks, new Request('https://fixture.invalid/looks/save', {
    method: 'POST', body: JSON.stringify({ name: 'No revoked look' }),
  }));
  assert.equal(response.status, status);
  assert.match((await response.json()).error, /Current access does not admit/);
  assert.equal(f.read(OWN), null); assert.equal(f.read(WORN), null); assert.equal(f.result(), null);
});
