// tools/share-anything/test/share-anything.test.mjs
//
// The one sharing tool as a function of its input: the caller reads what it needs from a store (a Map here), runs the tool and
// applies the writes it returns. Covers a list shared with a person, an AI and a link, a text, a collection, stop, access, end,
// the run shares, what is refused, and the row's shape (no records door, no records rights). Every record is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { shareAnything } from '../do-work/share-anything.mjs';
import { grantOf, labelOf } from '../read-data/share-label.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { applyWrites, assertNoRecordReach, callTool, memoryStore } from './caller-store.mjs';

const digest = key => makeHashCodeHexFromBytes(new TextEncoder().encode(key)).slice(3);
const list = { label: 'Sample list', row_type: 'sample-row', fields: [{ id: 'title', label: 'Title' }] };
const shareRow = rows.records.find(row => row.payload.id === 'tool:share-anything').payload;

test('a list is shared read-only with a person and an AI, each with a key of its own that only its BLAKE3 is kept for', async () => {
  const thing = { list: 'sample' };
  const grant = grantOf(thing);
  assert.equal(grant, 'sharing:list:sample');
  const store = memoryStore({ 'list:sample': list });
  const answer = await callTool(store, { op: 'share', grant, thing, with: ['sample-person', { principal: 'sample-ai' }], link: true, origin: 'https://example.invalid/', until: '2999-01-01T00:00:00.000Z' });
  assert.deepEqual(answer.reach, [{ type: 'list', id: 'list:sample' }, { type: 'record:sample-row' }]);
  assert.equal(answer.title, 'Sample list');
  assert.deepEqual(answer.people.map(person => person.principal), ['sample-person', 'sample-ai']);
  const keys = [...answer.people.map(person => person.key), answer.link.key];
  assert.equal(new Set(keys).size, 3);
  for (const key of keys) assert.match(key, /^shr_[A-Za-z0-9_-]{43}$/);
  assert.equal(answer.people[0].url, `https://example.invalid/share/${answer.people[0].key}`);
  const kept = await store.get(grant);
  assert.deepEqual(kept.people.map(person => person.key_blake3).sort(), keys.map(digest).sort());
  assert.deepEqual(kept.can, ['view']);
  assert.equal(kept.expires_at, '2999-01-01T00:00:00.000Z');
  assert.equal((await store.text()).includes('shr_'), false, 'no key is in any stored record');
  assert.equal(JSON.stringify(answer.said).includes('shr_'), false, 'no key is in the said words');
  const seen = await callTool(store, { op: 'access', grant });
  assert.equal(seen.state, 'open');
  assert.deepEqual(seen.people.map(person => person.principal), ['sample-person', 'sample-ai']);
  assert.equal(seen.link.on, true);
  assert.equal(JSON.stringify(seen).includes('shr_'), false);
});

test('the share answers writes that hold only what the store must still hold, and a changed store refuses the write blind', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:zero' };
  const grant = grantOf(thing);
  const store = memoryStore();
  const answer = shareAnything({ op: 'share', grant, thing, with: ['first'], stored: { kept: null } });
  assert.equal(answer.writes.length, 1);
  assert.equal(answer.writes[0].kind, 'share');
  assert.equal(answer.writes[0].address, grant);
  assert.equal(answer.writes[0].expect, null);
  // Another change lands between the read and the write: the write is refused, not made blind.
  await store.put(grant, { reach: [], people: [] }, 'share');
  await assert.rejects(() => applyWrites(store, answer.writes), /conflict at sharing:sample-note:zero/);
  assert.deepEqual(await store.get(grant), { reach: [], people: [] }, 'the other change is kept');
});

test('sharing again with someone it is already shared with is refused, and a different person is added beside them', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:one' };
  const grant = grantOf(thing);
  const store = memoryStore();
  await callTool(store, { op: 'share', grant, thing, with: ['first'] });
  await assert.rejects(() => callTool(store, { op: 'share', grant, thing, with: ['first'] }), /already shared with first/);
  await callTool(store, { op: 'share', grant, thing, with: ['second'] });
  const kept = await store.get(grant);
  assert.deepEqual(kept.people.map(person => person.principal), ['first', 'second']);
  assert.deepEqual(kept.reach, [{ type: 'sample-note', id: 'sample-note:one' }]);
});

test('stopping one person leaves the others and stopping everyone empties the share and marks it stopped', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:two' };
  const grant = grantOf(thing);
  const store = memoryStore();
  await callTool(store, { op: 'share', grant, thing, with: ['first', 'second'], link: true });
  const one = await callTool(store, { op: 'stop', grant, principal: 'first' });
  assert.deepEqual(one.removed, ['first']);
  assert.deepEqual((await store.get(grant)).people.map(person => person.principal), ['second', 'link']);
  await assert.rejects(() => callTool(store, { op: 'stop', grant, principal: 'first' }), /not shared with first/);
  const link = await callTool(store, { op: 'stop', grant, principal: 'link' });
  assert.deepEqual(link.removed, ['link']);
  const all = await callTool(store, { op: 'stop', grant, now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(all.removed, ['second']);
  const seen = await callTool(store, { op: 'access', grant });
  assert.equal(seen.state, 'stopped');
  assert.deepEqual(seen.people, []);
});

test('a share past its end reads as ended, and an end in the past is refused', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:three' };
  const grant = grantOf(thing);
  const store = memoryStore();
  await assert.rejects(() => callTool(store, { op: 'share', grant, thing, with: ['first'], until: '2000-01-01T00:00:00.000Z' }), /future time/);
  await callTool(store, { op: 'share', grant, thing, with: ['first'], until: '2999-01-01T00:00:00.000Z' });
  assert.equal((await callTool(store, { op: 'access', grant, now: '3000-01-01T00:00:00.000Z' })).state, 'ended');
});

test('a text is kept as its own record before it is shared, and a collection reaches exactly the items it names', async () => {
  const textThing = { text: 'Sample text one.\nSecond line.', title: 'Sample text' };
  const textGrant = grantOf(textThing);
  const store = memoryStore();
  const answer = await callTool(store, { op: 'share', grant: textGrant, thing: textThing, link: true });
  assert.equal(answer.reach[0].type, 'shared-text');
  assert.match(answer.reach[0].id, /^shared-text:[0-9a-f]{24}$/);
  const stored = await store.get(answer.reach[0].id);
  assert.deepEqual(stored, { title: 'Sample text', text: textThing.text });
  const writes = shareAnything({ op: 'share', grant: textGrant, thing: textThing, link: true, stored: { kept: null } }).writes;
  assert.equal(writes[0].kind, 'shared-text', 'the text record is written first');
  assert.equal(writes[0].type, 'shared-text');
  assert.equal(writes[0].expect, null);
  const items = { items: [{ type: 'sample-note', id: 'sample-note:four' }, { type: 'sample-note', prefix: 'sample-note:' }], title: 'Sample collection' };
  const collection = grantOf(items);
  assert.match(collection, /^sharing:collection:sample-collection-[0-9a-f]{12}$/);
  const shared = await callTool(memoryStore(), { op: 'share', grant: collection, thing: items, with: ['first'] });
  assert.deepEqual(shared.reach, [{ type: 'sample-note', id: 'sample-note:four' }, { type: 'sample-note', prefix: 'sample-note:' }]);
});

test('the tool refuses what it should: a wrong grant, a share that is not view only, a bad thing, nobody to share with, a no-such list', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:four' };
  const grant = grantOf(thing);
  const store = memoryStore();
  await assert.rejects(() => callTool(store, { op: 'share', grant: 'sharing:other', thing, with: ['first'] }), /grant is where this share is kept: sharing:sample-note:four/);
  await assert.rejects(() => callTool(store, { op: 'share', grant, thing, with: ['first'], can: ['view', 'edit'] }), /lets people view it/);
  await assert.rejects(() => callTool(store, { op: 'share', grant, thing, with: [] }), /Name who to share with/);
  await assert.rejects(() => callTool(store, { op: 'share', grant, thing: { type: 'x', id: 'a/b' }, with: ['first'] }), /thing is one of/);
  await assert.rejects(() => callTool(store, { op: 'share', grant, thing, with: ['link'] }), /the name link is the link's/);
  await assert.rejects(() => callTool(store, { op: 'share', grant, thing, with: ['first'], origin: 'http://example.invalid' }), /https/);
  await assert.rejects(() => callTool(store, { op: 'nothing' }), /op is share, stop, access or end/);
  await assert.rejects(() => callTool(store, { op: 'stop', grant }), /Nothing is shared/);
  await assert.rejects(() => callTool(memoryStore(), { op: 'share', grant: 'sharing:list:missing', thing: { list: 'missing' }, with: ['first'] }), /No list missing/);
  assert.deepEqual(await store.list('sharing:'), [], 'a refused share writes nothing');
});

test('tools are shared to run at the sharer door: each person a key of its own, kept as a digest, with an end', async () => {
  const grant = 'sharing:team-tools';
  const store = memoryStore();
  const answer = await callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:sample-b', 'tool:sample-a'], with: ['member-a', 'member-b'], until: '2999-01-01T00:00:00.000Z' });
  assert.deepEqual(answer.tools, ['tool:sample-a', 'tool:sample-b']);
  assert.deepEqual(answer.people.map(person => person.principal), ['member-a', 'member-b']);
  for (const person of answer.people) assert.match(person.key, /^shr_[A-Za-z0-9_-]{43}$/);
  const kept = await store.get(grant);
  assert.deepEqual(kept.grant, { tools: ['tool:sample-a', 'tool:sample-b'], identity: 'none', journal: 'input' });
  assert.deepEqual(kept.people.map(person => person.key_blake3), answer.people.map(person => digest(person.key)));
  assert.equal(JSON.stringify(kept).includes('shr_'), false);
  assert.deepEqual(kept.ends, { until: '2999-01-01T00:00:00.000Z', since: kept.ends.since });
  await callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:sample-a', 'tool:sample-b'], with: ['member-c'] });
  assert.deepEqual((await store.get(grant)).ends.until, '2999-01-01T00:00:00.000Z', 'a later share keeps the rule it has');
  await assert.rejects(() => callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:other'], with: ['member-d'] }), /already shares other tools/);
  await assert.rejects(() => callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:sample-a', 'tool:sample-b'], with: ['member-a'] }), /already shared with member-a/);
  const seen = await callTool(store, { op: 'access', can: ['run'], grant });
  assert.equal(seen.state, 'open');
  assert.deepEqual(seen.people.map(person => person.principal), ['member-a', 'member-b', 'member-c']);
});

test('a run share is refused without tools, with a link, with a name the engine cannot keep, or with a past end', async () => {
  const grant = 'sharing:refused-run';
  const store = memoryStore();
  await assert.rejects(() => callTool(store, { op: 'share', can: ['run'], grant, tools: [], with: ['a'] }), /names 1 to 64 tool ids/);
  await assert.rejects(() => callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:x'], link: true, with: ['a'] }), /never a link/);
  await assert.rejects(() => callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:x'], with: ['a person'] }), /letters, digits/);
  await assert.rejects(() => callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:x'], with: ['a'], until: '2000-01-01T00:00:00.000Z' }), /future time/);
  await assert.rejects(() => callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:x'], with: ['a'], identity: 'everyone' }), /identity is none or self/);
  await assert.rejects(() => callTool(store, { op: 'share', can: ['edit'], grant, thing: { type: 'sample-note', id: 'sample-note:x' }, with: ['a'] }), /can: \["run"\]/);
  assert.deepEqual(await store.list('sharing:'), [], 'nothing is written');
});

test('stopping one run person keeps the others, and stopping everyone withdraws the run grant', async () => {
  const grant = 'sharing:stop-run';
  const store = memoryStore();
  await callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:sample-a'], with: ['member-a', 'member-b'] });
  const one = await callTool(store, { op: 'stop', can: ['run'], grant, principal: 'member-a' });
  assert.deepEqual(one.removed, ['member-a']);
  assert.deepEqual((await store.get(grant)).people.map(person => person.principal), ['member-b']);
  await assert.rejects(() => callTool(store, { op: 'stop', can: ['run'], grant, principal: 'member-a' }), /not shared with member-a/);
  const all = await callTool(store, { op: 'stop', can: ['run'], grant });
  assert.deepEqual(all.removed, ['member-b']);
  assert.equal(await store.get(grant), null, 'the run grant is withdrawn');
  assert.equal((await callTool(store, { op: 'access', can: ['run'], grant })).shared, false);
});

test('an end rule is kept beside the run grant, set again by op end, and a share needs its rule read from the store', async () => {
  const grant = 'sharing:rule-run';
  const store = memoryStore();
  await callTool(store, { op: 'share', can: ['run'], grant, tools: ['tool:sample-a'], with: ['member-a'], unused_days: 30, now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual((await store.get(grant)).ends, { unused_days: 30, since: '2026-01-01T00:00:00.000Z' });
  await callTool(store, { op: 'end', can: ['run'], grant, unused_days: 365, now: '2026-01-21T00:00:00.000Z' });
  assert.deepEqual((await store.get(grant)).ends, { unused_days: 365, since: '2026-01-21T00:00:00.000Z' });
  await callTool(store, { op: 'end', can: ['run'], grant, now: '2026-01-22T00:00:00.000Z' });
  assert.equal((await store.get(grant)).ends, undefined, 'neither given: it never ends, and the people keep their keys');
  assert.equal((await store.get(grant)).people.length, 1);
  assert.throws(() => shareAnything({ op: 'end', can: ['view'], grant, stored: { kept: null } }), /Only a share that runs tools/);
});

test('the row is a function with its source files, not record authority from a source-fetch dependency', () => {
  assertNoRecordReach(shareRow);
  assert.deepEqual(shareRow.invoke.argv.slice(1), ['/opt/workflows/do-work/run-a-function.mjs', '/opt/share-anything/do-work/share-anything.mjs', 'shareAnything']);
});

test('the row contract allows fetch-only dependencies but rejects actual record grants, targets and host reach', () => {
  const fetchOnly = structuredClone(shareRow);
  fetchOnly.uses_tools = ['trillion-workshop/records-door'];
  assert.doesNotThrow(() => assertNoRecordReach(fetchOnly));
  for (const change of [
    row => { row.invoke.records = { fd: 4, runs: ['tool:run-sql-in-my-database'] }; },
    row => { row.stored = [{ at: '@own-records', operations: ['records:read'] }]; },
    row => { row.invoke.argv.push('records:write'); },
    row => { row.invoke.files.package_files.push({ package: 'records-door', paths: ['do-work'], at: '/opt/records-door' }); },
    row => { row.invoke.local_doors = ['records']; },
    row => { row.invoke.parent_actions = { operations: ['records:read'] }; },
    row => { row.invoke.by_input = { input: 'op', variants: { share: { records: { fd: 4, runs: ['tool:run-sql-in-my-database'] } } } }; },
    row => { row.invoke_with = 'tool:run-sql-in-my-database'; },
    row => { row.uses_tools = [{ records: { fd: 4 } }]; },
  ]) {
    const bad = structuredClone(fetchOnly);
    change(bad);
    assert.throws(() => assertNoRecordReach(bad), assert.AssertionError);
  }
});
