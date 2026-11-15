import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeSpacePermissions, ruleProblems, inheritedMemberTypes } from '../read-data/space-permissions.mjs';

const rule = (id, effect = 'allow', more = {}) => ({ id, effect, says: id, actions: ['put_on_events'], ...more });
const forType = id => ({ kind: 'member_type', member_type: id });
const condition = (field, values, operator = 'is_any_of') => ({ kind: 'group', combinator: 'and', rules: [
  { kind: 'rule', field, operator, params: { values } },
] });

// Only records and native admission are synthetic. Formula compilation, matching
// and effect precedence must be the actual canonical imports used by the core.
function fixture({ rules = [rule('members', 'allow', { who: { kind: 'any_member' } })], role = 'member', config = {}, own = [], label = 'community' } = {}) {
  const space = { id: 'space', label, title: 'Space', created_by: 'owner', created_at: '2026-11-01T00:00:00Z' };
  const people = new Map([['person', { membership_id: 'space', relay: 'person', role, state: 'member' }],
    ['owner', { membership_id: 'space', relay: 'owner', role: 'owner', state: 'member' }]]);
  let stored = rules === null ? null : { rules: typeof rules === 'string' ? rules : JSON.stringify(rules), changed_at: 'kept' };
  let graph = own;
  let configured = config;
  let admitted = true;
  let actor = 'person';
  let revision = 0;
  let reads = 0;
  const records = {
    async read(id) { return id === space.id ? structuredClone(space) : null; },
    async member(id, relay) { return id === space.id ? structuredClone(people.get(relay) ?? null) : null; },
    async members(id) { return id === space.id ? structuredClone([...people.values()]) : []; },
    async rules(id) { reads += 1; assert.equal(id, space.id); return structuredClone(stored); },
    async ensureRules(id, next) { assert.equal(id, space.id); stored ??= structuredClone(next); return structuredClone(stored); },
    async community(id) { assert.equal(id, space.id); return { config: structuredClone(configured) }; },
    async ownMemberTypes(id) { assert.equal(id, space.id); return structuredClone(graph); },
    async accessState(id) { assert.equal(id, space.id); return JSON.stringify({ people: [...people], stored, graph, configured, revision }); },
  };
  const owner = nativeSpacePermissions({ records, spaceId: 'space', resource: 'synthetic-space-resource',
    principal: async () => ({ resource: 'synthetic-space-resource', relay: actor }), current: async () => admitted,
    joinedByRules: async () => label === 'community', openToEveryone: async () => false,
    captureSpaceCommit: async () => {}, sourceAuthority: async () => false,
    memberNames: async () => relay => relay, spaceChanged: async () => {},
  });
  return { owner, records, space, people,
    get reads() { return reads; }, get stored() { return stored; },
    setRules(value) { stored = { rules: typeof value === 'string' ? value : JSON.stringify(value), changed_at: 'changed' }; revision += 1; },
    setGraph(value) { graph = value; revision += 1; }, setConfig(value) { configured = value; revision += 1; },
    revoke() { admitted = false; }, actor(value) { actor = value; },
  };
}

test('allow and deny use the canonical evaluator, and deny wins in either order', async () => {
  for (const rules of [[rule('allow'), rule('stop', 'deny', { refuses: 'Stopped here.' })],
    [rule('stop', 'deny', { refuses: 'Stopped here.' }), rule('allow')]]) {
    const f = fixture({ rules });
    const answer = await f.owner.decideInSpace(f.space, 'person', 'put_on_events');
    assert.equal(answer.allowed, false);
    assert.equal(answer.rule, 'stop');
    assert.equal(answer.says, 'Stopped here.');
    await assert.rejects(f.owner.allowedInSpace('space', 'person', 'put_on_events'), /Stopped here/);
  }
  const f = fixture();
  assert.equal((await f.owner.allowedInSpace('space', 'person', 'put_on_events')).id, 'space');
});

test('configured permissions are facts: inheritance grants, and an explicit rule can still deny', async () => {
  const f = fixture({ role: 'lead', config: { roles: { host: { may: ['put_on_events'] }, lead: { inherits: ['host'] } } },
    rules: [rule('configured', 'allow', { when: condition('type_may', [true]) })] });
  assert.deepEqual(await f.owner.mayIn(f.space, 'person', ['put_on_events']), { put_on_events: true });
  f.setRules([rule('configured', 'allow', { when: condition('type_may', [true]) }), rule('no', 'deny')]);
  assert.deepEqual(await f.owner.mayIn(f.space, 'person', ['put_on_events']), { put_on_events: false });
});

test('named member types include own inherited parents and require membership now', async () => {
  const f = fixture({ role: 'editor', own: [{ id: 'editor', label: 'Editor', inherits: ['member'] }],
    rules: [rule('members', 'allow', { who: forType('member') })] });
  assert.equal((await f.owner.decideInSpace(f.space, 'person', 'put_on_events')).allowed, true);
  f.people.get('person').state = 'left';
  assert.equal((await f.owner.decideInSpace(f.space, 'person', 'put_on_events')).allowed, false);
});

test('inheritance keeps parent-first order and refuses cycles, missing parents and malformed graphs', async () => {
  assert.deepEqual(inheritedMemberTypes([{ id: 'member' }, { id: 'host', inherits: ['member'] },
    { id: 'lead', inherits: ['host', 'member'] }], 'lead'), ['member', 'host', 'lead']);
  assert.throws(() => inheritedMemberTypes([{ id: 'a', inherits: ['b'] }, { id: 'b', inherits: ['a'] }], 'a'), /cycle/);
  assert.throws(() => inheritedMemberTypes([{ id: 'a', inherits: ['other'] }], 'a'), /not in this space/);
  const f = fixture({ role: 'a', own: [{ id: 'a', inherits: ['b'] }, { id: 'b', inherits: ['a'] }] });
  await assert.rejects(f.owner.mayIn(f.space, 'person', ['put_on_events']), /cycle/);
});

test('unreadable, unfinished and unknown stored policy never report a completed grant or denial', async () => {
  for (const rules of ['{broken', [rule('allow'), rule('unfinished', 'deny', { when: condition('not_a_fact', [true]) })],
    [null], [rule('unknown-effect', 'not-an-effect')], [rule('unknown-action', 'allow', { actions: ['not_an_action'] })],
    [rule('bad-group', 'allow', { when: { kind: 'group', combinator: 'not_a_combinator', rules: [] } })]]) {
    const f = fixture({ rules });
    await assert.rejects(f.owner.allowedInSpace('space', 'person', 'put_on_events'), error => error.code === 'SPACE_PERMISSION_UNKNOWN');
    await assert.rejects(f.owner.mayIn(f.space, 'person', ['put_on_events']), error => error.code === 'SPACE_PERMISSION_UNKNOWN');
  }
});

test('a record read failure stays unavailable and never seeds defaults', async () => {
  const f = fixture({ rules: null });
  f.records.rules = async () => { throw new Error('Policy store unavailable'); };
  f.records.ensureRules = async () => assert.fail('Unknown is not absent');
  await assert.rejects(f.owner.allowedInSpace('space', 'person', 'put_on_events'), /Policy store unavailable/);
});

test('stored rules survive reads byte for byte and defaults seed only confirmed absence', async () => {
  const text = JSON.stringify([rule('kept', 'deny')], null, 2);
  const f = fixture({ rules: text });
  await f.owner.decideInSpace(f.space, 'person', 'put_on_events');
  assert.equal(f.stored.rules, text);
  assert.equal(f.stored.changed_at, 'kept');
  const fresh = fixture({ rules: null, label: 'project' });
  await fresh.owner.decideInSpace(fresh.space, 'person', 'put_on_events');
  assert.equal(typeof fresh.stored.rules, 'string');
  assert.ok(JSON.parse(fresh.stored.rules).length > 0);
});

test('owner privacy refuses before any rule read, even when a space allows everyone', async () => {
  const f = fixture({ rules: [rule('anyone')] });
  const before = f.reads;
  const answer = await f.owner.decideInSpace(f.space, 'person', 'put_on_events', { shared_here: false });
  assert.equal(answer.allowed, false);
  assert.equal(f.reads, before);
});

test('expired rules stop granting and link and invitation facts are evaluated by actual rules', async () => {
  const f = fixture({ rules: [rule('expired', 'allow', { until: '2000-01-01T00:00:00Z' })] });
  assert.equal((await f.owner.decideInSpace(f.space, 'person', 'put_on_events')).allowed, false);
  f.setRules([rule('link', 'allow', { who: { kind: 'anyone_with_link' } })]);
  assert.equal((await f.owner.decideInSpace(f.space, 'person', 'put_on_events', { link: true })).allowed, true);
  assert.equal((await f.owner.decideInSpace(f.space, 'person', 'put_on_events', {})).allowed, false);
  f.setConfig({ join: [{ invited: true }] });
  f.setRules([rule('invited', 'allow', { when: condition('takes_invitations', [true]) })]);
  assert.equal((await f.owner.decideInSpace(f.space, 'person', 'put_on_events')).allowed, true);
});

test('rule validation gives indexed errors instead of throwing for unfinished inputs', () => {
  for (const rules of [[null], [rule('bad', 'allow', { when: { kind: 'group', combinator: 'unknown', rules: [] } })],
    [rule('bad', 'allow', { when: condition('unknown', [true]) })]]) {
    const problems = ruleProblems(rules);
    assert.ok(problems.length > 0);
    assert.equal(problems[0].index, 0);
  }
});

test('caller identity cannot replace admitted principal and revoked native context cannot grant', async () => {
  const f = fixture();
  await assert.rejects(f.owner.allowedInSpace('space', 'owner', 'put_on_events'), /principal|person|actor/i);
  f.revoke();
  await assert.rejects(f.owner.allowedInSpace('space', 'person', 'put_on_events'), /current|admi|permission/i);
});

test('a policy change during evaluation is retried against fresh state', async () => {
  const f = fixture();
  let changed = false;
  const read = f.records.accessState;
  f.records.accessState = async (...args) => {
    const state = await read(...args);
    if (!changed) { changed = true; f.setRules([rule('new-denial', 'deny')]); }
    return state;
  };
  await assert.rejects(f.owner.allowedInSpace('space', 'person', 'put_on_events'));
});

test('late own types remain in the permission snapshot and inheritance edits cannot keep stale access', async () => {
  const own = Array.from({ length: 25 }, (_unused, at) => ({ id: `legacy-${at}`, label: `Legacy ${at}`, inherits: [] }));
  own.push({ id: 'host', label: 'Host', inherits: ['member'] });
  const f = fixture({ role: 'host', own, rules: [rule('members', 'allow', { who: forType('member') })] });
  const read = f.records.accessState;
  let calls = 0;
  f.records.accessState = async (...args) => {
    const state = await read(...args);
    calls += 1;
    if (calls === 1) f.setGraph(own.map(type => type.id === 'host' ? { ...type, inherits: [] } : type));
    return state;
  };
  await assert.rejects(f.owner.allowedInSpace('space', 'person', 'put_on_events'));
  assert.ok(calls >= 4, 'retry must reread the complete current graph');
});

test('rule reads expose actual stored rules and the same evaluator decides editing rights', async () => {
  const rules = [rule('read', 'allow', { actions: ['read_rules', 'put_on_events'], who: { kind: 'any_member' } }),
    rule('no-edit', 'deny', { actions: ['change_rules', 'set_member_type'] })];
  const f = fixture({ rules });
  const read = await f.owner.readSpaceRules({ relay: 'person', space_id: 'space' });
  assert.equal(read.space_id, 'space');
  assert.equal(read.changed_at, 'kept');
  assert.equal(read.may_change, false);
  assert.equal(read.may_set_member_type, false);
  assert.deepEqual(read.rules.map(row => row.id), ['read', 'no-edit']);
  assert.ok(read.rules.every(row => Array.isArray(row.covers)));
  assert.ok(read.facts.some(row => row.id === 'member_types'));
});
